import { z } from "zod";
import { workerPresentationTools, type WorkerToolPresentation } from "../domain/worker-tools.ts";

import type { CanonicalToolDef, CanonicalToolContext } from "../../platform/types.ts";
import { readAppliedControl } from "../control/contracts.ts";
import { errorText } from "../../utils/error-text.ts";
import { logEvent, withLogScope } from "../../log/index.ts";
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
 *
 * THIS LIST IS THE GRAPH FACE, AND IT STAYS STATIC. A node that declares extra
 * `tools` grants its own worker HOST tools beside this baseline
 * ({@link OutcomeWorkerToolBoundary.declaredToolsOf}); those names are not graph
 * tools and are never merged into this constant, so every graph tool outside it
 * refuses a worker exactly as before.
 *
 * THE NAMESPACE IS ALSO RESERVED: the graph face owns every tool name beginning
 * {@link GRAPH_TOOL_NAME_PREFIX}, and a declared grant can never admit one
 * ({@link declaredToolsAllow}) — a grant is a narrowing of what HOST tools the
 * node may use, never a second route to the face this boundary withholds.
 */
export const WORKER_GRANTED_GRAPH_TOOLS: readonly GraphToolName[] = Object.freeze([
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

export interface OutcomeWorkerToolGrant {
  readonly declaredTools?: readonly string[];
  readonly toolPresentation?: WorkerToolPresentation;
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
  /**
   * The BASELINE granted tool names — the graph face; every other name in the
   * face refuses a worker unless the node that worker executes declares it
   * through {@link OutcomeWorkerToolBoundary.declaredToolsOf}.
   */
  readonly granted: readonly GraphToolName[];
  /** The attempt one session is the confirmed worker of, or `undefined`. */
  readonly principalOf: (sessionId: string) => OutcomeWorkerPrincipal | undefined;
  /**
   * THE NODE'S DECLARED HOST-TOOL GRANT, resolved per worker principal.
   *
   * A v3 node may declare `tools?: string[]` — extra HOST tool names, or
   * trailing-star prefixes such as `computer_*`, its worker may use beyond the
   * baseline. Those names are HOST tools, never graph tools, so they are added
   * to the baseline only for the worker of the node that declared them, and
   * only for the call being judged.
   *
   * THE GRAPH FACE IS OUT OF REACH OF THE DECLARATION: a declared entry is
   * matched against HOST tools only, so no spelling (`graph_*`, `graph_status`,
   * an exact graph name) can admit a call to a name in the reserved graph
   * namespace ({@link isGraphFaceToolName}), however the declaration was
   * written. The enforcement lives HERE rather than in the declaration reader
   * because a persisted plan is read structurally at dispatch: a plan written
   * before any reader rule existed must still refuse a worker its graph face.
   *
   * FAIL CLOSED. Omitted, answering `undefined`, throwing, or answering
   * anything that is not an array of non-empty strings all leave the worker
   * with the BASELINE alone: a grant this host cannot resolve is never read as
   * "allow". An undeclared node keeps exactly the baseline restriction.
   */
  readonly declaredToolsOf?: (
    principal: OutcomeWorkerPrincipal,
  ) => readonly string[] | undefined;
  readonly presentationOf?: (principal: OutcomeWorkerPrincipal) => WorkerToolPresentation | undefined;
}

/**
 * Whether ONE declared grant entry admits a tool name.
 *
 * Two spellings are legal, and both are matched against the HOST tool name the
 * call arrives with: an EXACT name (`computer_screenshot`) admits exactly that
 * name, and a TRAILING-STAR PREFIX (`computer_*`) admits every name that starts
 * with the stem. A bare `*` is the exact name `*` — the prefix has to name
 * something — so no single entry can grant the whole host tool surface.
 */
export function declaredToolAllows(entry: string, toolName: string): boolean {
  if (!entry.endsWith("*")) return entry === toolName;
  const stem = entry.slice(0, -1);
  return stem.length > 0 && toolName.startsWith(stem);
}

/**
 * The reserved namespace of the GRAPH FACE's own tools.
 *
 * Every graph tool this build ships is spelled `graph_` + name
 * (`graph_declare`, `graph_submit_outcome`, `graph_status`, `graph_audit`,
 * `graph_control`, and dsh's `graph_worker_exec`), and the worker baseline
 * {@link WORKER_GRANTED_GRAPH_TOOLS} is drawn from the same namespace. Reserving
 * the PREFIX — rather than a list repeated here — is what keeps the rule
 * fail-closed for a graph tool this build has not shipped yet: a declaration
 * cannot admit it either, without anyone remembering to add it anywhere.
 */
export const GRAPH_TOOL_NAME_PREFIX = "graph_" as const;

/**
 * Whether one tool name belongs to the graph face's own reserved namespace.
 *
 * A NAME TEST, not a lookup: the boundary must answer for a name it has no
 * definition of (the call may never reach a registered tool), and the answer
 * must not depend on which tools a host happened to register.
 */
export function isGraphFaceToolName(toolName: string): boolean {
  return toolName.startsWith(GRAPH_TOOL_NAME_PREFIX);
}

/**
 * THE CLOSED VOCABULARY of graph face tool names: the ONE list every face that
 * grants, exposes or judges a graph tool is written against.
 *
 * Each face used to spell its own membership as a bare string literal, so
 * `includes`/`has` accepted any string: a renamed or newly added tool changed
 * no face's compile, and the in-process boundary, the remote worker channel and
 * the dsh execution guard could disagree silently. Deriving
 * {@link GraphToolName} from this list makes each face's membership a fact the
 * compiler checks, and {@link isGraphToolName} is the one runtime narrowing a
 * face uses to ask whether a name it only knows as a `string` belongs to the
 * namespace at all.
 *
 * THIS IS THE SHIPPED SURFACE, NOT ONE FACE'S GRANT. A face that grants fewer
 * names than the vocabulary (a dispatched worker's baseline) keeps its own list
 * of them, typed by this union.
 */
export const GRAPH_TOOL_NAMES = Object.freeze([
  /** The declaration ingress: build and persist a declared graph. */
  "graph_declare",
  /** The delivery channel every dispatched worker holds. */
  "graph_submit_outcome",
  /** The authoritative store's inventory. */
  "graph_audit",
  /** The authoritative store's status query. */
  "graph_status",
  /** The trusted lifecycle control entry. */
  "graph_control",
  /** dsh's worker command entry, shipped beside the graph face on that host. */
  "graph_worker_exec",
  "graph_worker_tools",
  "graph_worker_code",
] as const);

/** One tool name in the graph face's closed vocabulary. */
export type GraphToolName = (typeof GRAPH_TOOL_NAMES)[number];

/**
 * Whether ONE caller-supplied string is a graph face tool name.
 *
 * The narrowing every face uses before it looks a name up in its own typed
 * membership: a bare `string` is not assignable to {@link GraphToolName}, so an
 * unchecked `includes`/`has` call is exactly what the compiler now refuses. A
 * NAME TEST, not a lookup — it answers for a name no tool definition exists for.
 */
export function isGraphToolName(toolName: string): toolName is GraphToolName {
  return GRAPH_TOOL_NAMES.some((name) => name === toolName);
}

/**
 * Whether ONE DECLARED GRANT admits one tool name. TOTAL and fail-closed: an
 * absent or empty grant, and any entry that is not a usable string, admits
 * nothing.
 *
 * THE DECLARED GRANT NAMES HOST TOOLS, SO THE GRAPH FACE IS NEVER ADMITTED. A
 * name in the reserved graph namespace is refused BEFORE the entries are even
 * consulted, so `tools: ["graph_*"]`, `tools: ["graph_status"]` and every other
 * spelling of a graph-tool grant admit nothing: the graph face a dispatched
 * worker holds is {@link WORKER_GRANTED_GRAPH_TOOLS} plus dsh's
 * `graph_worker_exec`, and it stays that whatever a node declares. The baseline
 * check runs first in every caller, so the names a worker legitimately holds are
 * unaffected by this rule.
 */
export function declaredToolsAllow(
  toolName: string,
  declared: readonly string[] | undefined,
): boolean {
  if (isGraphFaceToolName(toolName)) return false;
  if (toolName.startsWith("team_") || toolName.startsWith("rb_team_")) return false;
  if (declared === undefined) return false;
  return declared.some(
    (entry) => typeof entry === "string" && declaredToolAllows(entry, toolName),
  );
}

/**
 * Whether one declared entry can only ever name the reserved graph namespace.
 *
 * A prefix entry is judged by its STEM: `graph_*` admits only names beginning
 * `graph_`, so it is a graph grant and never a host grant. A bare `*` has no
 * stem and is kept (it admits no graph name either — {@link declaredToolsAllow}
 * refuses the namespace first).
 *
 * Used for REPORTING alone: an entry that cannot admit a host tool is not part
 * of the face a refusal may claim was granted. The enforcement is
 * {@link declaredToolsAllow}'s, not this predicate's.
 */
function declaredEntryNamesGraphFace(entry: string): boolean {
  const stem = entry.endsWith("*") ? entry.slice(0, -1) : entry;
  return isGraphFaceToolName(stem);
}

/**
 * The declared grant of one worker's node, as the boundary will use it.
 *
 * A lookup that THROWS has not answered — the answer is the baseline, never a
 * grant — and a malformed entry is dropped rather than trusted, so the only way
 * a name is admitted is a non-empty string the host actually resolved. The
 * refusal this fallback produces names the baseline it judged, so a host whose
 * lookup is broken refuses; it never allows on an uncertainty.
 */
function declaredToolsForPrincipal(
  boundary: OutcomeWorkerToolBoundary,
  principal: OutcomeWorkerPrincipal,
): readonly string[] {
  const lookup = boundary.declaredToolsOf;
  if (lookup === undefined) return [];
  let declared: readonly string[] | undefined;
  try {
    declared = lookup(principal);
  } catch {
    return [];
  }
  if (!Array.isArray(declared)) return [];
  return declared.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
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
  if (isGraphToolName(toolName) && boundary.granted.includes(toolName)) return undefined;
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  const principal = boundary.principalOf(sessionId);
  if (principal === undefined) return undefined;
  let presentationTools: readonly string[] = [];
  try {
    presentationTools = workerPresentationTools(boundary.presentationOf?.(principal));
  } catch {
    // An unreadable presentation never grants a capability entry point.
  }
  if (presentationTools.includes(toolName)) return undefined;
  // THE DECLARED GRANT IS THE NODE'S OWN: it is resolved from the principal the
  // HOST bound this session as — never from the caller, the tool name or a
  // process-wide setting — and it only ever ADDS names for that one worker.
  const declared = declaredToolsForPrincipal(boundary, principal);
  if (declaredToolsAllow(toolName, declared)) return undefined;
  return renderWorkerToolRefusal(
    toolName,
    [
      ...boundary.granted,
      ...presentationTools,
      // A declared graph-namespace entry is NOT reported as granted: it admits
      // no host tool, and this refusal is read as "what the face grants".
      ...declared.filter((entry) => !declaredEntryNamesGraphFace(entry)),
    ],
    principal,
  );
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
        ". A dispatched worker's face grants exactly " +
        granted.join(", ") +
        " (the graph baseline plus the host tools its own node declares; a declared " +
        "grant names HOST tools only and never admits a name in the graph face's own " +
        "graph_ namespace) — " +
        "declaring or mutating a graph definition, reading the authoritative store " +
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
export function bindOutcomeToolInvocation<Tools extends Record<string, CanonicalToolDef>>(
  tools: Tools,
  attribution: OutcomeToolAttribution,
): Tools {
  const bound: Record<string, CanonicalToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    bound[name] = withInvocation(name, def, attribution);
  }
  // THE RECORD'S OWN TYPE SURVIVES THE BIND, THE PER-ENTRY ARGUMENT TYPE DOES
  // NOT. `Tools` is a concrete record and it is handed back as one — no caller
  // loses `args`/`execute` to a `Record<string, CanonicalToolDef>`. But this
  // loop reads the record STRUCTURALLY (`Object.entries` answers the erased
  // `CanonicalToolDef` for every entry), so `withInvocation` is instantiated
  // with `Args` at its default `z.ZodRawShape`, NOT with each entry's own
  // declared shape. Its parsing is still the entry's own schema at runtime, so
  // the declared shape is enforced; what is absent is only the STATIC tie
  // between `parsed.data` and the body's declared arguments. Threading that type
  // through would need a cast this module does not take, so nothing here may
  // claim the tie.
  return Object.assign({ ...tools }, bound);
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
  if (result.kind === "refused") {
    withLogScope({ graphId }, () =>
      logEvent("tool.control-continuation", {
        kind: "refused",
        refusals: result.refusals.map((entry) => entry.code),
      }),
    );
    return;
  }
  withLogScope({ graphId }, () =>
    logEvent("tool.control-continuation", {
      kind: result.kind,
      dispatched: result.dispatched.length,
      refusals: result.refusals.map((entry) => entry.code),
      ...(result.kind === "resumed" && result.reexecuted !== undefined
        ? {
          fromRunId: result.reexecuted.fromRunId,
          runId: result.reexecuted.runId,
          runSeq: result.reexecuted.runSeq,
          planRevision: result.reexecuted.planRevision,
        }
        : {}),
    }),
  );
}

/**
 * HAND A GRAPH'S CANCEL INTENTS TO THE PLATFORM AFTER A `graph_control` CALL (P3 cancel).
 */
export function withCancelDelivery<Tools extends Record<string, CanonicalToolDef>>(
  tools: Tools,
  host: OutcomeHost,
): Tools {
  const control = tools["graph_control"];
  if (control === undefined) return tools;
  const inner = control.execute;
  return Object.assign({ ...tools }, {
    graph_control: {
      ...control,
      async execute(args: Record<string, unknown>, context: CanonicalToolContext) {
        const result = await inner(args, context);
        // ONLY AN APPLIED COMMAND DELIVERS. The answer's own `kind` is the service's
        // verdict: a refusal (no attribution, a caller that is not the declarer, an
        // unknown graph, an attempt that already settled) recorded nothing, and a
        // thrown store failure reached no platform either — neither has an intent to
        // hand over, and delivering on one would let an unauthorized caller make the
        // host ask a platform to stop a graph it does not own.
        const applied = readAppliedControl(requestedGraphIdOf(args), result);
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
            withLogScope({ graphId: applied.graphId }, () =>
              logEvent("tool.control-follow-up-threw", {
                failure: errorText(error),
              }),
            );
          }
        }
        return result;
      },
    },
  });
}

/**
 * The graph ONE `graph_control` call named, or `""` when the call carries none.
 *
 * The command's own zod shape requires a non-empty `graph_id`, but this wrapper
 * receives a record it did not parse itself: the graph the call named is read
 * here so the answer is corroborated against it, and a call with no usable
 * `graph_id` answers `""`, which the reader refuses.
 */
function requestedGraphIdOf(args: Record<string, unknown>): string {
  const graphId = args["graph_id"];
  return typeof graphId === "string" ? graphId : "";
}

/**
 * Report what one cancel delivery established, per attempt.
 *
 * `confirmed` is the platform's own substantiation; every other state leaves the execution
 * visible and unsettled, which is what the log line says rather than rounding it into "cancelled".
 */
function reportCancelDelivery(report: OutcomeCancelDeliveryReport): void {
  if (report.entries.length === 0 && report.blocked === undefined) return;
  withLogScope({ graphId: report.graphId }, () =>
    logEvent("tool.cancel-delivery", {
      ...(report.blocked === undefined ? {} : { blocked: report.blocked }),
      entries: report.entries.map((entry) => entry.attemptId + ":" + entry.state),
    }),
  );
}


/**
 * The refusal a tool call with a MALFORMED ARGUMENT RECORD receives.
 *
 * THE ARGUMENT RECORD IS THE ONE UNVALIDATED VALUE ON THIS SEAM. The platform
 * parses a tool's declared shape before it calls, but this wrapper is exported
 * and receives whatever the platform hands it; re-labelling that value as the
 * declared record (an `as`) merged "the platform validated this" and "an
 * arbitrary object arrived" into one program. The wrapper therefore VALIDATES
 * the record against the tool's OWN zod shape and answers this refusal instead
 * of forwarding it. Stable identifier; wording is not API.
 */
export const TOOL_ARGUMENT_REFUSED_CODE = "tool-argument-malformed" as const;

/** Render one malformed-argument refusal as the machine-readable tool result. */
function renderToolArgumentRefusal(toolName: string, issues: readonly string[]): string {
  return JSON.stringify(
    {
      refused: true,
      code: TOOL_ARGUMENT_REFUSED_CODE,
      tool: toolName,
      issues: [...issues],
      message:
        toolName +
        " refused [" +
        TOOL_ARGUMENT_REFUSED_CODE +
        "]: the argument record this call carried does not satisfy the tool's own " +
        "declared shape" +
        (issues.length === 0 ? "" : " (" + issues.join(", ") + ")") +
        " — nothing ran, because a tool body only ever receives a record its own " +
        "schema accepted.",
    },
    null,
    2,
  );
}

function withInvocation<Args extends z.ZodRawShape>(
  name: string,
  def: CanonicalToolDef<Args>,
  attribution: OutcomeToolAttribution,
): CanonicalToolDef<Args> {
  const inner = def.execute;
  // THE TOOL'S OWN SHAPE, KEPT AS A SCHEMA. `passthrough` so a record the
  // platform enriched with keys the schema does not declare reaches the body
  // exactly as it did before: only the DECLARED arguments are checked.
  const schema = z.object(def.args).passthrough();
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
        // THE DECLARED SHAPE IS ENFORCED, NOT ASSERTED. `args` is the one value
        // this wrapper did not parse; the tool's own schema is what turns it
        // into the body's declared argument type. A record the platform already
        // parsed satisfies the same schema, so a legitimate call is unchanged;
        // anything else is refused BY NAME instead of being re-labelled.
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          return renderToolArgumentRefusal(
            name,
            parsed.error.issues.map((issue) => issue.path.join(".") + ":" + issue.code),
          );
        }
        return await inner(parsed.data, context);
      } finally {
        attribution.holder.clear();
        attribution.workerSession?.clear();
      }
    },
  };
}

