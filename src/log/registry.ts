// ── The closed event vocabulary ─────────────────────────────────────────────
//
// ONE TABLE OWNS EVERY EVENT'S LEVEL, CHANNEL AND SENTENCE. A diagnostic is an
// EVENT — a registered code plus fields that name ids, states, reasons and
// counts — and this table is the only place its level, its channel and its
// message are written down. A call site therefore cannot drift the wording of a
// stable diagnostic, and a code that is not registered here does not type check.
//
// WHAT THIS TABLE HOLDS (23 entries: 4 platform, 19 graph engine)
//   The FOUR PLATFORM entries are the logging pipeline's own failures — a sink
//   that threw, a channel file that could not be written or rotated — plus the
//   guard for a code that was never registered; all four report on the channel
//   `log`.
//   The NINETEEN GRAPH-ENGINE entries are the engine's diagnostics, each on the
//   channel of the module that reports it: thirteen on `graph:host` (the host
//   and its runtime), three on `graph:tool` (the tool binding around the host),
//   two on `graph:index` (the host execution index) and one on `graph:declare`
//   (the declaration tool). They sit in the GRAPH ENGINE EVENTS block below —
//   the insertion point this header marks — as one section per channel, each
//   section introduced by the channel it holds.
//
// ADDING AN EVENT. An entry is appended INSIDE the section of the channel it
// reports on, and a new channel gets its own section with the same one-line
// channel comment. The level, the channel and the one sentence live here, never
// at a call site: the caller passes the code and the fields the entry's own
// comment names.
//
// SHAPE. `as const satisfies` (not a type annotation) is deliberate: an index
// signature annotation would widen `keyof typeof LOG_EVENTS` to `string |
// number` and let a call site invent a code. With the table inferred from its
// literal, {@link LogEventCode} is exactly the registered set, while `satisfies`
// still checks every entry against {@link LogEventDefinition}.
//
// THROTTLING is opt-in per entry: only an entry that declares `throttleMs` is
// ever suppressed (src/log/throttle.ts). The default is no throttling, so a
// registered event is emitted every time until someone deliberately says
// otherwise.
//
// PRIVACY. A message states the durable fact in one sentence; the fields an
// entry's callers pass carry ids, states, reasons and counts — never a payload,
// an accepted result, a credential or a raw platform error body. The comments
// below name the fields each entry expects.

import type { LogLevel } from "./types.ts";

/** One registered event: how loud, on which channel, what it says. */
export interface LogEventDefinition {
  readonly level: LogLevel;
  /** The channel a record for this event carries, e.g. "graph:host". */
  readonly channel: string;
  /** The stable one-sentence message; a call site never re-states it. */
  readonly message: string;
  /**
   * Window in milliseconds during which repeats of this (channel, code) are
   * suppressed and counted. Omitted means "never throttle".
   */
  readonly throttleMs?: number;
}

/**
 * THE CLOSED VOCABULARY. Registering a diagnostic here first is the point of
 * the table; the comment above each entry says why it is registered and which
 * fields its callers pass.
 */
export const LOG_EVENTS = {
  /**
   * A sink threw while it was handed a record.
   * ERROR because the pipeline lost that record for that destination; the sink
   * is reported once per process (src/log/sinks/fanout.ts) and the caller is
   * never disturbed. A sink that throws on EVERY record is therefore visible in
   * the log exactly once, not once per record.
   * Caller: src/log/index.ts (the fanout's onFailure reporter).
   * Fields: `sink` (the destination name), `error` (the error's name) and an
   * optional bounded `detail`.
   */
  "log.sink.failed": {
    level: "error",
    channel: "log",
    message:
      "a log sink threw while receiving a record; the record was dropped for that destination and the failure is reported once",
  },

  /**
   * The JSON-lines file could not be written, so file logging degraded.
   * ERROR because every later record is lost to the file; the sink stops
   * attempting writes (no repeated failure reports) and the pipeline itself
   * stays alive. The console and memory destinations are unaffected.
   * Caller: src/log/sinks/file.ts (through index.ts's failure reporter).
   * Fields: `channel`, `error` (the error's name) and an optional bounded
   * `detail`.
   */
  "log.file.write-failed": {
    level: "error",
    channel: "log",
    message:
      "the log file could not be written; file logging is degraded to a no-op for this process and the pipeline continues",
  },

  /**
   * The log file could not be rotated at its size limit.
   * WARNING because the file keeps accepting records, it simply grows past its
   * limit; rotation is abandoned for this process rather than retried on every
   * write, and the failure is reported once.
   * Caller: src/log/sinks/file.ts (through index.ts's failure reporter).
   * Fields: `channel` and `maxBytes`.
   */
  "log.file.rotate-failed": {
    level: "warn",
    channel: "log",
    message:
      "the log file could not be rotated at its size limit; it keeps accepting records and grows past the limit",
  },

  /**
   * A caller emitted an event code that is not in this table.
   * WARNING because a diagnostic was dropped and the drift is otherwise
   * invisible — a call site that invented a code, or a JavaScript caller. The
   * code is dropped and counted; this entry reports the count.
   * Caller: src/log/runtime.ts (emitLogEvent's unknown-code branch).
   * Fields: `event` (the dropped code) and `dropped` (the running count).
   * THROTTLED: 60s, so a call site that drifts inside a loop cannot flood the
   * log; suppressed occurrences are counted and attached to the next report.
   */
  "log.event.unknown-code": {
    level: "warn",
    channel: "log",
    message: "an event code outside the closed vocabulary was dropped",
    throttleMs: 60_000,
  },

  // ── GRAPH ENGINE EVENTS ───────────────────────────────────────────────────
  // The engine's events, appended where the table above marks the insertion
  // point. The level and the channel are the engine's own, and each sentence
  // states the same fact as the engine module that used to own it (deleted when
  // its call sites moved here) — RE-WORDED for the table, not copied: those
  // lines were multi-clause sentences carrying rationale and formatted id
  // lists, while an entry's sentence is the durable fact, once. The stage-1
  // review checked all nineteen against the deleted module: no id, reason or
  // count was lost in the rewrite. What was COMMENTARY rather than data lives on
  // in each entry's own comment below — `index.confirmation-refused` still says
  // the stale attempt was recorded on the row, and `dispatch.query-threw` still
  // says why the port's message is not quoted.
  // Every one of these nineteen diagnostics was a warning, so every entry stays
  // `warn` and the default console gate (ROLEBOX_LOG_CONSOLE_LEVEL, "warn")
  // keeps all nineteen visible.
  //
  // THE CHANNEL NAMES THE SOURCE, not the code's prefix: the host's own files
  // report on "graph:host", the tool binding on "graph:tool", the execution
  // index on "graph:index" and the declaration tool on "graph:declare". The
  // channel is what the file sink turns into <logDir>/<channel>.log, so these
  // four names are the four files an operator greps.
  //
  // IDENTITY IS NOT A FIELD. Every entry whose caller held a graph, attempt or
  // effect id takes it from the AMBIENT SCOPE (withLogScope, src/log/context.ts)
  // instead of passing it as a field: the scope is the part a query filters on
  // (`scope.graphId`), and the fields keep only the rest — states, reasons,
  // counts and the ids that are NOT in the scope vocabulary (an execution id, a
  // run id, a claim owner). Each entry therefore names its `Scope:` keys and its
  // `Fields:` keys, so a call site can be checked against it.
  // ──────────────────────────────────────────────────────────────────────────

  // ── graph:host — the host's own diagnostics ───────────────────────────────

  /**
   * The follow-up that continues a graph after an applied control command threw.
   * WARNING because that continuation did not run in this window: the durable
   * control fact and its effect stay visible, and the next boot sweep is the
   * next window that continues them.
   * Scope: `graphId`. Fields: `failure`.
   * Caller: src/graph/host/outcome-host.ts (continueAfterControl's catch).
   */
  "host.control-continuation.failed": {
    level: "warn",
    channel: "graph:host",
    message:
      "continuing the graph after an applied control command failed; the durable control fact and effect stay visible, and the next boot sweep is the next window that continues them",
  },

  /**
   * The boot sweep could not read the workspace store, so it had no inventory.
   * WARNING because this is a BLOCKED sweep, not an empty one: "nothing to do"
   * would be a false answer for a workspace whose manifests were never visited.
   * Scope: none (the sweep is workspace-wide). Fields: `reason`.
   * Caller: src/graph/host/outcome-host.ts (recoverDeclaredGraphs).
   */
  "sweep.store-blocked": {
    level: "warn",
    channel: "graph:host",
    message:
      "the workspace store could not be read, so this was a blocked sweep with no inventory to visit, not an empty one",
  },

  /**
   * The boot sweep's aggregate report: what it started, resumed, refused,
   * completed, left awaiting, controlled, failed, cancelled or could not
   * confirm.
   * WARNING because a sweep that changed or refused anything must be visible;
   * with every list empty there is no event (the caller decides that, not this
   * table).
   * Scope: none (the sweep is workspace-wide). Fields: `started`, `resumed`,
   * `refused`, `effectRefusals`, `divergences`, `completed`, `awaiting`,
   * `controlled`, `failedAttempts`, `cancellations`, `cancelBlocked`,
   * `unconfirmed` — each an array of ids, states and counts, and each entry of
   * the per-graph arrays a "graphId:…" string rather than a nested object.
   * Caller: src/graph/host/outcome-host.ts (recoverDeclaredGraphs).
   */
  "sweep.summary": {
    level: "warn",
    channel: "graph:host",
    message: "declared-graph boot sweep summary",
  },

  /**
   * Re-subscribing to awaiting executions left some without an established
   * observation.
   * WARNING because those executions stay named in the sweep's awaiting
   * inventory and are NOT covered: the next recovery window is the next time
   * anything looks at them.
   * Scope: none (the report spans graphs). Fields: `watched`, `settled`,
   * `unwatched` (counts) and `unwatchedExecutions` (one "graphId:attemptId:
   * reason" string per execution).
   * Caller: src/graph/host/outcome-host.ts (retainAwaitingCompletions).
   */
  "watch.unwatched-executions": {
    level: "warn",
    channel: "graph:host",
    message:
      "awaiting executions were left without an established observation and stay named in the awaiting inventory",
  },

  /**
   * The platform's completion-watch port threw while an execution was being
   * watched.
   * WARNING because a port that threw established nothing: the execution is
   * reported as unwatched rather than treated as covered, and no settlement is
   * faked.
   * Scope: `graphId`, `attemptId`. Fields: `executionId`, `failure`.
   * Caller: src/graph/host/outcome-host.ts (watchFor).
   */
  "watch.port-threw": {
    level: "warn",
    channel: "graph:host",
    message:
      "the platform completion-watch port threw, so the execution is reported as unwatched rather than covered",
  },

  /**
   * The platform announced an execution ended, but the host's own read of that
   * execution does not report a completion.
   * WARNING because an announcement is not an outcome: the attempt stays
   * unsettled and is reported again on the next recovery window instead of
   * being settled on the announcement alone.
   * Scope: `graphId`, `attemptId`. Fields: `executionId`, `observation`,
   * `refusalCode`, `reason`.
   * Caller: src/graph/host/outcome-host.ts (settleWatchedCompletion).
   */
  "watch.announcement-unconfirmed": {
    level: "warn",
    channel: "graph:host",
    message:
      "the platform announced the execution ended, but the host's own read does not report a completion, so the attempt stays unsettled",
  },

  /**
   * The settlement report produced after an announced end (channel, kind,
   * reason, submission id).
   * WARNING because the outcome of an announcement must be readable: it is how
   * an operator tells "settled" from "unsettled" or an idempotent replay.
   * Scope: `graphId`, `attemptId`. Fields: `executionId`, `kind`, `detail`.
   * Caller: src/graph/host/outcome-host.ts (settleWatchedCompletion).
   */
  "watch.announcement-settled": {
    level: "warn",
    channel: "graph:host",
    message: "the platform announced the execution ended; the settlement report follows",
  },

  /**
   * Settling an announced end threw.
   * WARNING because the attempt stays unsettled and is reported, rather than
   * being silently closed by a failed settlement.
   * Scope: `graphId`, `attemptId`. Fields: `executionId`, `failure`.
   * Caller: src/graph/host/outcome-host.ts (settleWatchedCompletion).
   */
  "watch.settlement-threw": {
    level: "warn",
    channel: "graph:host",
    message: "settling the announced execution threw, so the attempt stays unsettled",
  },

  /**
   * A delivery failed in a way that cannot prove no execution was created.
   * WARNING because the create right is KEPT: the row stays `creating`, every
   * later lookup answers `unknown`, and the effect is reported as unresolved
   * instead of being re-dispatched.
   * Scope: `graphId`, `effectId`. Fields: `reason`.
   * Caller: src/graph/host/outcome-host.ts (reportDeliveryFailure).
   */
  "dispatch.delivery-unproven": {
    level: "warn",
    channel: "graph:host",
    message:
      "delivery failed with no proof that no execution was created, so the create right is kept and the row stays 'creating'",
  },

  /**
   * Priming the platform's execution readings failed.
   * WARNING because every reading stays unset: the next synchronous lookup
   * answers `unknown` and the affected effects stay blocked rather than being
   * guessed at.
   * Scope: none (the probes span graphs). Fields: `probeCount`, `failure`.
   * Caller: src/graph/host/dispatch-host.ts (primePlatformReadings).
   */
  "dispatch.prime-failed": {
    level: "warn",
    channel: "graph:host",
    message:
      "priming the platform execution readings failed, so every reading stays unset and the next lookup answers 'unknown'",
  },

  /**
   * The platform's execution query threw.
   * WARNING because the create outcome is reported as UNKNOWN — never as
   * `absent`, which would license a second create. The port's own message is
   * NOT quoted: the request carries an attempt credential.
   * Scope: `graphId`, `effectId`. Fields: none.
   * Caller: src/graph/host/dispatch-host.ts (platformLookup).
   */
  "dispatch.query-threw": {
    level: "warn",
    channel: "graph:host",
    message: "the platform execution query threw, so the create outcome is reported as unknown",
  },

  /**
   * The platform named an execution, but binding it to the durable row failed.
   * WARNING because the local write did not land: the platform's name is kept
   * for the recovery and NO second execution is created for the effect.
   * Scope: `graphId`, `effectId`. Fields: `executionId`, `failure`.
   * Caller: src/graph/host/dispatch-host.ts (bindPlatformExecution).
   */
  "dispatch.binding-failed": {
    level: "warn",
    channel: "graph:host",
    message:
      "the platform named an execution, but binding it locally failed; the platform's name is kept and no second execution is created",
  },

  /**
   * The platform named an execution, but this process does not hold the claim
   * that recorded the create.
   * WARNING because the durable row is NOT rewritten (a stale confirmation is
   * not allowed to overwrite a live claim) and no second execution is created.
   * Scope: `graphId`, `effectId`. Fields: `executionId`, `verdict`.
   * Caller: src/graph/host/dispatch-host.ts (bindPlatformExecution).
   */
  "dispatch.unclaimed-confirmation": {
    level: "warn",
    channel: "graph:host",
    message:
      "the platform named an execution, but this process does not hold the claim that recorded the create; the durable row is not rewritten",
  },

  // ── graph:index — the host execution index ────────────────────────────────

  /**
   * A confirmation was refused by a fence or a conflicting record.
   * WARNING because a conditional write did not happen: the recorded fact is
   * unchanged, the stale attempt was recorded on the row for diagnosis, and
   * this event is what carries the refusal (the removed describeRefusal text
   * existed only for the log).
   * Scope: `graphId`, `effectId`. Fields: `kind` and, per kind, the recorded and
   * reported execution ids (`recordedExecutionId`, `reportedExecutionId`) or the
   * attempted and holding claim (`attemptedOwnerId`, `attemptedGeneration`,
   * `ownerId`, `generation`, `state`). No credential and no host text.
   * Caller: src/graph/host/execution-index.ts (confirmExecution).
   */
  "index.confirmation-refused": {
    level: "warn",
    channel: "graph:index",
    message:
      "a confirmation was refused by a fence or a recorded conflict; the recorded fact is unchanged",
  },

  /**
   * A delivery failure was reported without proof that no execution exists.
   * WARNING because nothing is released: the row stays `creating`, every lookup
   * answers `unknown`, and the effect is reported as unresolved rather than
   * re-dispatched.
   * Scope: `graphId`, `effectId`. Fields: none.
   * Caller: src/graph/host/execution-index.ts (release).
   */
  "index.release-unproven": {
    level: "warn",
    channel: "graph:index",
    message:
      "a delivery failure released nothing because no execution was proven absent; the row stays 'creating'",
  },

  // ── graph:tool — the tool binding around the host ─────────────────────────

  /**
   * The summary of one control follow-up (resumed, re-executed as a NEW run,
   * dispatched counts, refusals by code).
   * WARNING because the follow-up's effect must be visible — an operator
   * reading "resumed" has to be able to tell it from continuing the run that was
   * already there. Emitted only when there is something to report.
   * Scope: `graphId`. Fields: `kind`, `dispatched`, `refusals` (codes) and, for
   * a re-execution, `fromRunId`, `runId`, `runSeq`, `planRevision` — the run ids
   * stay FIELDS because the record's own run context is the graph, not the run
   * the re-execution minted.
   * Caller: src/graph/host/tool-binding.ts (reportControlContinuation).
   */
  "tool.control-continuation": {
    level: "warn",
    channel: "graph:tool",
    message: "control follow-up summary for the graph",
  },

  /**
   * The control follow-up (cancel delivery or retry continuation) threw.
   * WARNING because the durable cancel intent and every unconfirmed execution
   * stay visible, and the next boot sweep is the next window that delivers
   * them; the applied command is not turned into a failed tool result.
   * Scope: `graphId`. Fields: `failure`.
   * Caller: src/graph/host/tool-binding.ts (withCancelDelivery's catch).
   */
  "tool.control-follow-up-threw": {
    level: "warn",
    channel: "graph:tool",
    message:
      "the control follow-up threw; the durable cancel intent and every unconfirmed execution stay visible",
  },

  /**
   * The per-attempt result of one cancel delivery.
   * WARNING because only `confirmed` is the platform's own substantiation:
   * every other state leaves the execution visible and unsettled, and an
   * unconfirmed cancel is never reported as cancelled.
   * Scope: `graphId`. Fields: `blocked` (when the platform could not be asked)
   * and `entries`, one "attemptId:state" string per attempt.
   * Caller: src/graph/host/tool-binding.ts (reportCancelDelivery).
   */
  "tool.cancel-delivery": {
    level: "warn",
    channel: "graph:tool",
    message:
      "cancel delivery results per attempt; only 'confirmed' is the platform's own substantiation",
  },

  // ── graph:declare — the declaration tool ──────────────────────────────────

  /**
   * A declared graph's definition did not reach the graph store (including the
   * problem a GraphStoreFormatError names).
   * WARNING because the definition is not durable: the tool result's
   * `persisted: false` is how the caller learns it, and the store-level failure
   * is reported rather than masked.
   * Scope: `graphId`. Fields: `detail`.
   * Caller: src/graph/tools/declare-graph.ts (logDeclarePersistenceFailure).
   */
  "declare.persistence-failed": {
    level: "warn",
    channel: "graph:declare",
    message: "the graph definition did not reach the graph store",
  },

} as const satisfies Readonly<Record<string, LogEventDefinition>>;

/**
 * Every registered code, derived FROM the table so the vocabulary and the type
 * can never drift: a code that is not in {@link LOG_EVENTS} does not type check.
 */
export type LogEventCode = keyof typeof LOG_EVENTS;

/** True when `value` is a registered code. The runtime guard for JS callers. */
export function isLogEventCode(value: unknown): value is LogEventCode {
  return typeof value === "string" && Object.hasOwn(LOG_EVENTS, value);
}

/**
 * The registered definition for a code, or `undefined` when the code is not in
 * the table (which can only happen to a caller that bypasses the types).
 */
export function logEventDefinition(code: LogEventCode): LogEventDefinition {
  return LOG_EVENTS[code];
}
