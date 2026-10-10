import {
  observeDshExecutionEvents,
  readDshLastTurnDeclaration,
  type DshTurnDeclarationReading,
} from "./graph-observation.ts";
import type { DshSessionEventLike } from "./session.ts";
/**
 * dsh platform — the OUTCOME run path's dispatch delivery
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE PLATFORM HALF OF THE HOST DISPATCH ADAPTER (`src/graph/host/dispatch-host.ts`)
 * for the dsh entry. The outcome runtime commits a dispatch effect and then
 * calls the host's `create(request, effect)`; this module is what the dsh host
 * injects as the delivery seam, and it starts exactly one dsh subagent run per
 * attempt:
 *
 * - the run is started through `ctx.subagents.start(agent, request)` — the same
 *   seam the legacy graph dispatch used, with the same parent-resolution
 *   contract (dsh REQUIRES a live parent `Agent` and dereferences it while
 *   composing the child, so an unresolvable parent fails LOUD before the start);
 * - the invocation the run belongs to arrives WITH the delivery (the host's
 *   third argument: the graph's declaring invocation, recorded by the host and
 *   re-supplied on every window that arms a dispatch). The adapter keeps no
 *   session state of its own, so a successor armed by an out-of-band completion
 *   is composed under the same parent as the entry attempt, and a delivery
 *   whose host knows no invocation is refused by name instead of being
 *   attributed to whatever call happens to be running;
 * - the worker's prompt is the plan's own prompt plus the attempt handoff
 *   (`src/graph/host/delivery.ts`), which is the ONE channel the bearer
 *   credential travels over — and, when the attempt consumes upstream results,
 *   the INPUT VIEW the host materialized (D7): the producing node, its accepted
 *   outcome, the producing attempt, the accepted data and the paths of the real
 *   files the worker reads. The view arrives WITH the delivery, materialized by
 *   the host adapter before this seam is called, so this adapter never reads a
 *   store, a credential or a policy to build a prompt and a refused view never
 *   reaches it at all (the host raises before starting anything);
 * - the run's `result` promise is observed and translated into a completion
 *   report the host hands to the completion bridge: `completed` is a natural
 *   completion, anything else (aborted / error / max-tokens / refusal / a
 *   rejected result promise) is REPORTED as a failed attempt and settles
 *   nothing — a run that did not reach its authorized outcome has no pinned
 *   completion to fabricate.
 *
 * START FAILURES ARE ASYNCHRONOUS. `deliver` must be synchronous (the host
 * adapter's contract), so a start rejection cannot throw out of it. It is
 * reported through `onStartFailed` with the stable effect key, which lets the
 * host drop the execution-index record it took before delivery — the same
 * "the execution did not start" fact the synchronous-throw path records, so a
 * restart asks the host and gets `absent` instead of guessing.
 *
 * THE PLATFORM PORTS (P2 part 2). The delivery also carries the three platform
 * answers the host layer asks for:
 *
 * - {@link DshOutcomeDelivery.executionQuery} — the execution query (P2 item 5):
 *   the create call CARRIES the stable key
 *   (`graphId + "/dispatch:" + attemptId`) as the documented start-request
 *   `label`, and `ctx.subagents.listChildren` is asked for the child carrying
 *   it. Whether a listed child returns that label is unverified in this
 *   repository; when it does not, the correlation answers `unknown` and the
 *   effect stays blocked. The listing is asynchronous, so it is read by the
 *   port's `prime` phase before the run path's synchronous window, and a child
 *   that is not found answers `unknown` — never `absent`, because a
 *   live-preferred listing cannot prove non-existence;
 * - {@link DshOutcomeDelivery.observeExecution} — the terminal-state read (P2
 *   item 6). dsh has no durable outcome read, so this answers `unknown` with
 *   that reason and the boot sweep reports the execution as explicitly
 *   unsettled;
 * - {@link DshOutcomeDelivery.watchCompletion} — the re-subscribe half (F4),
 *   which answers `unsupported`: a run's `result` promise belongs to the
 *   process that started it, so a restarted process cannot re-establish the
 *   announcement.
 *
 * THE CANCEL PORT (P3). {@link DshOutcomeDelivery.cancelExecution} is what a
 * trusted cancel command reaches the platform through, and it is deliberately
 * conservative about what it calls CONFIRMED:
 *
 * - a run THIS process started is cancelled through the dsh surface the contract
 *   documents — `SubagentRun.dispose()`, the run's abort surface — plus the
 *   caller-owned AbortSignal the start request was composed with. The
 *   CONFIRMATION is not the call: it is the run's own `result` promise
 *   resolving with `stopReason === "aborted"`, awaited for a bounded time. A run
 *   that has not reported its end when that bound expires answers `requested`
 *   — handed over, NOT confirmed;
 * - a run this process did NOT start has no handle here. dsh's
 *   `SubagentRuntime.interrupt(targetSessionId, authority)` is the only
 *   addressable surface (contract §4.3, `:295`), and it RETURNS VOID: nothing
 *   about it substantiates the run ending. When the runtime exposes it, it is
 *   issued for the confirmed execution id (which the dsh contract makes equal to
 *   the child session id) and the answer is `requested`; when it is absent, the
 *   answer is `unsupported`. THE `authority` ARGUMENT IS NOT DEFINED BY ANY
 *   DOCUMENT IN THIS REPOSITORY and `@deepseek-ai/dsh-subagent` is not
 *   installed, so rolebox passes none and claims nothing beyond "the interrupt
 *   was issued".
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
  OutcomeExecutionProbe,
  OutcomeExecutionQuery,
} from "../../../graph/outcome/dispatch-effects.ts";
import { dispatchIdempotencyKeyOf } from "../../../graph/outcome/dispatch-effects.ts";
import type {
  OutcomeExecutionCancelAnswer,
  OutcomeExecutionCancelProbe,
  OutcomeExecutionCancellation,
} from "../../../graph/outcome/cancel.ts";
import type {
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./dispatch.ts";
import { DshParentUnresolvedError } from "./dispatch.ts";
import type { DshSubagentRun, DshSubagentStartRequest } from "./agent-registrar.ts";
import type { HostDispatchInvocation } from "../../../graph/host/dispatch-host.ts";
import type { HostExecutionIdentity } from "../../../graph/host/execution-index.ts";
import type {
  HostCompletionWatchPort,
  HostDerivedOutcome,
  HostDerivedOutcomePort,
  HostExecutionObservation,
  HostExecutionObservationPort,
} from "../../../graph/host/outcome-host.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import { declaredToolsAllow } from "../../../graph/host/tool-binding.ts";
import type { DeliveredInputView } from "../../../graph/host/input-view.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";

/**
 * One durable direct-child row as rolebox READS a dsh subagent listing row.
 * The contract extract names `SubagentRuntime.listChildren` (contract §4.3) but
 * does not define `SubagentListEntry`'s members, so this is a structural
 * reading, not a quoted contract shape.
 *
 * `label` is the key the create call CARRIED as the documented start-request
 * `label` — for an outcome dispatch it is {@link dispatchIdempotencyKeyOf},
 * which is what would make the child correlatable with its effect in a later
 * process. Whether `listChildren` returns that label is UNVERIFIED in this
 * repository (`@deepseek-ai/dsh-subagent` is not installed): if it does not,
 * {@link DshOutcomeDelivery.executionQuery} answers `unknown` and the effect
 * stays blocked. `activity` is the listing's own liveness sample and
 * `kind`/`id`/`mode` identify the row; rolebox reads none of them as an
 * outcome.
 */
export interface DshSubagentChildRow {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly activity?: string;
  readonly mode?: string;
}

/**
 * The listing half of the dsh subagent service (`SubagentRuntime.listChildren`,
 * contract §4.3). Declared here as an OPTIONAL extension rather than on the
 * shared dispatch surface because it is the query port's need alone: a runtime
 * double for the delivery path does not have to provide it, and a runtime
 * without it answers `unknown` instead of correlating.
 */
export interface DshSubagentCatalogLike {
  listChildren?(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly DshSubagentChildRow[]>;
  /**
   * Interrupt one CHILD SESSION — the addressable cancellation surface of the
   * dsh subagent runtime (contract §4.3:
   * `interrupt(targetSessionId, authority): void`).
   *
   * OPTIONAL, like the listing above, because it belongs to the cancel port's
   * needs alone. THE RETURN TYPE IS THE POINT: `void`. An interrupt says "the
   * request was issued" and nothing about the run ending, so a caller can never
   * read a confirmation out of it. The `authority` parameter is not defined by
   * any document in this repository (the contract extract names the parameter and
   * no shape for it) and the SDK is not installed, so rolebox passes none; a
   * runtime that validates it fails the call, which the port reports as
   * `unsupported` rather than as a cancellation.
   */
  interrupt?(targetSessionId: string, authority: unknown): void;
}

/** The dsh subagent surface the outcome dispatch adapter consumes. */
export type DshOutcomeSubagentRuntime = DshSubagentDispatchRuntime &
  DshSubagentCatalogLike;

/** What the platform observed about one attempt. */
export type DshOutcomeSettlement =
  | { readonly kind: "completed"; readonly request: OutcomeDispatchRequest }
  | {
    readonly kind: "failed";
    readonly request: OutcomeDispatchRequest;
    readonly reason: string;
  };

export interface DshOutcomeDeliveryOptions {
  /**
   * THE BASELINE ALLOW-LIST, used when no per-request resolver answers: the
   * worker's own delivery channel (`graph_submit_outcome` and, on dsh,
   * `graph_worker_exec`). It is deliberately STATIC and unconditional — this is
   * the surface every worker keeps, and nothing a caller passes can widen it.
   */
  readonly workerTools?: readonly string[];
  /**
   * THE ALLOW-LIST FOR ONE REQUEST, resolved by the entry that owns the host
   * tool registry: the baseline PLUS the executing node's declared host tools,
   * each intersected with the tools the host actually registered
   * ({@link resolveDshWorkerToolAllowList}).
   *
   * WHY PER REQUEST. The node's declared grant rides ON the request
   * ({@link OutcomeDispatchRequest.declaredTools}), so the allow-list is a
   * property of the attempt, not of the adapter: one delivery may start a
   * worker with `computer_*` and the next the baseline alone.
   *
   * FAIL CLOSED ON EVERY UNCERTAINTY. An answer of `undefined`, a resolver the
   * entry did not install, and a resolver that THROWS all fall back to
   * {@link DshOutcomeDeliveryOptions.workerTools} — the static baseline. A
   * missing answer is never read as a grant.
   */
  readonly workerToolsOf?: (request: OutcomeDispatchRequest) => readonly string[] | undefined;
  readonly readExecutionEvents?: (id: string) => Promise<readonly DshSessionEventLike[] | undefined>;
  readonly startWorker?: (label: string, start: () => Promise<DshSubagentRun>, request: OutcomeDispatchRequest) => Promise<DshSubagentRun>;
  readonly subscribeExecutionEvents?: (id: string, listener: (events: readonly DshSessionEventLike[]) => void) => (() => void);
  /** `ctx.subagents` — the dsh subagent runtime. */
  readonly subagents: DshOutcomeSubagentRuntime;
  /**
   * Resolve the live parent `Agent` for the graph's invoking session, exactly
   * as the legacy dsh dispatch path did (probe `ctx.agents`).
   */
  readonly parentResolver?: (sessionId: string) => unknown;
  /** Reports one attempt's terminal observation (completion or failure). */
  readonly onSettled: (settlement: DshOutcomeSettlement) => void;
  /**
   * Reports a start that failed asynchronously, with the stable effect key so
   * the host can release the claim it took before delivery.
   */
  readonly onStartFailed: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    reason: string,
  ) => void;
  /**
   * Reports the dsh subagent run the platform actually created, as soon as its
   * id is known. This is the host fact that turns the execution registry's
   * `creating` row into `created`; a host that omits it leaves the effect
   * `unknown` after a restart — reported as unsettled, never re-dispatched.
   */
  readonly onStarted?: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ) => void;
  /**
   * How long a cancellation may wait for the platform's OWN confirmation — the
   * run's `result` promise reporting `stopReason === "aborted"` — before the
   * port answers `requested` instead. Defaults to
   * {@link DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS}. The bound exists because "the
   * dispose call returned" is not "the run ended": a run that outlives the bound
   * stays VISIBLE and unsettled, and the next host window asks again.
   */
  readonly cancelConfirmTimeoutMs?: number;
  /** Optional logger name override. */
  readonly loggerName?: string;
}

/**
 * THE ALLOW-LIST ONE ATTEMPT'S START REQUEST CARRIES.
 *
 * The list becomes `toolFilter.allow`, which the harness applies as a scoped
 * `tools.restrict()` in the child's creation window: it is the child's only
 * VISIBLE and EXECUTABLE tool set, and `restrict()` THROWS on a name the host
 * does not resolve. The list therefore has to name tools that actually exist,
 * and it must never name one the node did not declare.
 *
 * THREE INPUTS, ONE FAIL-CLOSED RULE:
 *
 *   - the BASELINE — the worker's delivery channel, granted unconditionally
 *     (still filtered by `isRegistered` so an unregistered name cannot make
 *     `restrict()` throw and abort the start);
 *   - the node's DECLARED entries, matched with the ONE matcher the worker
 *     boundary itself uses ({@link declaredToolsAllow}), so the start filter and
 *     the per-call refusal cannot disagree; that matcher never admits a name in
 *     the graph face's own reserved namespace, so a declaration cannot re-open
 *     the face through this door either;
 *   - the CANDIDATE names this host composed, each verified by `isRegistered`.
 *
 * THE INTERSECTION IS THE POINT. A declared name the host did not register is
 * not granted: it could not be called, and naming it would throw inside
 * `restrict()`. An undeclared node, an absent declaration, and a declaration
 * whose every entry fails the intersection all produce the registered baseline
 * alone — exactly the surface this delivery had before the field existed.
 *
 * AN EXACT ENTRY IS ALSO PROBED BY NAME, so a HOST-owned tool this build did not
 * compose remains grantable; a prefix entry is expanded over the candidates,
 * which is the only enumeration available without asking the registry to list
 * itself.
 *
 * TOTAL AND NARROWING: the inputs are a list and a predicate, a predicate that
 * throws answers "not registered", and no input can add a name the intersection
 * did not produce.
 */
export function resolveDshWorkerToolAllowList(options: {
  readonly baseline: readonly string[];
  readonly declared?: readonly string[] | undefined;
  readonly candidates: readonly string[];
  readonly isRegistered: (name: string) => boolean;
}): readonly string[] {
  const registered = (name: string): boolean => {
    try {
      return options.isRegistered(name) === true;
    } catch {
      return false;
    }
  };
  const allow = new Set<string>();
  for (const name of options.baseline) {
    if (registered(name)) allow.add(name);
  }
  const declared = options.declared;
  if (declared === undefined || declared.length === 0) return Object.freeze([...allow]);
  for (const name of options.candidates) {
    if (allow.has(name)) continue;
    if (declaredToolsAllow(name, declared) && registered(name)) allow.add(name);
  }
  for (const entry of declared) {
    if (typeof entry !== "string" || entry.length === 0 || entry.endsWith("*")) continue;
    if (allow.has(entry)) continue;
    if (declaredToolsAllow(entry, declared) && registered(entry)) allow.add(entry);
  }
  return Object.freeze([...allow]);
}

/**
 * The default confirmation bound for a cancellation (P3): two seconds is long
 * enough for an in-process abort to settle a run and short enough that a
 * control command never appears to hang on a platform that cannot confirm.
 */
const DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS = 2_000;

/** What one dsh run's own result promise reported — the abort confirmation. */
interface DshRunObservation {
  /** The run's stop reason, when its result promise resolved. */
  readonly stopReason?: DshSubagentResult["stopReason"];
  /** Why the result promise rejected, when it did. */
  readonly failure?: string;
}

/**
 * ONE RUN THIS PROCESS STARTED, kept for the cancel port (P3).
 *
 * A dsh run is addressable only through the handle `start()` returned, so a
 * cancellation is possible exactly while this process holds that handle. The
 * observation is the SAME result promise the delivery already awaits: its
 * `stopReason` is the platform's confirmation that the run ended, and nothing
 * else in this adapter's reach says so.
 */
interface DshLiveRun {
  readonly controller: AbortController;
  readonly run: DshSubagentRun;
  readonly observed: Promise<DshRunObservation>;
}

/**
 * The dsh delivery seam. One instance per host process, and STATELESS about
 * invocations: the session a run is composed under arrives with each delivery
 * as the host's own attribution of the graph's declaring invocation.
 */
/**
 * One total last-turn reading, projected onto the HOST's own port vocabulary
 * (DEFECT 2).
 *
 * The mapping is total and LOSSLESS in both directions: a `declared` reading
 * carries the outcome id, the payload and the evidence references the WORKER
 * named — this adapter neither chooses nor completes any of them — and every
 * negative reading (`absent`, `ambiguous`, `malformed`) carries the reader's own
 * reason, so the host reports what happened instead of settling. Nothing here
 * can invent a reading: the input is the pure reader's closed answer.
 */
function derivedOutcomeOfReading(reading: DshTurnDeclarationReading): HostDerivedOutcome {
  if (reading.kind !== "declared") return Object.freeze(reading);
  const declaration = reading.declaration;
  return Object.freeze({
    kind: "declared" as const,
    outcomeId: declaration.outcomeId,
    ...(declaration.data === undefined ? {} : { data: declaration.data }),
    ...(declaration.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: declaration.evidenceRefs }),
    derivation: Object.freeze({
      eventIndex: declaration.derivation.eventIndex,
      turnIndex: declaration.derivation.turnIndex,
    }),
  });
}

/** One `unknown` execution answer, with the platform's own reason. */
function unknownAnswer(reason: string): OutcomeExecutionLookup {
  return Object.freeze({ kind: "unknown" as const, reason });
}

export class DshOutcomeDelivery {
  private readonly log;
  /**
   * The child listings this process has read, per parent session, keyed by the
   * parent the create was composed under (F3).
   *
   * The query port primes it before the run path's synchronous window; lookup
   * reads it and nothing else. A parent with no listing has not been asked (or
   * the listing failed), and its probes answer unknown rather than calling an
   * asynchronous control plane from a synchronous question.
   */
  private readonly childListings = new Map<string, readonly DshSubagentChildRow[]>();
  /**
   * THE OWN LAST-TURN READINGS THIS PROCESS HAS TAKEN (DEFECT 2), keyed by the
   * platform's own execution id.
   *
   * A reading is recorded exactly where the adapter already reads a child's
   * session events AND the terminal observation is `completed` (the execution
   * query's prime and the completion watch's `turn/end` listener): a FAILED end
   * is `failObservedExecution`'s business, and an execution whose events were
   * never read has no reading here at all — the port says so instead of
   * guessing. The map holds what the WORKER declared (an outcome id, its
   * payload, its evidence references and where they were read), never a
   * credential, and it is dropped with the adapter.
   */
  private readonly derivedOutcomes = new Map<string, HostDerivedOutcome>();
  /**
   * THE RUNS THIS PROCESS STARTED, keyed by the platform's own execution id
   * (P3 cancel). A dsh run is addressable only through the handle its `start()`
   * returned, so this map is exactly the set of executions a cancellation can
   * reach from here; a run started by a PREVIOUS process is not in it, and the
   * port says so instead of pretending otherwise. An entry is removed the moment
   * the run's result promise settles.
   */
  private closed = false;
  private readonly watchers = new Set<() => void>();
  close(): void { this.closed = true; for (const stop of this.watchers) stop(); this.watchers.clear(); this.derivedOutcomes.clear(); }
  private readonly terminalRuns = new Map<string, DshRunObservation>();
  private readonly liveRuns = new Map<string, DshLiveRun>();

  constructor(private readonly opts: DshOutcomeDeliveryOptions) {
    this.log = createSubLogger(opts.loggerName ?? "dsh-outcome-dispatch");
  }

  /**
   * THE PLATFORM EXECUTION QUERY PORT (P2 item 5 / F3).
   *
   * `prime` reads the child listing of every parent the probes name — the
   * graphs' recorded declaring invocations — once per call, so the answers are
   * ready before the run path asks. `lookup` then correlates a probe with a
   * child by the DURABLE LABEL the create carried
   * ({@link dispatchIdempotencyKeyOf}), which is the one string both sides
   * derive from the stable effect identity.
   *
   * WHAT IT ANSWERS, AND WHAT IT REFUSES TO. A child carrying that label IS the
   * execution: `created`, naming the child session id, which the dsh contract
   * makes equal to the subagent run id the delivery would have confirmed. Two
   * children with the label are AMBIGUOUS, and no child means `unknown` — never
   * `absent`. dsh's listing is live-preferred (without session persistence a
   * child that finished while no process was listening is not listed), so a
   * missing child cannot prove the execution never existed, and only a proof may
   * release a create right.
   */
  readonly executionQuery: OutcomeExecutionQuery = Object.freeze({
    lookup: (probe: OutcomeExecutionProbe): OutcomeExecutionLookup => {
      const listing = this.opts.subagents.listChildren;
      if (listing === undefined) {
        return unknownAnswer(
          "this dsh build exposes no ctx.subagents.listChildren, so a subagent run cannot " +
          "be correlated with the dispatch effect that created it",
        );
      }
      const parentSessionId = probe.invocation?.sessionId;
      if (parentSessionId === undefined || parentSessionId.length === 0) {
        return unknownAnswer(
          "the graph's declaring invocation is not recorded (or names no session), so there " +
          "is no parent whose children could be listed for effect " +
          JSON.stringify(probe.effect.effectId),
        );
      }
      const children = this.childListings.get(parentSessionId);
      if (children === undefined) {
        return unknownAnswer(
          "no child listing has been read for the declaring invocation in this process — the " +
          "platform query port is primed by the host's own recovery window before the run " +
          "path asks, and an unprimed question is never answered on a guess",
        );
      }
      const label = dispatchIdempotencyKeyOf(probe.effect);
      const matches = children.filter(
        (child) => child.kind === "child" && child.label === label,
      );
      if (matches.length === 1) {
        const child = matches[0];
        if (child !== undefined) {
          return Object.freeze({
            kind: "created" as const,
            execution: Object.freeze({ executionId: child.id }),
          });
        }
      }
      if (matches.length > 1) {
        return unknownAnswer(
          "more than one child of session " +
          JSON.stringify(parentSessionId) +
          " carries the stable label " +
          JSON.stringify(label) +
          " — an ambiguous correlation cannot say which execution belongs to effect " +
          JSON.stringify(probe.effect.effectId),
        );
      }
      return unknownAnswer(
        "no listed child of session " +
        JSON.stringify(parentSessionId) +
        " carries the stable label " +
        JSON.stringify(label) +
        " — dsh's listing is live-preferred (a child that finished while no process was " +
        "listening, or one in a profile without session persistence, is not listed), so " +
        "this is NOT a proof that no execution exists and the effect stays blocked",
      );
    },
    prime: async (probes: readonly OutcomeExecutionProbe[]): Promise<void> => {
      const listing = this.opts.subagents.listChildren;
      if (listing === undefined) return;
      const parents = new Set<string>();
      for (const probe of probes) {
        const parentSessionId = probe.invocation?.sessionId;
        if (parentSessionId !== undefined && parentSessionId.length > 0) {
          parents.add(parentSessionId);
        }
      }
      for (const parentSessionId of parents) {
        try {
          const children = await listing.call(this.opts.subagents, parentSessionId);
          this.childListings.set(parentSessionId, Object.freeze([...children]));
          if (this.opts.readExecutionEvents) {
            const labels = new Set(probes.filter(probe => probe.invocation?.sessionId === parentSessionId).map(probe => dispatchIdempotencyKeyOf(probe.effect)));
            for (const child of children) {
              if (child.kind !== "child" || !child.label || !labels.has(child.label)) continue;
              try {
                const events = await this.opts.readExecutionEvents(child.id);
                if (!events) continue;
                const observation = observeDshExecutionEvents(events, child.label);
                if (observation.kind === "completed") {
                  this.terminalRuns.set(child.id, { stopReason: "completed" });
                  // THE OWN LAST TURN IS READ FROM THE SAME EVENTS (DEFECT 2).
                  // Only a COMPLETED end authorises a declaration reading (a
                  // failed end belongs to failObservedExecution), and the
                  // reading is STORED here — never interpreted, repaired or
                  // settled in this adapter.
                  this.derivedOutcomes.set(
                    child.id,
                    derivedOutcomeOfReading(readDshLastTurnDeclaration(events, child.label)),
                  );
                }
                if (observation.kind === "failed") this.terminalRuns.set(child.id, { failure: observation.reason });
              } catch { /* An unavailable host log leaves this execution unknown. */ }
            }
          }
        } catch (error) {
          // An unreadable listing is NOT an empty one: the parent's reading is
          // dropped, so its probes answer unknown and stay blocked.
          this.childListings.delete(parentSessionId);
          this.log.warn("dsh outcome dispatch: child listing failed", {
            parentSessionId,
            error: errorText(error),
          });
        }
      }
    },
  });

  /**
   * THE PLATFORM EXECUTION OBSERVATION PORT (P2 item 6 / F3).
   *
   * IT ANSWERS `unknown`, AND THAT IS THE HONEST ANSWER. The dsh runtime's
   * public surface has no durable outcome read: `listChildren` reports a
   * child's live/inactive activity, and the dsh contract states explicitly that
   * activity neither encodes a durable outcome (a continuable child may be
   * inactive and still resumable). A run's `result` promise lives in the
   * process that started it, so after that process exits the outcome is not
   * readable from dsh at all. Rolebox therefore refuses to round "not resident"
   * into "finished": the boot sweep reports every confirmed execution it cannot
   * observe as an explicit `completion-unsettled` refusal and names it in
   * `awaitingCompletion`, which is the observable block the plan requires.
   */
  readonly observeExecution: HostExecutionObservationPort = (execution) => {
    const observed = this.terminalRuns.get(execution.executionId);
    if (observed !== undefined) {
      return observed.stopReason === "completed" ? { kind: "completed" } : {
        kind: "failed", reason: observed.failure ?? "dsh execution ended: " + observed.stopReason,
      };
    }
    if (this.liveRuns.has(execution.executionId)) return { kind: "running" };
    return { kind: "unknown", reason: "The dsh runtime has no durable outcome read for this execution" };
  };

  /**
   * THE PLATFORM'S LAST-TURN READING PORT (DEFECT 2).
   *
   * The host's second question about a finished execution: what did the
   * WORKER'S OWN LAST TURN declare? This adapter answers from the readings it
   * has actually taken ({@link DshOutcomeDelivery.derivedOutcomes}) — the same
   * events it read to observe the end, run through the pure
   * `readDshLastTurnDeclaration` reader — and it answers `unavailable` when it
   * has taken none for that execution in this process. It NEVER fabricates a
   * reading: no events, no declaration, and no default outcome id exists here.
   *
   * The answer is a reading, not a settlement: the host hands a `declared` one
   * to the runtime, which authenticates it against the host's own confirmed
   * execution and lets the PLAN decide whether that outcome exists and passes
   * its declared gates.
   */
  readonly derivedOutcomeOf: HostDerivedOutcomePort = (execution) =>
    this.derivedOutcomes.get(execution.executionId) ?? {
      kind: "unavailable",
      reason:
        "no last-turn reading has been taken for this execution in this process",
    };

  /**
   * THE PLATFORM COMPLETION WATCH PORT (F4) — unsupported on dsh.
   *
   * A dsh subagent run's terminal announcement is its `result` promise, held by
   * the process that called `start`. There is no durable subscription a
   * restarted process could re-establish — `ctx.subagents` exposes no "tell me
   * when this run ends" for a child this process did not start — so this port
   * says so, and the host REPORTS the executions it cannot keep observing
   * instead of pretending they are covered.
   */
  readonly watchCompletion: HostCompletionWatchPort = (entry, onEnded) => {
    if (!this.opts.subscribeExecutionEvents) return "unsupported";
    const label = dispatchIdempotencyKeyOf({ graphId: entry.graphId, attemptId: entry.attemptId, effectId: "dispatch:" + entry.attemptId });
    const stop = this.opts.subscribeExecutionEvents(entry.executionId, events => {
      if (this.closed) return;
      // THE WATCH PATH IS FAIL-SAFE, EXACTLY AS THE PRIME PATH IS (Totality 2).
      // An announced end whose events cannot be READ is not an end this adapter
      // may act on: the exception is contained HERE, because a subscription
      // callback is called by the platform and an escaping throw has no catcher
      // on this path. Nothing is recorded — no terminal run, no reading — so the
      // host keeps reporting the execution unsettled, and the subscription stays
      // armed so a later, readable announcement can still be observed.
      let observation: HostExecutionObservation;
      let reading: HostDerivedOutcome | undefined;
      try {
        observation = observeDshExecutionEvents(events, label);
        if (observation.kind !== "completed" && observation.kind !== "failed") return;
        // THE SAME READING, TAKEN FROM THE ANNOUNCED END'S OWN EVENTS (DEFECT 2):
        // the watch is the other point where this adapter holds the child's
        // session, and a completed end is what makes a declaration readable.
        // BOTH reads happen BEFORE any state changes, so a throw can leave no
        // half-recorded execution behind.
        reading = observation.kind === "completed"
          ? derivedOutcomeOfReading(readDshLastTurnDeclaration(events, label))
          : undefined;
      } catch (error) {
        this.log.warn("dsh outcome dispatch: announced execution events unreadable", {
          executionId: entry.executionId,
          error: errorText(error),
        });
        return;
      }
      this.terminalRuns.set(entry.executionId, observation.kind === "completed" ? { stopReason: "completed" } : { failure: observation.reason });
      if (reading !== undefined) this.derivedOutcomes.set(entry.executionId, reading);
      stop(); this.watchers.delete(stop);
      onEnded();
    });
    this.watchers.add(stop);
    return "watching";
  };

  /**
   * THE PLATFORM CANCEL PORT (P3).
   *
   * TWO PATHS, AND NEITHER OF THEM CLAIMS MORE THAN DSH SUBSTANTIATES:
   *
   * 1. THIS PROCESS STARTED THE EXECUTION. `run.dispose()` is the abort surface
   *    the contract documents, and the start request's own `AbortSignal` is the
   *    caller-owned cancellation it was composed with; both are applied. The
   *    CONFIRMATION is the run's `result` promise resolving with
   *    `stopReason === "aborted"`, awaited for
   *    {@link DshOutcomeDeliveryOptions.cancelConfirmTimeoutMs}. Confirmed only
   *    when the platform actually reported that end; otherwise `requested` —
   *    the dispose was issued and nothing substantiated the run ending.
   * 2. ANOTHER PROCESS STARTED IT. No handle exists here. dsh's addressable
   *    surface is `SubagentRuntime.interrupt(targetSessionId, authority)`,
   *    which returns `void` (contract §4.3), so it can only ever answer
   *    `requested` — and only when the runtime exposes it at all. The target is
   *    the execution id the HOST recorded, which the dsh contract makes equal to
   *    the published child session id; the `authority` argument is passed as
   *    none because no document in this repository defines its shape.
   *
   * A probe that names no execution is `unsupported`: there is nothing to
   * address. So is a runtime whose `interrupt` throws — the failure is reported
   * without quoting the run's own text.
   */
  readonly cancelExecution: OutcomeExecutionCancellation = Object.freeze({
    cancel: async (probe: OutcomeExecutionCancelProbe): Promise<OutcomeExecutionCancelAnswer> => {
      const executionId = probe.execution?.executionId;
      if (executionId === undefined || executionId.length === 0) {
        return Object.freeze({
          kind: "unsupported" as const,
          reason:
            "the host holds no confirmed dsh execution for attempt " +
            JSON.stringify(probe.effect.attemptId) +
            " (a create whose confirmation never arrived names no run, and a dsh run is " +
            "addressable only by the id its start() returned), so there is nothing to cancel — " +
            "the execution stays visible and is NOT reported as cancelled",
        });
      }
      const live = this.liveRuns.get(executionId);
      if (live !== undefined) {
        let disposed = true;
        try {
          live.controller.abort(
            "cancelled by a trusted graph control command",
          );
        } catch (error) {
          disposed = false;
          this.log.warn("dsh outcome cancel: aborting the start signal failed", {
            executionId,
            error: errorText(error),
          });
        }
        try {
          await live.run.dispose();
        } catch (error) {
          disposed = false;
          this.log.warn("dsh outcome cancel: disposing the run failed", {
            executionId,
            error: errorText(error),
          });
        }
        const aborted = await this.awaitRunAbort(live.observed);
        if (aborted) {
          return Object.freeze({
            kind: "confirmed" as const,
            reason:
              "the dsh subagent run " +
              JSON.stringify(executionId) +
              " reported stopReason 'aborted' after its run handle was disposed, which is the " +
              "platform's own confirmation that the execution ended",
          });
        }
        return Object.freeze({
          kind: "requested" as const,
          reason:
            (disposed
              ? "the dsh run handle of execution "
              : "cancelling dsh execution ") +
            JSON.stringify(executionId) +
            (disposed ? " was aborted and disposed" : " failed") +
            ", but the run's result promise has not reported its end within " +
            String(this.cancelConfirmTimeoutMs()) +
            " ms — the request was issued and dsh CONFIRMED NOTHING, so the execution stays " +
            "visible and unsettled",
        });
      }
      const interrupt = this.opts.subagents.interrupt;
      if (interrupt === undefined) {
        return Object.freeze({
          kind: "unsupported" as const,
          reason:
            "execution " +
            JSON.stringify(executionId) +
            " was not started by this process (no live run handle) and this dsh build exposes " +
            "no SubagentRuntime.interrupt, so the run cannot be addressed for cancellation — it " +
            "stays visible and is NOT reported as cancelled",
        });
      }
      try {
        // Recovered workers remain scoped to the live declaring ancestor.
        const parent = probe.invocation?.sessionId === undefined ? undefined : this.opts.parentResolver?.(probe.invocation.sessionId);
        if (!parent) return { kind: "unsupported", reason: "The owning parent agent is not available to authorize interruption" };
        interrupt.call(this.opts.subagents, executionId, { kind: "ancestor", agent: parent });
      } catch (error) {
        return Object.freeze({
          kind: "unsupported" as const,
          reason:
            "the dsh interrupt() call for child session " +
            JSON.stringify(executionId) +
            " threw, so the cancellation was NOT issued (" +
            errorText(error) +
            ") — the execution stays visible",
        });
      }
      return Object.freeze({
        kind: "requested" as const,
        reason:
          "the dsh interrupt() was issued for child session " +
          JSON.stringify(executionId) +
          " (the execution the host recorded), but SubagentRuntime.interrupt returns void and " +
          "this process holds no run handle to observe, so the platform substantiated nothing — " +
          "the execution stays visible and unsettled until a later window confirms it",
      });
    },
  });

  /** The configured confirmation bound, in milliseconds. */
  private cancelConfirmTimeoutMs(): number {
    const configured = this.opts.cancelConfirmTimeoutMs;
    return configured === undefined || configured < 0
      ? DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS
      : configured;
  }

  /**
   * Wait, for a bounded time, for the run's own result promise to report an
   * ABORT. `true` means the platform confirmed the run ended aborted; the
   * bound expiring is `false` — a request, never a confirmation.
   */
  private async awaitRunAbort(observed: Promise<DshRunObservation>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        observed,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.cancelConfirmTimeoutMs());
        }),
      ]);
      if (outcome === undefined) return false;
      return outcome.stopReason === "aborted";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The host dispatch adapter's `deliver`: start ONE dsh subagent run.
   *
   * Synchronous prefix, asynchronous tail. Everything that can refuse the
   * start without starting anything (no provider, no invoking session, no
   * resolvable live parent) throws HERE, so the host adapter un-records the
   * effect and the ledger row stays `pending` for the next recovery.
   */
  deliver = (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    invocation?: HostDispatchInvocation,
    inputView?: DeliveredInputView,
  ): void => {
    const agent = request.agent;
    if (this.opts.subagents.getProvider) {
      const provider = this.opts.subagents.getProvider(agent);
      if (!provider) {
        const known = this.opts.subagents.list?.() ?? [];
        throw new Error(
          "dsh outcome dispatch: no subagent provider registered for agent " +
          JSON.stringify(agent) +
          " (registered: " +
          (known.length > 0 ? known.join(", ") : "none") +
          ")",
        );
      }
    }
    const parentSessionId = invocation?.sessionId;
    if (parentSessionId === undefined || parentSessionId.length === 0) {
      throw new Error(
        "dsh outcome dispatch: no invoking session is in effect for graph " +
        JSON.stringify(request.graphId) +
        " — a dispatched attempt needs the live parent its subagent run is composed under",
      );
    }
    const parent = this.opts.parentResolver?.(parentSessionId);
    if (parent === undefined || parent === null) {
      throw new DshParentUnresolvedError(parentSessionId);
    }

    const controller = new AbortController();
    // THE PER-REQUEST ALLOW-LIST (the node's declared grant, intersected with
    // the tools this host actually registered). A resolver that THROWS or
    // answers nothing has not granted anything: the delivery falls back to the
    // static baseline rather than starting a worker under a list nobody
    // resolved. Never wider, only narrower.
    let workerTools: readonly string[] | undefined;
    try {
      workerTools = this.opts.workerToolsOf?.(request) ?? this.opts.workerTools;
    } catch {
      workerTools = this.opts.workerTools;
    }
    const startRequest: DshSubagentStartRequest = {
      // THE STABLE IDEMPOTENCY KEY IS THE CREATE CALL'S LABEL (P2 item 5). The
      // key — `graphId + "/dispatch:" + attemptId`, derived by the one function
      // both sides use — is CARRIED as the documented start-request `label`,
      // and it is the string {@link DshOutcomeDelivery.executionQuery} looks for
      // later. WHETHER the child listing returns that label is UNVERIFIED in
      // this repository (the contract extract documents `label?` on the start
      // request only, and `@deepseek-ai/dsh-subagent` is not installed); if it
      // does not, the correlation answers `unknown` and the effect stays
      // blocked — fail-closed, never a wrong execution. (dsh does not DEDUPE on
      // it either: at-most-once remains the host's fenced create right, and the
      // label is the correlation, not the fence.)
      label: dispatchIdempotencyKeyOf(effect),
      // THE WORKER'S ONE PROMPT (D7): the plan's prompt, the attempt handoff
      // and the input view the host materialized beside it. The view's file
      // paths are the worker's own copies, verified before this call.
      prompt: [{ type: "text", text: buildAttemptDeliveryPrompt(request, inputView) + (workerTools ? "\nUse graph_worker_exec for all workspace commands, file reads, edits and tests." : "") }],
      parent,
      signal: controller.signal,
      sessionId: parentSessionId,
      ...(workerTools ? { toolFilter: { allow: [...workerTools] } } : {}),
    };
    // The start itself is a promise; the delivery contract is synchronous. A
    // rejection is reported as a failed start (nothing was observed running).
    const start = () => this.opts.subagents.start(agent, startRequest);
    void Promise.resolve(this.opts.startWorker ? this.opts.startWorker(dispatchIdempotencyKeyOf(effect), start, request) : start()).then(
      (run) => {
        // The platform named the execution, so the host can record the fact it
        // created. Reported before the result is observed: a completion that
        // arrives immediately still finds a `created` row.
        this.opts.onStarted?.(request, effect, { executionId: run.id });
        // THE RUN IS ADDRESSABLE HERE FROM NOW ON (P3 cancel). The observation
        // is the SAME result promise the delivery reports from, so the abort
        // confirmation the cancel port reads and the completion/failure report
        // below can never disagree: one platform fact, read once.
        const observed: Promise<DshRunObservation> = Promise.resolve(run.result).then(
          (result: DshSubagentResult) =>
            Object.freeze({ stopReason: result.stopReason }),
          (err: unknown) => Object.freeze({ failure: errorText(err) }),
        );
        this.liveRuns.set(run.id, { controller, run, observed });
        void observed.then((outcome) => {
          this.terminalRuns.set(run.id, outcome);
          this.liveRuns.delete(run.id);
          if (this.closed) return;
          this.opts.onSettled(
            outcome.stopReason === "completed"
              ? { kind: "completed", request }
              : {
                kind: "failed",
                request,
                reason:
                  outcome.failure === undefined
                    ? "the dsh subagent run ended with stopReason " +
                    JSON.stringify(outcome.stopReason)
                    : "the subagent run result rejected: " + outcome.failure,
              },
          );
        });
      },
      (err: unknown) => {
        this.log.warn("dsh outcome dispatch: subagent start rejected", {
          graphId: request.graphId,
          attemptId: request.attemptId,
          error: errorText(err),
        });
        this.opts.onStartFailed(request, effect, errorText(err));
      },
    );
  };
}
