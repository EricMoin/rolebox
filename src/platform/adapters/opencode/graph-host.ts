/**
 * opencode family — the OUTCOME run path's host capability layer.
 *
 * ONE MODULE, TWO ENTRIES. {@link opencodeGraphSessionPort} adapts the session
 * abstraction BOTH opencode adapters implement (`ISessionClient`,
 * src/platform/ports/session-client.ts:19-113) to the small surface the
 * declared-graph run path needs, and {@link OpencodeGraphHost} assembles that
 * surface with a REAL `GraphApplication` / `OutcomeHost` — the same assembly
 * `src/entries/dsh.ts:1292` and `src/entries/pi.ts:915` use — and hands back the
 * bound canonical tool face. The v1 entry (1.x `@opencode-ai/plugin`) and the v2
 * entry (2.x `@opencode/plugin` promise client, `ctx.session`) differ only in
 * which `ISessionClient` they pass and whether the platform has a session
 * `wait`: that difference is a VALUE in {@link OpencodeGraphHostOptions}, never a
 * second code path.
 *
 * THE DELIVERY SEAM IS SYNCHRONOUS (src/graph/host/dispatch-host.ts:51-75).
 * `deliver` therefore fires {@link OpencodeGraphHost}.'s asynchronous `start`
 * and returns; every asynchronous outcome — a create that resolves to `null`, a
 * rejected create, a prompt that throws — is reported through
 * `OutcomeHost.reportDeliveryFailure` and settles nothing. A rejected create
 * promise is NOT proof that no session was created, so the delivery never throws
 * for it: the create right is kept, exactly as Pi keeps it (the one synchronous
 * throw is reserved for "not handed to the platform", which cannot be proven
 * here).
 *
 * THE EXECUTION READING IS REAL ON BOTH PLATFORMS, FROM WHATEVER THE PLATFORM
 * ACTUALLY EXPOSES. `observeExecution` reads ONE ordered chain (see
 * {@link OpencodeGraphHost.observe}): an end this host recorded, the FRESH
 * `session.status` event state the entry feeds through
 * {@link OpencodeGraphHost.noteSessionStatus}, and the platform's own pull read
 * of the session — which on v2 carries the session's terminal `outcome` and on
 * v1 carries the activity state. The reading is TOTAL and SYNCHRONOUS: it never
 * throws, never invents, and answers `unknown` with the exact read that is
 * missing or failed. `platformNotes` names the sources this host actually has.
 *
 * WHAT THIS HOST DELIBERATELY DOES NOT INSTALL.
 *
 *  - NO `query` (P2 item 5). The host's own durable execution index answers
 *    "does an execution already exist for this stable effect id"; an opencode
 *    session listing proves nothing about the graph effect that requested it,
 *    and rounding "I cannot see it" into `absent` would release a create right
 *    on a guess.
 *  - NO `derivedOutcomeOf` (DEFECT 2). This host installs no last-turn reader,
 *    so the run path answers `unavailable` (its own honest answer for a missing
 *    reader) instead of inventing a reading out of the session's messages. A
 *    reading is a settlement input; a fabricated one is worse than none.
 *  - NO BOOT RECOVERY. dsh and Pi call `recoverDeclaredGraphs()` /
 *    `retainAwaitingCompletions()` on boot; this host does NOT. An opencode
 *    plugin loads for EVERY CLI invocation of a shared configuration, so an
 *    automatic re-dispatch would fire from unrelated commands. A stranded run
 *    stays visible in `graph_status` and is re-armed deliberately with
 *    `graph_control {command:"retry"}`.
 *
 * THE RUN-NOTIFICATION CHANNEL IS INSTALLED WHEN THE ENTRY SUPPLIES A WAKE-UP
 * CHANNEL ({@link OpencodeGraphHostOptions.notifyClient}), AND IT IS THE SHIPPED
 * SENDER (src/platform/graph-notifications.ts:4-17) — never a second
 * implementation. A main agent that DECLARED a graph is the session a terminal
 * or attention state must WAKE: with no push it can only learn that its run
 * finished by polling `graph_status`. The channel therefore prompts the
 * DECLARING session — the graph's recorded invocation origin, which
 * `graph_declare` writes from the declaring tool call's own session
 * (src/graph/application/graph-notifications.ts:184) — with the same
 * `<system-reminder>[GRAPH COMPLETE] / [GRAPH BLOCKED]` payload dsh
 * (src/entries/dsh.ts:1293) and Pi (src/entries/pi.ts:916) send, and with
 * `noReply: false` so the prompt RESUMES the declaring agent's loop instead of
 * delivering text it never reads. A host with no wake-up channel installs NO
 * channel and still works: it reports that in `platformNotes` rather than
 * dropping notifications silently, and a send the platform rejects stays a
 * PENDING effect that is retried — never a turn, host or plugin failure.
 *
 * THE DECLARED-GRAPH TOOL FACE IS THE ONLY FACE THIS HOST ADDS, AND A DISPATCHED
 * WORKER'S GRAPH FACE IS EXACTLY `graph_submit_outcome`. `OutcomeHost.bindTools`
 * installs `WORKER_GRANTED_GRAPH_TOOLS` (src/graph/host/tool-binding.ts:25,35,
 * :80-124), so `graph_declare`, `graph_status`, `graph_audit` and `graph_control`
 * are refused for the session the host bound as an attempt's worker while
 * `graph_submit_outcome` still settles that worker's own attempt. Unlike dsh,
 * opencode has no per-sub-agent tool registry to narrow: every canonical tool is
 * registered globally, so a dispatched worker keeps the canonical face it
 * already has (hashline_read / hashline_edit / web_* / interactive_terminal) and
 * its GRAPH face is the boundary `bindTools` enforces. Nothing here invents a
 * second, path-shaped tool filter.
 *
 * THE STORE ROOT IS THE HOST'S OWN (src/graph/store/schema.ts:58-60): the entry
 * passes `graphStoreRoot(getDataDir(), workspaceDir)`, deliberately OUTSIDE the
 * workspace, because a dispatched worker runs with the workspace as its root.
 */

import { GraphApplication } from "../../../graph/application/graph-application.ts";
import {
  buildAttemptDeliveryPrompt,
  type DeliveredInputView,
  type HostDispatchDelivery,
  type HostExecutionIdentity,
  type OutcomeHost,
} from "../../../graph/host/index.ts";
import type {
  HostCompletionWatchPort,
  HostExecutionObservation,
  HostExecutionObservationPort,
  OutcomeHostAwaitingCompletion,
} from "../../../graph/host/outcome-host.ts";
import type {
  OutcomeExecutionCancelAnswer,
  OutcomeExecutionCancelProbe,
  OutcomeExecutionCancellation,
} from "../../../graph/outcome/cancel.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../../graph/outcome/dispatch-effects.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";
import { createGraphNotificationSender } from "../../graph-notifications.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { CanonicalToolDef } from "../../types.ts";

// ── The session surface ─────────────────────────────────────────────────────

/**
 * The platform session operations the declared-graph run path needs.
 *
 * DELIBERATELY SMALLER THAN `ISessionClient`: the run path starts one session
 * per attempt, hands it one prompt, and observes when its turn ends. Everything
 * else a host adapter can do (messages, diffs, todos, forks, compaction) is not
 * a graph capability, and exposing it here would invite a second, richer
 * dispatch path.
 */
export interface OpencodeGraphSessionReading {
  /** The platform's activity state, or null when it names none. */
  readonly state: "idle" | "busy" | "retry" | null;
  /** The session's own terminal outcome, when the platform records one. */
  readonly outcome?: "succeeded" | "failed" | "interrupted";
}

export interface OpencodeGraphSessionPort {
  /** Start one session for a worker. `null` means the platform created none. */
  create(input: { directory: string; agent?: string }): Promise<{ id: string } | null>;
  /** true = the prompt was handed to the session. */
  prompt(input: { sessionID: string; text: string; agent?: string }): Promise<boolean>;
  /** Resolves when the session's current turn finishes. Absent on a host with no such call. */
  wait?(input: { sessionID: string }): Promise<void>;
  /**
   * ONE reading of the session, when the platform has a read at all.
   *
   * The state names the session's ACTIVITY (`idle` / `busy` / `retry`) and the
   * outcome names how a FINISHED session went — the two are different facts, and
   * only the platform's own values are ever reported. `null` means the platform
   * named no reading (an unknown session, or a degraded status surface), which
   * the host reports as `unknown` rather than rounding into an end.
   *
   * TWO SOURCES FEED THIS, and neither is a substitute for the other: the typed
   * `session.status` EVENT the entry feeds to
   * {@link OpencodeGraphHost.noteSessionStatus} is the FRESH source for `state`,
   * and this pull read is what carries `outcome`. The session's
   * `time.idle` timestamp is deliberately NOT a state source on any platform:
   * "this session is idle now" would be an inference from a field name, while
   * the typed event and the outcome enum are the platform's own words.
   */
  status?(input: { sessionID: string }): Promise<OpencodeGraphSessionReading | null>;
  /** Stops the session's running turn; the boolean is the platform's own report. */
  interrupt?(input: { sessionID: string }): Promise<boolean>;
}

/**
 * The state one `session.status` payload names, or `undefined` for anything the
 * observation port does not distinguish.
 *
 * THE ONE READER BOTH ENTRIES SHARE (v1 wraps its installed `event` handler, v2
 * observes the relay), so the two platforms' payloads are narrowed in exactly
 * one place instead of twice. Only `idle` / `busy` / `retry` are acted on; every
 * other value — a status object of another shape, a state a future version adds,
 * a null — answers `undefined` and changes nothing. The read is defensive on
 * purpose: a payload that is not the documented shape must never throw into a
 * handler or the event relay.
 */
export function opencodeSessionStatusState(
  value: unknown,
): "idle" | "busy" | "retry" | undefined {
  const raw = typeof value === "object" && value !== null
    ? (value as { type?: unknown }).type
    : value;
  return raw === "idle" || raw === "busy" || raw === "retry" ? raw : undefined;
}

/**
 * Adapt one `ISessionClient` (the v1 `OpencodeSessionAdapter` or the v2
 * `Opencode2SessionAdapter`) to {@link OpencodeGraphSessionPort}.
 *
 * `extras.wait` is installed ONLY when the caller supplies one: a synthesized
 * wait would be a fabricated end signal, and the v1 port has no such call at
 * all. `extras.interrupt` overrides the port's own `abort` — the v2 entry does
 * not need that (its `abort` IS the platform interrupt), so the override exists
 * for a host whose interrupt is a different call than its abort.
 *
 * The reads stay as thin as the port: a throwing `status`/`interrupt` is the
 * caller's to contain ({@link OpencodeGraphHost} answers `unknown`/`unsupported`
 * with the thrown text and never a settlement).
 */
export function opencodeGraphSessionPort(
  client: ISessionClient,
  extras?: {
    wait?: (input: { sessionID: string }) => Promise<void>;
    interrupt?: (input: { sessionID: string }) => Promise<boolean>;
    /**
     * The platform's OWN pull read, for a platform whose `ISessionClient` cannot
     * express it. v2 is exactly that case: its `ctx.session.get` carries the
     * session's terminal `outcome`, while the canonical `SessionInfo` the
     * adapter projects it onto has no outcome slot at all — so the entry, which
     * holds the real domain, builds this read over the raw call and hands it in.
     * Absent, the port reads the adapter's canonical status, which names the
     * state and no outcome.
     */
    observe?: (input: { sessionID: string }) => Promise<OpencodeGraphSessionReading | null>;
  },
): OpencodeGraphSessionPort {
  return {
    create: async (input) => {
      const created = await client.create(
        input.agent === undefined || input.agent === ""
          ? { directory: input.directory }
          : { directory: input.directory, agent: input.agent },
      );
      return created === null ? null : { id: created.id };
    },
    prompt: async (input) => {
      const accepted = await client.prompt(
        input.sessionID,
        input.agent === undefined || input.agent === ""
          ? { parts: [{ type: "text", text: input.text }] }
          : { parts: [{ type: "text", text: input.text }], agent: input.agent },
      );
      return accepted !== null;
    },
    // ONE reading, from the richest source this port has. `extras.observe` wins
    // when it is installed, because it is the platform's own read of the SAME
    // session with more in it. Otherwise the canonical `SessionStatus`
    // (src/session/types.ts:141-150) supplies the state and nothing supplies an
    // outcome — that is v1's whole reading, and the host's platformNotes say so
    // rather than implying an outcome read exists.
    status: extras?.observe ?? (async (input) => {
      const reading = await client.status(input.sessionID);
      return reading === null ? null : { state: reading.type };
    }),
    interrupt: async (input) =>
      extras?.interrupt === undefined
        ? client.abort(input.sessionID)
        : extras.interrupt(input),
    // NEVER SYNTHESIZED: absent unless the caller named a real platform call.
    ...(extras?.wait === undefined ? {} : { wait: extras.wait }),
  };
}

// ── The host ────────────────────────────────────────────────────────────────

/** Inputs to {@link OpencodeGraphHost.open}. */
export interface OpencodeGraphHostOptions {
  /** The workspace whose artifacts an attempt produces and whose agent it runs as. */
  readonly workspaceDir: string;
  /** The HOST-owned root the vault, the execution index and the ledger live under. */
  readonly storeRoot: string;
  /** The platform session surface this host starts and watches workers through. */
  readonly session: OpencodeGraphSessionPort;
  /**
   * Whether the port's own read names the platform's TERMINAL OUTCOME as well as
   * its activity state. v2's `ctx.session.get` does; v1's canonical
   * `SessionStatus` (src/session/types.ts:141-150) does not.
   *
   * This is what `platformNotes` reports and what tells the end path whether a
   * terminal-outcome read is worth asking for once a session has ended. It is
   * never a substitute for the reading itself: with no such read installed the
   * host answers `unknown` and says which read is missing.
   */
  readonly sessionOutcomeRead?: boolean;
  /** The declaring session's wake-up channel. Absent → no run notifications, reported in platformNotes. */
  readonly notifyClient?: Pick<ISessionClient, "prompt">;
  /** The authorization surface the capability set reads. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The entry feeds this host every session-end event it receives (session.idle / session.error). */
  readonly sessionEndFeed?: boolean;
  /** Resolves the acting agent for a session, as the entries' own resolver does. */
  readonly getEffectiveAgent?: (sessionID?: string) => string;
}

/** One session end this host recorded, and the platform's own reason for it. */
interface RecordedSessionEnd {
  readonly kind: "ended" | "errored";
  readonly reason: string;
}

/** The attempt one prompted session was handed, and the node it belongs to. */
interface OpenAttemptBinding {
  readonly graphId: string;
  /** The NODE: a failed execution is reported through it (failObservedExecution takes graph/node/attempt). */
  readonly nodeId: string;
  readonly attemptId: string;
}

/**
 * The opencode family's OUTCOME host capability layer.
 *
 * It owns one {@link GraphApplication} (capabilities + `OutcomeHost` + toolset)
 * and the platform ports the run path asks about an execution:
 * {@link OpencodeGraphHost.observeExecution},
 * {@link OpencodeGraphHost.watchCompletion} and
 * {@link OpencodeGraphHost.cancelExecution}. The declared graphs themselves, the
 * credential vault, the acceptance ledger and the completion bridge are the
 * shared host layer's — nothing about them is re-implemented here.
 */
export class OpencodeGraphHost {
  /** The assembly the tool face, the run path and the capabilities belong to. */
  readonly application: GraphApplication;
  /** The run path itself. */
  readonly host: OutcomeHost;
  /**
   * THE PLATFORM EXECUTION OBSERVATION PORT (P2 item 6 / F3).
   *
   * Exposed because the host layer is asked through it (and because every other
   * platform adapter's observation port is a readable member a platform test
   * drives directly).
   */
  readonly observeExecution: HostExecutionObservationPort;
  /** THE PLATFORM CANCEL PORT (P3 cancel). */
  readonly cancelExecution: OutcomeExecutionCancellation;
  /** One line per capability this host installed or had to degrade. */
  readonly platformNotes: readonly string[];

  private readonly options: OpencodeGraphHostOptions;
  private readonly session: OpencodeGraphSessionPort;
  private readonly log = createSubLogger("opencode-graph-host");
  /** Sessions this host PROMPTED, mapped to the attempt each was handed. */
  private readonly inFlight = new Map<string, OpenAttemptBinding>();
  /** Ends the platform reported, keyed by the platform's session id. */
  private readonly ended = new Map<string, RecordedSessionEnd>();
  /** Sessions whose completion was already triggered — at most once per session. */
  private readonly settled = new Set<string>();
  /** Sessions with an armed end wait, and the callbacks that wait carries. */
  private readonly watches = new Map<string, Set<() => void>>();
  /** The last session reading (null = the platform named no reading at all). */
  private readonly statusReadings = new Map<string, OpencodeGraphSessionReading | null>();
  /** Session reads currently in flight, so a burst of questions issues ONE read. */
  private readonly statusReads = new Set<string>();
  /** Why the last session read failed, keyed by session id. */
  private readonly statusFailures = new Map<string, string>();
  /**
   * THE FRESH SOURCE FOR `state`: the last `session.status` event the entry
   * reported for a session. It is newer than any pull reading that landed
   * earlier, and it is the ONLY state source on a platform whose read names
   * none — v2's session read carries the terminal outcome and no activity
   * state, so its `busy` / `retry` / `idle` arrive here.
   */
  private readonly statusEvents = new Map<string, "idle" | "busy" | "retry">();
  private closed = false;

  /**
   * THE SYNCHRONOUS DELIVERY SEAM. It hands the request to the asynchronous
   * start and returns: a delivery that may have handed the request over must
   * never throw for a failure that follows (dispatch-host.ts:57-70), and every
   * in-flight failure is reported through `reportDeliveryFailure`.
   */
  private readonly deliver: HostDispatchDelivery = (
    request,
    effect,
    _invocation,
    inputView,
  ) => {
    void this.start(request, effect, inputView);
  };

  /**
   * THE PLATFORM COMPLETION WATCH PORT (F4).
   *
   * `onEnded` carries no outcome — it only says "look again", and the host
   * re-reads through {@link OpencodeGraphHost.observeExecution}, which settles
   * only `completed`. An execution this host cannot keep observing answers
   * `unsupported` and the host REPORTS it instead of pretending it is covered.
   */
  readonly watchCompletion: HostCompletionWatchPort = (
    entry: OutcomeHostAwaitingCompletion,
    onEnded: () => void,
  ): "watching" | "unsupported" => {
    if (this.closed) return "unsupported";
    if (this.ended.has(entry.executionId)) {
      // The end is already established: the caller's callback is delivered on a
      // microtask so a synchronous caller cannot re-enter this host's own
      // settlement path, and the answer is still "watching" (there IS something
      // to look at).
      queueMicrotask(() => {
        if (this.closed) return;
        onEnded();
      });
      return "watching";
    }
    if (this.armWatch(entry.executionId, onEnded)) return "watching";
    if (this.options.sessionEndFeed === true) return "watching";
    return "unsupported";
  };

  private constructor(options: OpencodeGraphHostOptions) {
    this.options = options;
    this.session = options.session;
    this.platformNotes = Object.freeze(
      buildPlatformNotes(
        options.session,
        options.sessionEndFeed === true,
        options.notifyClient !== undefined,
        options.sessionOutcomeRead === true,
      ),
    );
    this.observeExecution = (execution) => this.observe(execution);
    this.cancelExecution = Object.freeze({
      cancel: (probe: OutcomeExecutionCancelProbe): Promise<OutcomeExecutionCancelAnswer> =>
        this.cancel(probe),
    });
    this.application = GraphApplication.open({
      workspaceDir: options.workspaceDir,
      storeRoot: options.storeRoot,
      env: options.env ?? process.env,
      deliver: this.deliver,
      // D9 IS NOT DECLARED, for the reason dsh and Pi give
      // (src/entries/pi.ts:860-875): a dispatched worker is a SEPARATE session,
      // so its submission arrives from its own session and the declaring
      // invocation cannot authenticate it. `workerSessionOf` substantiates the
      // worker binding instead: the child session this host created and
      // confirmed for the attempt is the subject the worker's own tool call
      // arrives from.
      declareInvocationIdentity: false,
      workerSessionOf: (execution) => execution.executionId,
      observeExecution: this.observeExecution,
      watchCompletion: this.watchCompletion,
      cancelExecution: this.cancelExecution,
      // THE RUN-NOTIFICATION CHANNEL IS INSTALLED IFF THE ENTRY SUPPLIED A
      // WAKE-UP CHANNEL (`notifyClient`), over the SHIPPED sender: the declaring
      // session is woken with the `<system-reminder>[GRAPH COMPLETE] / [GRAPH
      // BLOCKED]` payload at a terminal or attention state instead of polling
      // `graph_status`. A host without one installs nothing and REPORTS that in
      // `platformNotes` (see the module comment).
      ...(options.notifyClient === undefined
        ? {}
        : { notifications: { send: createGraphNotificationSender(options.notifyClient) } }),
      // NEITHER `query` NOR `derivedOutcomeOf` IS INSTALLED — see the module
      // comment for why each absence is deliberate.
    });
    this.host = this.application.host;
  }

  /** Open one capability layer over a workspace and a host-owned store root. */
  static open(options: OpencodeGraphHostOptions): OpencodeGraphHost {
    return new OpencodeGraphHost(options);
  }

  /** The bound, cancel-delivery-wrapped canonical tool face of this host. */
  createTools(): Record<string, CanonicalToolDef> {
    return this.application.createTools(this.options.getEffectiveAgent);
  }

  /**
   * The platform reported one session's turn ended (`"errored"` for a session
   * error). Never throws.
   *
   * THE END IS RECORDED WHETHER OR NOT THIS HOST DISPATCHED THE SESSION, and a
   * session it created but never prompted settles nothing (there is no attempt
   * behind it). A session this host DID prompt settles AT MOST ONCE, through the
   * one completion bridge the delivery path feeds: `OutcomeHost.complete` runs
   * the plan's own acceptance core, so an end that is not a completion (a worker
   * that answered in prose, an errored session) settles nothing and is reported
   * as unsettled rather than fabricated into an outcome.
   */
  noteSessionEnded(sessionID: string, kind: "ended" | "errored" = "ended"): void {
    if (this.closed) return;
    if (!this.ended.has(sessionID)) {
      this.ended.set(
        sessionID,
        Object.freeze({
          kind,
          reason:
            kind === "errored"
              ? "the platform reported session " +
                JSON.stringify(sessionID) +
                " ended with an error (a session.error event): the turn is over and it did NOT reach a declared outcome"
              : "the platform reported session " +
                JSON.stringify(sessionID) +
                " ended (a session.idle event): the turn is over",
        }),
      );
    }
    this.settleEndedSession(sessionID);
  }

  /**
   * The entry reported ONE `session.status` event for a session: the platform's
   * own typed activity state (`idle` / `busy` / `retry`), which is the FRESH
   * source for the `state` half of an execution reading.
   *
   * IT SETTLES NOTHING AND IT NEVER THROWS. `busy` / `retry` say the turn is
   * still in flight; `idle` says the turn is over, which is NOT that the attempt
   * reached a declared outcome (see {@link OpencodeGraphHost.observe}). The
   * entries read the platform's payload through
   * {@link opencodeSessionStatusState}, so an odd or unrecognised value is
   * ignored instead of being recorded — and a session this host never
   * dispatched simply has a state and no attempt behind it.
   */
  noteSessionStatus(sessionID: string, state: "idle" | "busy" | "retry"): void {
    if (this.closed) return;
    this.statusEvents.set(sessionID, state);
  }

  /** Release the host and every wait/listener it armed. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listeners of this.watches.values()) listeners.clear();
    this.watches.clear();
    this.inFlight.clear();
    this.ended.clear();
    this.settled.clear();
    this.statusReads.clear();
    this.statusReadings.clear();
    this.statusFailures.clear();
    this.statusEvents.clear();
    this.application.close();
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * Start one attempt: create the worker session, confirm the execution the
   * platform named, hand over the prompt, then arm the end signal.
   *
   * EVERY FAILURE HERE IS ASYNCHRONOUS AND PROVES NOTHING ABOUT CREATION, so it
   * is reported and the attempt is left in flight: `reportDeliveryFailure` keeps
   * the create right (the row stays `creating` and later lookups answer
   * `unknown`), and nothing is settled, invented or re-created.
   */
  private async start(
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    inputView?: DeliveredInputView,
  ): Promise<void> {
    // 1. The ONE channel the credential travels over (delivery.ts:14-43).
    const text = buildAttemptDeliveryPrompt(request, inputView);
    // 2-3. Create the session and confirm it, in that order: the confirm is what
    // turns the registry row from `creating` into a host FACT.
    let session: { id: string } | null;
    try {
      session = await this.session.create(
        request.agent === undefined || request.agent === ""
          ? { directory: this.options.workspaceDir }
          : { directory: this.options.workspaceDir, agent: request.agent },
      );
    } catch (error) {
      this.failDelivery(request, effect, "session create failed", error);
      return;
    }
    if (session === null) {
      this.failDelivery(
        request,
        effect,
        "session create answered null (the platform created no session)",
        undefined,
      );
      return;
    }
    this.host.confirmExecution(effect, { executionId: session.id });
    // 4. Remember which attempt — and which NODE — this session was handed,
    // BEFORE the prompt: the platform's end may arrive while the prompt is still
    // in flight, and the end path reports a failed execution by graph/node/
    // attempt (OutcomeHost.failObservedExecution).
    this.inFlight.set(session.id, Object.freeze({
      graphId: request.graphId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
    }));
    // 5. Hand over the prompt. A throw or `false` is NOT a not-created proof:
    // the attempt stays in flight, nothing is fabricated, and no end watch is
    // armed for a prompt that was never accepted.
    let delivered: boolean;
    try {
      delivered = await this.session.prompt(
        request.agent === undefined || request.agent === ""
          ? { sessionID: session.id, text }
          : { sessionID: session.id, text, agent: request.agent },
      );
    } catch (error) {
      this.log.warn("opencode graph host: the delivery prompt threw — the attempt stays in flight", {
        graphId: request.graphId,
        attemptId: request.attemptId,
        sessionId: session.id,
        error: errorText(error),
      });
      return;
    }
    if (!delivered) {
      this.log.warn("opencode graph host: the platform did not accept the delivery prompt — the attempt stays in flight", {
        graphId: request.graphId,
        attemptId: request.attemptId,
        sessionId: session.id,
      });
      return;
    }
    // 6. Arm the end signal, then settle immediately if an end for this session
    // was recorded while the prompt was in flight (the entry's event feed may
    // have reported it in that window).
    this.armWatch(session.id);
    if (this.ended.has(session.id)) this.settleEndedSession(session.id);
  }

  /** Report one asynchronous delivery failure and record why. */
  private failDelivery(
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    summary: string,
    error: unknown,
  ): void {
    const reason =
      error === undefined ? summary : summary + " (" + errorText(error) + ")";
    this.host.reportDeliveryFailure(effect, reason);
    this.log.warn("opencode graph host: delivery failed — the create right is KEPT", {
      graphId: request.graphId,
      attemptId: request.attemptId,
      reason,
    });
  }

  // ── Observation ───────────────────────────────────────────────────────────

  /**
   * THE PLATFORM'S OWN ANSWER ABOUT ONE CONFIRMED EXECUTION (P2 item 6) — TOTAL
   * and SYNCHRONOUS, like every other platform's port.
   *
   * ONE ORDERED READING over the two sources the platform actually exposes:
   *
   *  a. the END this host recorded ({@link OpencodeGraphHost.noteSessionEnded}):
   *     an errored end is a failure, and an end the platform ALSO recorded a
   *     failing terminal outcome for is that outcome — a session the platform
   *     itself marked failed is never reported completed;
   *  b. a FRESH `session.status` event state of `busy` / `retry`, and an
   *     execution this host dispatched whose end it has not recorded and whose
   *     state no event has overridden: the turn is still in flight;
   *  c. the session's own TERMINAL OUTCOME from the pull read: `succeeded` is a
   *     completion, `failed` / `interrupted` a failure named in the platform's
   *     own word;
   *  d. an `idle` state — from the event feed or from the pull read — with no
   *     outcome: the turn is over and NOTHING read a declared outcome, so the
   *     answer is `unknown`, never `completed`;
   *  e. nothing readable at all: `unknown`, naming exactly which read is missing
   *     or failed. `unknown` keeps the attempt in flight and is REPORTED — it is
   *     never rounded into an end, and an end is never rounded into a completion.
   *
   * WHY `idle` IS NOT `completed`. An idle session says THE TURN IS OVER, not
   * that the attempt reached a DECLARED outcome. Completion is a plan fact: the
   * plan's acceptance core decides it, and a worker's `graph_submit_outcome` is
   * the submission that carries it. Reporting `completed` for an idle session
   * would settle an attempt through a channel the plan never authorized — the
   * exact fabrication §3.4 forbids.
   *
   * WHY `time.idle` IS NOT READ. The platform's `Session.Info` carries an
   * `idle?: number` timestamp, and "this session is idle now" would be an
   * inference from the field's NAME. The typed `session.status` event and the
   * `outcome` enum say the same things in the platform's own words, so no state
   * decision here is ever taken from that timestamp.
   */
  private observe(execution: HostExecutionIdentity): HostExecutionObservation {
    const executionId = execution.executionId;
    const ended = this.ended.get(executionId);
    if (ended !== undefined) return this.endedReading(executionId, ended);
    const eventState = this.statusEvents.get(executionId);
    if (eventState === "busy" || eventState === "retry") {
      return Object.freeze({ kind: "running" as const });
    }
    if (
      eventState === undefined &&
      (this.inFlight.has(executionId) || this.watches.has(executionId))
    ) {
      // THE HOST'S OWN DISPATCH FACT: it handed this session its prompt and has
      // recorded no end for it, and no status event has contradicted that.
      return Object.freeze({ kind: "running" as const });
    }
    return this.readingAnswer(executionId, eventState);
  }

  /**
   * The reading of a session whose end this host already recorded.
   *
   * AN ERRORED END IS A FAILED EXECUTION, as it always was. An `ended` end is a
   * COMPLETION only when no terminal failure was read for that session: the end
   * says the turn is over, and the platform's own `outcome` says how it went.
   */
  private endedReading(executionId: string, ended: RecordedSessionEnd): HostExecutionObservation {
    if (ended.kind === "errored") {
      return Object.freeze({ kind: "failed" as const, reason: ended.reason });
    }
    const outcome = this.statusReadings.get(executionId)?.outcome;
    if (outcome === "failed" || outcome === "interrupted") {
      return Object.freeze({
        kind: "failed" as const,
        reason: terminalOutcomeReason(executionId, outcome),
      });
    }
    return Object.freeze({ kind: "completed" as const });
  }

  /**
   * The platform's own pull read, as far as a SYNCHRONOUS port can carry it.
   *
   * The port's read is a promise (both opencode adapters read over the host's
   * own API), so this method does what a total synchronous answer CAN do: it
   * starts one read per session (a burst of questions issues one read), answers
   * from the last reading that landed, and answers `unknown` — never a guess —
   * until one has. A `succeeded` outcome is a completion; a `failed` /
   * `interrupted` outcome is a failure carrying the platform's own word for it;
   * a `busy` / `retry` state is the platform saying the execution is still in
   * flight; `idle` and a read that names nothing answer `unknown` (see
   * {@link OpencodeGraphHost.observe} for why idle is not a completion), and a
   * read that THROWS — before returning or by rejecting — answers `unknown`
   * carrying the thrown text.
   */
  private readingAnswer(
    executionId: string,
    eventState?: "idle" | "busy" | "retry",
  ): HostExecutionObservation {
    const status = this.session.status;
    if (status === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: noSessionReadReason(executionId),
      });
    }
    if (!this.statusReads.has(executionId)) {
      this.statusReads.add(executionId);
      void this.askSession(executionId).finally(() => this.statusReads.delete(executionId));
    }
    const failure = this.statusFailures.get(executionId);
    if (failure !== undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the platform's session status read failed for execution " +
          JSON.stringify(executionId) +
          " (" +
          failure +
          "), so its state cannot be established",
      });
    }
    const reading = this.statusReadings.get(executionId);
    if (reading?.outcome === "succeeded") {
      return Object.freeze({ kind: "completed" as const });
    }
    if (reading?.outcome === "failed" || reading?.outcome === "interrupted") {
      return Object.freeze({
        kind: "failed" as const,
        reason: terminalOutcomeReason(executionId, reading.outcome),
      });
    }
    if (reading?.state === "busy" || reading?.state === "retry") {
      return Object.freeze({ kind: "running" as const });
    }
    if (reading?.state === "idle" || eventState === "idle") {
      return Object.freeze({ kind: "unknown" as const, reason: idleReason(executionId) });
    }
    if (reading === null || (reading !== undefined && reading.state === null)) {
      return Object.freeze({ kind: "unknown" as const, reason: namesNoStatusReason(executionId) });
    }
    return Object.freeze({
      kind: "unknown" as const,
      reason:
        "no session status reading has landed for execution " +
        JSON.stringify(executionId) +
        " in this process yet, and this port is synchronous while the platform's read is not",
    });
  }

  /**
   * Ask the platform's own read for ONE session and settle its answer into the
   * cache. NEVER REJECTS: a read that throws before returning and a read that
   * rejects are both kept as a FAILURE, which the next question reports and
   * which settles nothing (see {@link OpencodeGraphHost.readingAnswer}).
   */
  private askSession(executionId: string): Promise<OpencodeGraphSessionReading | undefined> {
    const status = this.session.status;
    if (status === undefined) return Promise.resolve(undefined);
    let read: Promise<OpencodeGraphSessionReading | null>;
    try {
      read = status.call(this.session, { sessionID: executionId });
    } catch (error) {
      this.statusFailures.set(executionId, errorText(error));
      return Promise.resolve(undefined);
    }
    return (async () => {
      try {
        const reading = (await read) ?? null;
        this.statusReadings.set(executionId, reading);
        this.statusFailures.delete(executionId);
        return reading ?? undefined;
      } catch (error) {
        this.statusFailures.set(executionId, errorText(error));
        return undefined;
      }
    })();
  }

  // ── The end signal ────────────────────────────────────────────────────────

  /**
   * Arm the platform's own wait for one session, ONCE, and remember the
   * callback that must be told when it fires. `false` means this host has no
   * wait at all (the v2 case is the opposite: it has one and no status read), so
   * the entry's event feed is the completion channel.
   */
  private armWatch(sessionId: string, onEnded?: () => void): boolean {
    const wait = this.session.wait;
    if (wait === undefined) return false;
    const listeners = this.watches.get(sessionId);
    if (listeners !== undefined) {
      // NEVER ARM TWICE: one platform wait is already in flight for this
      // session, and a second caller's callback joins the same end signal.
      if (onEnded !== undefined) listeners.add(onEnded);
      return true;
    }
    const own = new Set<() => void>();
    if (onEnded !== undefined) own.add(onEnded);
    this.watches.set(sessionId, own);
    void (async () => {
      try {
        await wait.call(this.session, { sessionID: sessionId });
      } catch (error) {
        // A wait the platform refused proves nothing about the turn: the watch
        // is dropped (a later question may arm it again) and the execution is
        // reported unsettled rather than ended.
        this.watches.delete(sessionId);
        this.log.warn("opencode graph host: the session wait failed — the end of that session was NOT observed", {
          sessionId,
          error: errorText(error),
        });
        return;
      }
      this.noteSessionEnded(sessionId, "ended");
      if (this.closed) return;
      for (const listener of own) {
        try {
          listener();
        } catch (error) {
          // A callback is invoked from the platform's own signal: an escaping
          // throw would have no catcher on this path.
          this.log.warn("opencode graph host: a completion watch callback threw", {
            sessionId,
            error: errorText(error),
          });
        }
      }
    })();
    return true;
  }

  /**
   * Settle the attempt one PROMPTED session was handed, at most once, after the
   * platform reported its end. A session this host created but never prompted
   * has no attempt behind it and settles nothing.
   *
   * THE READING IS CONSULTED BEFORE THE SETTLEMENT, which is what makes the
   * host's own observation more than decorative: the end says the TURN is over,
   * and the reading says HOW it went. A reading of `failed` — an errored end, or
   * an end the platform ALSO recorded a failing terminal outcome for — reports
   * the attempt as a FAILED execution through the same call the Pi entry makes
   * for a failed settlement (`OutcomeHost.failObservedExecution`), which records
   * the decision on the attempt it names and claims nothing else.
   *
   * EVERY OTHER READING KEEPS THE COMPLETION PATH UNCHANGED: the end is handed
   * to `OutcomeHost.complete` and the PLAN decides — an explicit-completion node
   * refuses it, and an attempt whose worker submitted nothing stays visible and
   * unsettled rather than being invented into an outcome.
   */
  private settleEndedSession(sessionID: string): void {
    if (this.closed) return;
    if (this.settled.has(sessionID)) return;
    const binding = this.inFlight.get(sessionID);
    if (binding === undefined) return;
    this.settled.add(sessionID);
    this.inFlight.delete(sessionID);
    // THE ARMED WATCH IS KEPT: the platform's wait may still be pending, and
    // "already armed for that session" must stay true so no second wait is ever
    // armed for it. A later watch question is answered by the recorded end
    // above, which is what makes the callback fire.
    const observation = this.observe({ executionId: sessionID });
    if (observation.kind === "failed") {
      this.reportFailedAttempt(sessionID, binding, observation.reason);
      return;
    }
    // A TERMINAL-OUTCOME READ THAT HAD NOT LANDED when the end arrived: nothing
    // polls this port while a run executes, so the read that carries the
    // session's own outcome is asked for ONCE here. Whatever it answers is
    // reported the same way — and an attempt the completion path already settled
    // stands, because the control entry refuses a decision for a settled attempt
    // instead of rewriting it.
    void this.reportTerminalFailureAfterEnd(sessionID, binding);
    void this.host
      .complete(binding.graphId, binding.attemptId)
      .then((report) => {
        this.log.debug("opencode graph host: completion after a session end", {
          graphId: binding.graphId,
          attemptId: binding.attemptId,
          sessionId: sessionID,
          kind: report.kind,
        });
      })
      .catch((error: unknown) => {
        this.log.warn("opencode graph host: the completion after a session end failed", {
          graphId: binding.graphId,
          attemptId: binding.attemptId,
          sessionId: sessionID,
          error: errorText(error),
        });
      });
  }

  /**
   * Report one ended attempt as a FAILED execution — the platform said so.
   *
   * THE SAME CALL THE Pi ENTRY MAKES for a failed settlement, and the same one
   * the sweep and the completion watch already use: the decision is recorded on
   * the attempt it names (the dispatch effect is marked failed), the run keeps
   * executing, and the attempt is carried forward by a node-scoped `retry`.
   * A failure this call REFUSES is logged and changes nothing.
   */
  private reportFailedAttempt(
    sessionID: string,
    binding: OpenAttemptBinding,
    reason: string,
  ): void {
    void this.host
      .failObservedExecution(binding.graphId, binding.nodeId, binding.attemptId)
      .then((result) => {
        this.log.debug("opencode graph host: the ended session's execution was reported failed", {
          graphId: binding.graphId,
          nodeId: binding.nodeId,
          attemptId: binding.attemptId,
          sessionId: sessionID,
          decision: result?.kind,
          reason,
        });
      })
      .catch((error: unknown) => {
        this.log.warn("opencode graph host: reporting the ended session's failed execution failed", {
          graphId: binding.graphId,
          nodeId: binding.nodeId,
          attemptId: binding.attemptId,
          sessionId: sessionID,
          error: errorText(error),
        });
      });
  }

  /**
   * Report a terminal FAILURE the platform had not read yet when the end
   * arrived. A no-op unless this port's read names terminal outcomes, unless
   * nothing has been read for the session yet, and unless the read that lands
   * actually names a failing outcome.
   */
  private async reportTerminalFailureAfterEnd(
    sessionID: string,
    binding: OpenAttemptBinding,
  ): Promise<void> {
    if (this.options.sessionOutcomeRead !== true) return;
    if (this.statusReadings.get(sessionID)?.outcome !== undefined) return;
    const landed = await this.askSession(sessionID);
    const outcome = landed?.outcome;
    if (outcome !== "failed" && outcome !== "interrupted") return;
    if (this.closed) return;
    this.reportFailedAttempt(sessionID, binding, terminalOutcomeReason(sessionID, outcome));
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  /**
   * THE PLATFORM CANCEL PORT (P3 cancel) — ALWAYS INSTALLED, and it answers
   * `unsupported` whenever the platform cannot substantiate a stop.
   *
   * AN OPENCODE INTERRUPT REPORTS A TRANSITION, NOT A STATE. `session.abort`
   * (v1) / `session.interrupt` (v2) answers whether the host acknowledged the
   * interrupt, and this host holds no readable session state that would
   * substantiate "cancelled" — the status read distinguishes idle/busy/retry,
   * not "cancelled". An unsubstantiated acknowledgement therefore stays a
   * REQUEST: the execution remains visible and unsettled, and the next window
   * re-delivers the intent. Reporting `confirmed` here would claim a fact the
   * platform never stated.
   */
  private async cancel(
    probe: OutcomeExecutionCancelProbe,
  ): Promise<OutcomeExecutionCancelAnswer> {
    const executionId = probe.execution?.executionId;
    if (executionId === undefined || executionId.length === 0) {
      return Object.freeze({
        kind: "unsupported" as const,
        reason:
          "the host holds no confirmed session for attempt " +
          JSON.stringify(probe.effect.attemptId) +
          " (a create whose confirmation never arrived names no session, and an opencode session is addressable only by the id its create returned), so there is nothing to interrupt — the execution stays visible and is NOT reported as cancelled",
      });
    }
    const interrupt = this.session.interrupt;
    if (interrupt === undefined) {
      return Object.freeze({
        kind: "unsupported" as const,
        reason:
          "this opencode host installs no interrupt call, so session " +
          JSON.stringify(executionId) +
          " could not be stopped — the execution stays visible and is NOT reported as cancelled",
      });
    }
    let acknowledged: boolean;
    try {
      acknowledged = await interrupt.call(this.session, { sessionID: executionId });
    } catch (error) {
      return Object.freeze({
        kind: "unsupported" as const,
        reason:
          "the platform's interrupt threw for session " +
          JSON.stringify(executionId) +
          ", so the cancellation was NOT substantiated (" +
          errorText(error) +
          ") — the execution stays visible",
      });
    }
    if (!acknowledged) {
      return Object.freeze({
        kind: "unsupported" as const,
        reason:
          "the platform's interrupt reported that session " +
          JSON.stringify(executionId) +
          " was NOT stopped, so nothing was cancelled — the execution stays visible and is NOT reported as cancelled",
      });
    }
    return Object.freeze({
      kind: "requested" as const,
      reason:
        "the platform accepted an interrupt for session " +
        JSON.stringify(executionId) +
        ", which reports a transition and not a substantiated state — the execution stays visible and unsettled until its own end is observed",
    });
  }
}

/** Open one opencode-family host capability layer. */
export function openOpencodeGraphHost(
  options: OpencodeGraphHostOptions,
): OpencodeGraphHost {
  return OpencodeGraphHost.open(options);
}

// ── Reading reasons ─────────────────────────────────────────────────────────

/**
 * The reason for a session the platform itself recorded a failing terminal
 * outcome for. The platform's own word is quoted, and the reason never claims a
 * settlement: the failure of the EXECUTION is reported, and only the plan's own
 * acceptance decides what an attempt settles with.
 */
function terminalOutcomeReason(executionId: string, outcome: "failed" | "interrupted"): string {
  return (
    "the platform recorded session " +
    JSON.stringify(executionId) +
    "'s own terminal outcome as " +
    JSON.stringify(outcome) +
    ": the execution that session carried ended with that outcome, so it is reported as a FAILED execution — the platform's own word, never a settlement"
  );
}

/** The reason for a session whose turn is over with no declared outcome read. */
function idleReason(executionId: string): string {
  return (
    "the platform reports session " +
    JSON.stringify(executionId) +
    " idle: its turn is over, which is NOT that the attempt reached a declared outcome — only the plan's own acceptance of a submission settles it"
  );
}

/** The reason for a read that answered, and named neither a state nor an outcome. */
function namesNoStatusReason(executionId: string): string {
  return (
    "the platform's session status read names no status for execution " +
    JSON.stringify(executionId) +
    " (an unknown session, a session whose read names neither a state nor a terminal outcome, or a host whose status surface is degraded), so its state cannot be established"
  );
}

/** The reason for a host whose session port exposes no read at all. */
function noSessionReadReason(executionId: string): string {
  return (
    "this opencode host installs no session status read (the session port it was handed exposes no status call), so the state of execution " +
    JSON.stringify(executionId) +
    " cannot be established"
  );
}

// ── Platform notes ──────────────────────────────────────────────────────────

/**
 * One line per capability this host installed or had to degrade: the completion
 * channel, the observation read, the cancel port, and the run-notification
 * channel. The first three keep their wording and order.
 */
function buildPlatformNotes(
  session: OpencodeGraphSessionPort,
  sessionEndFeed: boolean,
  hasNotifications: boolean,
  sessionOutcomeRead: boolean,
): readonly string[] {
  const hasWait = session.wait !== undefined;
  const completion = hasWait && sessionEndFeed
    ? "completion channel: the platform's own session wait (armed once per dispatched session) AND the entry's session-end event feed (session.idle / session.error)"
    : hasWait
      ? "completion channel: the platform's own session wait (armed once per dispatched session); the entry reports no session-end event feed, so a host that cannot arm the wait answers unsupported rather than pretending the attempt is watched"
      : sessionEndFeed
        ? "completion channel: the entry's session-end event feed (session.idle / session.error); this port has no wait call to arm"
        : "completion channel: NONE — this host can neither arm a wait nor receive a session-end feed, so every completion watch answers unsupported and an attempt is settled only by its own submission";
  // THE REAL READS, named one by one: which source supplies the STATE, whether a
  // TERMINAL-OUTCOME read is installed at all, and what each answers. A degraded
  // host says exactly which read is missing instead of implying one exists.
  const observation = session.status === undefined
    ? "observeExecution read: none — this port exposes no session status call at all, so an execution this host holds no recorded end for answers unknown (never completed)"
    : "observeExecution read: " +
      (sessionEndFeed
        ? "state from the entry's session.status event feed (busy/retry answer running; idle answers unknown, never completed) together with the platform's own session status read"
        : "the platform's own session status read (busy/retry answer running; idle and a missing status answer unknown, never completed), with no session.status event feed from the entry") +
      (sessionOutcomeRead
        ? ", plus the session's own terminal outcome read by the platform (succeeded answers completed; failed and interrupted answer failed in the platform's own word); both are taken as the last reading a synchronous port can hold"
        : "; no terminal-outcome read is installed on this port, so a finished session is never reported completed and only the plan's own acceptance of a submission settles an attempt");
  const cancel = session.interrupt === undefined
    ? "cancel port: NOT installed — every cancel answers unsupported and the execution stays visible and unsettled"
    : "cancel port: installed (the platform's own interrupt/abort); an accepted interrupt is answered requested, never confirmed";
  const notification = hasNotifications
    ? "notification channel: installed (the declaring session is prompted with the graph's terminal or attention notice through the session wake-up channel the entry supplied, so the declaring agent is not left polling graph_status)"
    : "notification channel: not installed: this host has no session wake-up channel, so a declared graph's terminal state is only visible through graph_status";
  return [completion, observation, cancel, notification];
}
