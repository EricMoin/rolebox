import type { CanonicalToolDef, CanonicalToolContext } from "../../platform/types.ts";
import { errorText } from "../../utils/error-text.ts";
import { logWarn } from "../log-warn.ts";
import {
  type OutcomeResumeResult
} from "../outcome/runtime.ts";
import {
  hostInvocationIdentity, type HostInvocationHolder,
  type HostWorkerSessionHolder
} from "./identity.ts";
import type { OutcomeHost, OutcomeHostOptions, OutcomeCancelDeliveryReport } from "./outcome-host.ts";
// ── Tool attribution ────────────────────────────────────────────────────────

/**
 * The refusal a BOUND DISPATCHED WORKER gets for every graph tool that is not
 * its delivery channel (plan §3.3 / A21).
 *
 * A worker's job — and the whole purpose of the attempt handoff — is to settle
 * its OWN attempt's outcome. Declaring or mutating a graph definition, reading
 * the authoritative store and controlling another attempt belong to the
 * declaring/operating principal, so the face a worker's call is judged by
 * grants exactly {@link WORKER_GRANTED_GRAPH_TOOLS} and refuses the rest by
 * name. Stable identifier; wording is not API.
 */
export const WORKER_TOOL_FORBIDDEN_CODE = "worker-tool-forbidden" as const;

/**
 * The ONLY graph-tool names a dispatched worker's face grants.
 *
 * DELIBERATELY AN ALLOW-LIST, NOT A DENY-LIST: a tool this build has not
 * shipped yet (an approval or cancel entry) is refused to a worker without
 * anyone remembering to add it here. A worker that needs more than the
 * delivery channel is a principal the run path does not have.
 */
export const WORKER_GRANTED_GRAPH_TOOLS: readonly string[] = Object.freeze([
  "graph_submit_outcome",
]);

/**
 * What the host bound one SESSION as: the worker of a dispatched attempt.
 *
 * Every field is a host fact — the platform named the execution
 * ({@link OutcomeHost.confirmExecution}) or the durable execution row carries
 * it — and the session is derived from that execution by the platform-specific
 * {@link OutcomeHostOptions.workerSessionOf}. Nothing here comes from the
 * caller of a tool.
 */
export interface OutcomeWorkerPrincipal {
  readonly graphId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly workerSessionId: string;
}

/**
 * The worker-principal half of a bound tool face: which names a dispatched
 * worker may call, and what the host bound one arriving session as.
 *
 * This is the boundary §3.3 requires and the one rolebox can enforce without
 * an OS/account/container boundary: it is a per-call authorization against the
 * host's own durable execution binding, not a path check, a permission bit or
 * a boolean capability.
 */
export interface OutcomeWorkerToolBoundary {
  /** The granted tool names; every other name in the face refuses a worker. */
  readonly granted: readonly string[];
  /** The attempt one session is the confirmed worker of, or `undefined`. */
  readonly principalOf: (sessionId: string) => OutcomeWorkerPrincipal | undefined;
}

/**
 * The refusal one bound worker's non-granted tool call receives, or
 * `undefined` when the call may run.
 *
 * TOTAL and synchronous: with no boundary installed, with a granted name, with
 * no session on the call, and with a session the host bound as no worker's, the
 * answer is "run it" — the boundary only ever refuses a call it can attribute
 * to a dispatched worker, so a declarer or an unrelated session is unaffected.
 */
function workerToolRefusal(
  toolName: string,
  boundary: OutcomeWorkerToolBoundary | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (boundary === undefined) return undefined;
  if (boundary.granted.includes(toolName)) return undefined;
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  const principal = boundary.principalOf(sessionId);
  if (principal === undefined) return undefined;
  return renderWorkerToolRefusal(toolName, boundary.granted, principal);
}

/** Render one worker-tool refusal as the machine-readable tool result. */
function renderWorkerToolRefusal(
  toolName: string,
  granted: readonly string[],
  principal: OutcomeWorkerPrincipal,
): string {
  return JSON.stringify(
    {
      refused: true,
      code: WORKER_TOOL_FORBIDDEN_CODE,
      tool: toolName,
      graph_id: principal.graphId,
      attempt_id: principal.attemptId,
      granted_tools: [...granted],
      message:
        toolName +
        " refused [" +
        WORKER_TOOL_FORBIDDEN_CODE +
        "]: this call arrives from the session the host bound as the worker of attempt " +
        JSON.stringify(principal.attemptId) +
        " of graph " +
        JSON.stringify(principal.graphId) +
        ". A dispatched worker's graph face grants exactly " +
        granted.join(", ") +
        " — declaring or mutating a graph definition, reading the authoritative store " +
        "and controlling another attempt are the declaring/operating principal's " +
        "capabilities, not the worker's. Settle your own attempt's outcome with " +
        "graph_submit_outcome.",
    },
    null,
    2,
  );
}

/** How the host resolves the acting agent for one tool invocation. */
export interface OutcomeToolAttribution {
  /** The host's invocation holder (D9). */
  readonly holder: HostInvocationHolder;
  /**
   * The holder for the session THIS call arrives from — the worker side of the
   * identity model. Moved with the invocation holder from the same platform
   * context, and read by {@link OutcomeHost.workerIdentity} SYNCHRONOUSLY: the
   * submission ingress captures the answer in the call's own prologue (before
   * its first await) and corroborates it with the session the tool face threads
   * from the same context. Omitting it leaves the declared worker binding
   * unable to name the session a submission arrives from, and such a
   * submission is refused rather than settled on its credential alone.
   */
  readonly workerSession?: HostWorkerSessionHolder;
  /** Platform acting-agent resolver (`context.agent` wins when populated). */
  readonly getEffectiveAgent?: (sessionID?: string) => string;
  /**
   * THE WORKER-PRINCIPAL BOUNDARY (plan §3.3 / A21).
   *
   * When installed, a call that arrives from a session this host bound as the
   * worker of a dispatched attempt is refused unless its tool name is in
   * `granted`. Omitted → the face grants every name (a host that cannot
   * substantiate a worker session has no worker principal to judge).
   */
  readonly workerBoundary?: OutcomeWorkerToolBoundary;
}

/**
 * Bind the outcome tool face to the host's invocation holder: every call puts
 * the host's attribution of THIS invocation in effect for the duration of the
 * call and clears it after. The same platform context also moves the worker
 * session holder, which the submission ingress CAPTURES in the call's own
 * synchronous prologue: the check that settles a submission therefore reads a
 * per-call capture, never a holder a concurrent call could have overwritten
 * (the dispatch that arms an attempt still reads the invocation holder inside
 * its own synchronous window).
 */
export function bindOutcomeToolInvocation(
  tools: Record<string, CanonicalToolDef>,
  attribution: OutcomeToolAttribution,
): Record<string, CanonicalToolDef> {
  const bound: Record<string, CanonicalToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    bound[name] = withInvocation(name, def, attribution);
  }
  return bound;
}

/**
 * Report what one control follow-up did, in one log line.
 *
 * A re-execution is named as such — a NEW RUN was minted — because an operator
 * reading "resumed" must be able to tell it from continuing the run that was
 * already there; refusals are counted and named by code so a follow-up that
 * could not launch is visible instead of silently absent.
 */
export function reportControlContinuation(graphId: string, result: OutcomeResumeResult): void {
  const parts: string[] = [];
  if (result.kind === "refused") {
    parts.push("REFUSED (" + result.refusals.map((entry) => entry.code).join(", ") + ")");
  } else {
    parts.push(result.kind);
    if (result.kind === "resumed" && result.reexecuted !== undefined) {
      parts.push(
        "re-executed run " +
        JSON.stringify(result.reexecuted.fromRunId) +
        " as " +
        JSON.stringify(result.reexecuted.runId) +
        " (runSeq " +
        String(result.reexecuted.runSeq) +
        ", plan revision " +
        JSON.stringify(result.reexecuted.planRevision) +
        ")",
      );
    }
    if (result.dispatched.length > 0) {
      parts.push(String(result.dispatched.length) + " dispatched");
    }
    if (result.refusals.length > 0) {
      parts.push(String(result.refusals.length) + " effect refusal(s)");
    }
  }
  logWarn(
    "outcome-host: control follow-up for graph " +
    JSON.stringify(graphId) +
    " — " +
    parts.join(", "),
  );
}

/**
 * HAND A GRAPH'S CANCEL INTENTS TO THE PLATFORM AFTER A `graph_control` CALL (P3 cancel).
 */
export function withCancelDelivery(
  tools: Record<string, CanonicalToolDef>,
  host: OutcomeHost,
): Record<string, CanonicalToolDef> {
  const control = tools["graph_control"];
  if (control === undefined) return tools;
  const inner = control.execute;
  return {
    ...tools,
    graph_control: {
      ...control,
      async execute(args, context) {
        const result = await inner(args, context);
        // ONLY AN APPLIED COMMAND DELIVERS. The answer's own `kind` is the service's
        // verdict: a refusal (no attribution, a caller that is not the declarer, an
        // unknown graph, an attempt that already settled) recorded nothing, and a
        // thrown store failure reached no platform either — neither has an intent to
        // hand over, and delivering on one would let an unauthorized caller make the
        // host ask a platform to stop a graph it does not own.
        const applied = appliedControlAnswerOf(result);
        if (applied !== undefined) {
          try {
            reportCancelDelivery(await host.deliverCancelIntents(applied.graphId));
            // ONLY A RETRY LEAVES WORK TO HAND OVER: the effects it just wrote (a
            // superseded attempt's successor) or the order to mint a new run.
            // `continueAfterControl` is total — it reports a graph it cannot
            // continue to the host's log and never throws — so an applied
            // command is never turned into a failed tool result here.
            if (applied.command === "retry") {
              await host.continueAfterControl(applied.graphId);
            }
          } catch (error) {
            logWarn(
              "outcome-host: the control follow-up of graph " +
              JSON.stringify(applied.graphId) +
              " threw (" +
              errorText(error) +
              ") — the durable cancel intent and every unconfirmed execution stay visible, " +
              "and the next boot sweep is the next window that delivers them",
            );
          }
        }
        return result;
      },
    },
  };
}

/**
 * The graph id AND command of an APPLIED `graph_control` answer, or `undefined`.
 *
 * The tool body renders the control service's result as JSON; `kind: "applied"` is the
 * service's own verdict that the command wrote a durable fact, so it is the only answer a
 * platform delivery may follow. A refused answer (or an error string a thrown store failure
 * produced) names no applied command and is answered `undefined`: nothing is delivered.
 *
 * The COMMAND is read too (P3 item 2), because a retry leaves work this call must hand over —
 * the successor attempt's pending effect, or the order to mint a new run — while a stopping
 * command leaves only its cancel intents. A missing or non-string command is treated as an
 * answer this build cannot act on: the graph id alone still delivers cancel intents, and no
 * continuation is attempted.
 */
function appliedControlAnswerOf(
  result: unknown,
): { readonly graphId: string; readonly command: string | undefined } | undefined {
  if (typeof result !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const answer = parsed as Record<string, unknown>;
  if (answer["kind"] !== "applied") return undefined;
  const graphId = answer["graphId"];
  if (typeof graphId !== "string" || graphId.length === 0) return undefined;
  const command = answer["command"];
  return Object.freeze({
    graphId,
    command: typeof command === "string" && command.length > 0 ? command : undefined,
  });
}

/**
 * Report what one cancel delivery established, per attempt.
 *
 * `confirmed` is the platform's own substantiation; every other state leaves the execution
 * visible and unsettled, which is what the log line says rather than rounding it into "cancelled".
 */
function reportCancelDelivery(report: OutcomeCancelDeliveryReport): void {
  if (report.entries.length === 0 && report.blocked === undefined) return;
  logWarn(
    "outcome-host: cancel delivery for graph " +
    JSON.stringify(report.graphId) +
    " — " +
    (report.blocked === undefined ? "" : "BLOCKED (" + report.blocked + "); ") +
    report.entries.map((entry) => entry.attemptId + ":" + entry.state).join(", ") +
    " — 'confirmed' is the platform's own substantiation; every other state leaves the " +
    "execution visible and unsettled, and no unconfirmed cancel is reported as cancelled",
  );
}


/** The erased argument type one canonical tool's execute receives. */
type ToolExecute = CanonicalToolDef["execute"];
type ToolExecuteArgs = Parameters<ToolExecute>[0];

function withInvocation(
  name: string,
  def: CanonicalToolDef,
  attribution: OutcomeToolAttribution,
): CanonicalToolDef {
  const inner = def.execute;
  return {
    ...def,
    async execute(args: unknown, context: CanonicalToolContext) {
      const agent =
        context?.agent && context.agent.length > 0
          ? context.agent
          : (attribution.getEffectiveAgent?.(context?.sessionID) ?? "");
      attribution.holder.set(hostInvocationIdentity(context?.sessionID, agent));
      // THE WORKER SIDE, FROM THE SAME PLATFORM CONTEXT. The session is taken
      // RAW — the D9 pair needs an agent too, while the worker binding is the
      // session the platform itself attributes the call to. An empty/absent
      // session clears the holder, and a submission under no session is refused
      // by name rather than settled on its credential alone. The ingress
      // captures this answer in the call's own synchronous prologue; the holder
      // is never read across an await on the submission path.
      attribution.workerSession?.set(context?.sessionID);
      try {
        // THE WORKER BOUNDARY RUNS BEFORE THE TOOL BODY. A bound worker's call
        // to anything but its delivery channel is answered here, so no parse,
        // no compile, no store read and no write happens for it — and the
        // refusal is derived from the host's own binding of the session, never
        // from an argument the caller chose.
        const refused = workerToolRefusal(
          name,
          attribution.workerBoundary,
          context?.sessionID,
        );
        if (refused !== undefined) return refused;
        return await inner(args as ToolExecuteArgs, context);
      } finally {
        attribution.holder.clear();
        attribution.workerSession?.clear();
      }
    },
  };
}

