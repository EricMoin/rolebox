// ── The closed event vocabulary ─────────────────────────────────────────────
//
// ONE TABLE OWNS EVERY EVENT'S LEVEL, CHANNEL AND SENTENCE. A diagnostic is an
// EVENT — a registered code plus fields that name ids, states, reasons and
// counts — and this table is the only place its level, its channel and its
// message are written down. A call site therefore cannot drift the wording of a
// stable diagnostic, and a code that is not registered here does not type check.
//
// WHAT THIS TABLE HOLDS (75 entries: 4 platform, 19 graph engine, 15 the
// engine slice registered in stage 4 — the graph notification outbox, the
// dispatch and the loop modules — 36 the core slice registered in the same
// stage: the service kernel and its composition, the restart supervisor, the
// health monitor, the dispatch and loop services, the hook pipelines and their
// registries, the recovery chain and engine, and the memory store, and 1 the
// logging compatibility shell's own field-narrowing report on `log:compat`)
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
// WHAT MAY OPT IN. An entry earns a `throttleMs` only when the log of a real
// workspace shows the SAME observation being re-reported in a loop — the counts
// live in the entry's own comment, and `bun scripts/log-event-density.ts` prints
// them for any log directory (records, the largest 60 s/10 s/1 s burst, how many
// records repeat their predecessor's fields, and how many records a window would
// let through). The window is chosen from the measured cadence: long enough to
// collapse the burst, short enough that a state that changes seconds later is
// still reported. AN ENTRY THAT REPORTS A FIRST FAILURE NEVER OPTS IN unless a
// subject dimension makes the first report of every DIFFERENT subject
// unlosable: an event whose whole value is "this just broke" (a store that
// cannot be written, a delivery with no proof, an unproven release, a definition
// that did not reach the store) keeps every occurrence.
//
// THE SUBJECT DIMENSION. A window is keyed by the channel, the code and — for an
// entry that declares `throttleBy` — a SUBJECT read from the record's own
// fields (src/log/throttle.ts). The subject is the thing a suppression would
// otherwise hide: the drifted code of an unknown-code report, the caller channel
// of a narrowing report. Each distinct subject holds its OWN window, so
// suppressing a repeat of subject A can never swallow the first report about
// subject B, and the `suppressed` count rides on the next record about the SAME
// subject. `throttleBy` must name a field the entry's callers actually pass with
// a string value; a misspelling would silently drop the subject dimension and
// re-create the cross-subject suppression, so the name is checked against the
// entry's own `Fields:` line by tests/log/throttle-policy.test.ts.
//
// ENTRIES MEASURED WITHOUT A FLOOD ARE STILL OPTED IN ONLY WHEN THE WINDOW
// CANNOT HIDE ANOTHER SUBJECT. `bun scripts/log-event-density.ts --dir
// .rolebox/logs` reports 12 codes in this workspace and neither of the two
// entries below has a single record there, so their windows are NOT earned by a
// measured burst: they are earned by being per-subject deduplicators — with the
// subject in the key, only an exact repeat about the same subject is ever
// suppressed, and what the window buys is the count of those repeats.
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
  /**
   * The FIELD NAME whose string value identifies the subject this window is
   * measured over, e.g. "code" for a record that names the drifted code it
   * reports, or "channel" for a record about one caller channel. The window is
   * keyed (channel, code, subject), so one subject's suppression never hides
   * another subject's first report and the `suppressed` count rides on the next
   * record about the same subject. A field that is absent, or whose value is not
   * a string, degrades to the empty subject — the pre-subject behaviour
   * (src/log/throttle.ts, logThrottleSubject).
   */
  readonly throttleBy?: string;
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
   * Fields: `event` and `code` (the dropped code, under both names — `code` is
   * the field the throttle subject reads), `dropped` and `count` (the kernel's
   * running count of dropped codes, the same number under both names) and
   * `suppressed` (on a record that had occurrences suppressed, how many
   * occurrences of THIS code its window dropped).
   * The counters are the kernel's own (getUnknownEventCodeCount), so no report
   * states a number the pipeline did not measure.
   * THROTTLED: 60s, keyed by SUBJECT — `throttleBy: "code"`, so the window that
   * one drifted code opens cannot swallow another drifted code's first report.
   * Evidence: the drift case is the window's reason for existing rather than a
   * measured burst — `bun scripts/log-event-density.ts --dir .rolebox/logs`
   * shows 12 codes in this workspace and this one has 0 records there, because
   * both the platform's own call sites and its vocabulary are closed. The
   * counter is nevertheless unbounded per subject (a call site that drifts into
   * a loop re-emits the same unknown code once per iteration), so the window
   * collapses an exact repeat about the SAME code into one line and the
   * suppressed occurrences ride on that code's next report. Distinct codes are
   * never suppressed by each other: the reviewer's probe
   * (.rolebox/tmp/rev12/throttle-subject-probe.ts) emits three different drifted
   * codes inside one window and now yields three records, one per code, each
   * naming its own code and carrying the true running total.
   */
  "log.event.unknown-code": {
    level: "warn",
    channel: "log",
    message: "an event code outside the closed vocabulary was dropped",
    throttleMs: 60_000,
    throttleBy: "code",
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
  //
  // STAGE 4 SECTIONS. The sections BELOW the graph engine block are the slices'
  // own, appended one section per channel as those diagnostics moved here. The
  // engine slice appended graph:notifications, dispatch:checkpoint, task:tools,
  // dispatch:notify, loop/worker-dispatch and loop/coordinator (fifteen entries,
  // every one a warning at its call site). The core slice then appended
  // plugin-core, plugin-hooks, service-supervisor, health-monitor,
  // loop-service, dispatch-service, hook-tool-after, hook-tool-before,
  // handler-drain, hook-sys-xform, hook:custom-registry, recovery:chain-executor,
  // recovery:engine, hook:context-window, recovery:builtin-registry and
  // memory:store (thirty-six entries: twenty-six warnings and the ten errors
  // whose call sites were errors — plugin-core.init-failed,
  // plugin-hooks.hook-service-unavailable, plugin-hooks.handlers-uninitialized,
  // service-supervisor.budget-exceeded, service-supervisor.permanently-degraded,
  // health-monitor.service-degraded, health-monitor.supervisor-error,
  // loop-service.state-load-failed, loop-service.state-reconcile-failed and
  // dispatch-service.recover-failed). The same rules hold — the level is the
  // level the call site had, the channel is the channel of the module that emits
  // it, identity travels in the scope where the scope vocabulary has a key for
  // it (a service, a hook, a function and a memory entry do not, so those stay
  // fields), and the fields keep only ids, states, reasons and counts.
  // The logging platform then closed the table with its own section,
  // `log:compat` (one entry), where the compatibility shell reports a value it
  // had to drop from a caller's fields. That report is a MIGRATION HINT rather
  // than a run failure — the record itself is written, the pipeline is healthy —
  // so it is the table's only `debug` entry.
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
   * THROTTLED: 10s, and this is the densest code the platform has. Measured on
   * the workspace's own log (`bun scripts/log-event-density.ts`): 335 records,
   * 74 of them inside ONE ten-second window, 20 inside one second, and 36
   * carrying exactly their predecessor's fields. The sweep re-derives the same
   * non-empty lists on every boot in a burst (a test run, a supervisor restarting
   * workers), so the burst is one observation repeated, not 74 observations. The
   * window is deliberately the SHORTEST of the throttled entries: a sweep only
   * runs at boot in a long-lived host, and a state that moves ten seconds later
   * must still produce its own line. Suppressed sweeps ride on the next record as
   * `suppressed`.
   */
  "sweep.summary": {
    level: "warn",
    channel: "graph:host",
    message: "declared-graph boot sweep summary",
    throttleMs: 10_000,
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
   * THROTTLED: 60s. Measured: 48 records carrying TWO distinct facts — 41 of them
   * repeat their predecessor's fields, with a median gap of 169 ms between
   * reports of the same unclaimed execution. `bindPlatformExecution` already
   * remembers one report per effect per PROCESS (`unboundReports`), so what the
   * log shows is the same refusal re-derived by the sweep and the completion path
   * across boots; one line per minute per code is the durable fact, and the
   * suppressed count rides on the next one.
   */
  "dispatch.unclaimed-confirmation": {
    level: "warn",
    channel: "graph:host",
    message:
      "the platform named an execution, but this process does not hold the claim that recorded the create; the durable row is not rewritten",
    throttleMs: 60_000,
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
   * THROTTLED: 60s. Measured: 93 records, 16 of them inside one second and 28
   * repeating their predecessor's fields — the same follow-up summary re-derived
   * while a control command is retried or continued across boots. A follow-up
   * that changes state still reports, because the window is measured from the
   * last EMITTED record; what it collapses is the repetition, and the count of
   * suppressed occurrences rides on the next record as `suppressed`.
   */
  "tool.control-continuation": {
    level: "warn",
    channel: "graph:tool",
    message: "control follow-up summary for the graph",
    throttleMs: 60_000,
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
   * THROTTLED: 60s. Measured: 66 records carrying seven distinct attempt states,
   * 21 of them repeating their predecessor's fields with a median gap of 21 ms —
   * a cancel delivery re-reported per attempt while the intent is delivered.
   * Only `confirmed` substantiates a cancel, and a state CHANGE is what an
   * operator must see, so the first record of each minute is kept and the
   * suppressed count rides on the next one.
   */
  "tool.cancel-delivery": {
    level: "warn",
    channel: "graph:tool",
    message:
      "cancel delivery results per attempt; only 'confirmed' is the platform's own substantiation",
    throttleMs: 60_000,
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

  // ── graph:notifications — the durable notification outbox ─────────────────

  /**
   * The graph's own view could not be read, so this capture pass produced no
   * notice for it.
   * WARNING because the notices for that graph are MISSING, not empty: the
   * caller remembers the graph and reports it once per unreadable stretch
   * rather than once per capture pass.
   * Scope: `graphId`. Fields: `error` (the read failure's text).
   * Caller: src/graph/application/graph-notifications.ts (capture).
   */
  "notifications.source-unreadable": {
    level: "warn",
    channel: "graph:notifications",
    message:
      "the graph's notification source could not be read, so this pass produced no notice for it",
  },

  /**
   * Renewing the lease of a claimed notification delivery failed.
   * WARNING because the claim is then no longer held for certain: another
   * owner may claim a delivery that is still running, and the delivery is left
   * to a later retry window.
   * Scope: `graphId`, `effectId` (the delivery's pending-effect row). Fields:
   * `error`.
   * Caller: src/graph/application/graph-notifications.ts (drain, the lease
   * renewal interval's catch).
   */
  "notifications.lease-renewal-failed": {
    level: "warn",
    channel: "graph:notifications",
    message:
      "renewing the notification delivery lease failed, so the delivery can be claimed again while it runs",
  },

  /**
   * The transport threw while a claimed notification delivery was sent.
   * WARNING because the notice was NOT delivered: the delivery returns to
   * `pending` with a backoff and is retried on a later window, and an
   * undelivered notice is exactly what has to stay visible.
   * Scope: `graphId`, `runId` (of the notice). Fields: `error`.
   * Caller: src/graph/application/graph-notifications.ts (drain).
   */
  "notifications.delivery-failed": {
    level: "warn",
    channel: "graph:notifications",
    message:
      "delivering a graph notification failed; the delivery stays pending and is retried on a later window",
  },

  // ── dispatch:checkpoint — the per-task checkpoint files ───────────────────

  /**
   * Rewriting a task's checkpoint file after its expired entries were dropped
   * failed.
   * WARNING because the cleanup did not land: the expired entries stay on disk
   * and the file keeps its size, while the task's live checkpoints are
   * untouched.
   * Scope: none (the checkpoint store is not a dispatch scope). Fields:
   * `taskId` — the file is `<taskId>.json`, which is where the caller takes it
   * from — and `error`.
   * Caller: src/dispatch/checkpoint/checkpoint-store.ts (cleanupExpired).
   */
  "checkpoint.rewrite-failed": {
    level: "warn",
    channel: "dispatch:checkpoint",
    message:
      "rewriting a task's checkpoint file after expired-entry cleanup failed, so the expired entries stay on disk",
  },

  // ── task:tools — the dispatch query tools ─────────────────────────────────

  /**
   * Reading a task's result preview failed while the task table was rendered.
   * WARNING because the row is reported with a placeholder instead of the
   * result: a missing preview must not read as the task's output.
   * Scope: none. Fields: `taskId`, `error`.
   * Caller: src/dispatch/query/task-tools.ts (getResultPreview).
   */
  "tools.result-preview-failed": {
    level: "warn",
    channel: "task:tools",
    message: "reading a task's result preview failed, so the row answers with a placeholder",
  },

  /**
   * Reopening a task for continuation (`task_retry`) failed.
   * WARNING because the retry did not start: the tool result carries the
   * failure, the original task keeps its terminal state, and the task id is
   * what the caller follows up with.
   * Scope: none. Fields: `taskId`, `error` (the thrown value's message).
   * Caller: src/dispatch/query/task-tools.ts (createTaskRetryTool).
   */
  "tools.retry-failed": {
    level: "warn",
    channel: "task:tools",
    message: "reopening a task for continuation failed, so the task was not retried",
  },

  // ── dispatch:notify — the parent-session notifier ─────────────────────────

  /**
   * Notifying a completed task's parent session failed after the retry ladder.
   * Both branches of the notifier report the same fact (the final reply and the
   * intermediate no-reply send).
   * WARNING because the parent was never told: the task is terminal while the
   * session waiting on it learns nothing, and the failure counter counts it.
   * Scope: `sessionId` (the parent session being notified). Fields: `taskId`,
   * `error` (the last failure's message).
   * Caller: src/dispatch/notification.ts (notifyParent).
   */
  "notify.parent-notify-failed": {
    level: "warn",
    channel: "dispatch:notify",
    message: "notifying a task's parent session failed after the retry ladder",
  },

  // ── loop/worker-dispatch — the loop's round dispatch ──────────────────────

  /**
   * Injecting the loop's started note into its origin session failed.
   * WARNING because the loop runs anyway: the first round is dispatched and
   * the session that started the loop is simply never told it began.
   * Scope: `sessionId` (the loop's origin session). Fields: `error`.
   * Caller: src/loop/worker-dispatch.ts (the loop-started note).
   */
  "worker-dispatch.started-note-failed": {
    level: "warn",
    channel: "loop/worker-dispatch",
    message: "injecting the loop's started note failed, so the origin session never sees the loop begin",
  },

  /**
   * Cancelling the loop's active round failed — at finalize and at failure.
   * WARNING because the worker task may still be running while the loop drops
   * its id from its own bookkeeping: the cancellation is unconfirmed, and the
   * worker task id is what an operator cancels by hand.
   * Scope: `sessionId` (the loop's origin session). Fields: `phase` (the
   * terminal phase the loop was entering), `workerTaskId`, `error`.
   * Caller: src/loop/worker-dispatch.ts (finalizeLoop, failLoop).
   */
  "worker-dispatch.round-cancel-failed": {
    level: "warn",
    channel: "loop/worker-dispatch",
    message:
      "cancelling the loop's active round failed, so the round is dropped from the loop's bookkeeping unconfirmed",
  },

  /**
   * Injecting the loop's error note into its origin session failed.
   * WARNING because a failed loop was not explained to the session that
   * started it; the loop state still carries the reason.
   * Scope: `sessionId` (the loop's origin session). Fields: `error`.
   * Caller: src/loop/worker-dispatch.ts (failLoop).
   */
  "worker-dispatch.error-note-failed": {
    level: "warn",
    channel: "loop/worker-dispatch",
    message: "injecting the loop's error note failed, so the origin session is not told why the loop failed",
  },

  // ── loop/coordinator — the loop coordinator ───────────────────────────────

  /**
   * The sweeper found an advancing lock held past its timeout and released it.
   * WARNING because the critical section that lock guarded was ABANDONED (an
   * exception escaped it without reaching its finally): the loop proceeds
   * again, and the age is how long that window was lost.
   * Scope: `sessionId` (the loop whose lock it was). Fields: `acquiredAgeMs`.
   * Caller: src/loop/coordinator.ts (_sweepStaleLocks).
   */
  "coordinator.stale-advancing-lock": {
    level: "warn",
    channel: "loop/coordinator",
    message: "a stale advancing lock was swept, so the loop's abandoned critical section no longer blocks it",
  },

  /**
   * Injecting a round progress note into the loop's origin session failed.
   * WARNING because the round advanced while the session that started the loop
   * was not told, and nothing retries the note.
   * Scope: `sessionId` (the loop's origin session). Fields: `error`.
   * Caller: src/loop/coordinator.ts (onWorkerCompleted).
   */
  "coordinator.progress-note-failed": {
    level: "warn",
    channel: "loop/coordinator",
    message: "injecting the loop's round progress note failed, so the origin session is not told the round advanced",
  },

  /**
   * Cancelling a child loop while a cancel cascaded through the parent failed.
   * WARNING because the child keeps running: the cascade goes on with the
   * remaining children, and the child id is what an operator cancels by hand.
   * Scope: `sessionId` (the parent loop). Fields: `childId`, `error`.
   * Caller: src/loop/coordinator.ts (cancelNow).
   */
  "coordinator.cascade-cancel-failed": {
    level: "warn",
    channel: "loop/coordinator",
    message: "cancelling a child loop during a cancel cascade failed; the child keeps running",
  },

  /**
   * Re-subscription could not advance a loop that was left in `summarizing`.
   * WARNING because the loop stays where it was: it is non-terminal and
   * nothing else pushes it, so it waits for the next re-subscription.
   * Scope: `sessionId` (the loop's origin session). Fields: `error`.
   * Caller: src/loop/coordinator.ts (reSubscribeListeners).
   */
  "coordinator.resubscribe-advance-failed": {
    level: "warn",
    channel: "loop/coordinator",
    message: "re-subscription failed to advance the loop out of summarizing, so it stays where it was",
  },

  /**
   * Reading the worker task's status during re-subscription failed.
   * WARNING because the loop is marked `interrupted` on that read: the phase
   * change is a decision rather than a guess, and the task id keeps it
   * followable.
   * Scope: `sessionId` (the loop's origin session). Fields: `taskId`, `error`.
   * Caller: src/loop/coordinator.ts (reSubscribeListeners).
   */
  "coordinator.task-status-read-failed": {
    level: "warn",
    channel: "loop/coordinator",
    message: "reading the loop's worker task status failed, so the loop is marked interrupted",
  },

  // ── plugin-core — the service kernel ──────────────────────────────────────
  // The kernel's own lifecycle diagnostics. A service is named by its
  // ServiceName (a closed union, src/core/service-names.ts); that name is the
  // entity these five report on, and the scope vocabulary has no key for it, so
  // it travels as the `service` FIELD — the same reason the engine events keep
  // an execution id and the checkpoint store keeps a task id.
  //
  // LEVELS ARE THE CALL SITES' OWN. Four of the five were warnings; the one that
  // was an error stays an error, because a service that never came up is a
  // degradation of a different weight from one that failed to dispose.

  /**
   * A service was registered twice under one name; the earlier registration is
   * replaced. The kernel's map is keyed by name, so the first object is dropped
   * without being disposed.
   * WARNING because a name collision silently discards a service instance and a
   * later lookup then answers with the replacement.
   * Scope: none. Fields: `service`.
   * Caller: src/core/plugin-core.ts (registerService).
   */
  "plugin-core.registration-replaced": {
    level: "warn",
    channel: "plugin-core",
    message:
      "a service was registered twice under the same name, so the earlier registration was replaced",
  },

  /**
   * A service was skipped because at least one of its dependencies is already
   * degraded.
   * WARNING because the skip is transitive: this service is now degraded too,
   * whether or not its own init would have worked, and the named dependency
   * list is what explains the cascade.
   * Scope: none. Fields: `service`, `degradedDeps`.
   * Caller: src/core/plugin-core.ts (init, the degraded-dependency guard).
   */
  "plugin-core.init-skipped": {
    level: "warn",
    channel: "plugin-core",
    message: "a service was skipped because one of its dependencies is degraded",
  },

  /**
   * An optional service's init threw; the kernel marks it permanently degraded
   * and goes on.
   * ERROR because the service is lost for the process lifetime while the rest of
   * the plugin keeps running: features that depend on it are silently absent.
   * The stack is NOT carried — the error's message is the reportable reason.
   * Scope: none. Fields: `service`, `error`.
   * Caller: src/core/plugin-core.ts (init, the optional-service catch).
   */
  "plugin-core.init-failed": {
    level: "error",
    channel: "plugin-core",
    message:
      "an optional service failed to initialize and is marked permanently degraded",
  },

  /**
   * A service threw while it was being disposed.
   * WARNING because disposal goes on with the remaining services: the failure is
   * contained, but whatever that service held was not released.
   * Scope: none. Fields: `service`, `error`.
   * Caller: src/core/plugin-core.ts (dispose).
   */
  "plugin-core.dispose-failed": {
    level: "warn",
    channel: "plugin-core",
    message:
      "a service threw while it was being disposed; the remaining services were still disposed",
  },

  /**
   * A restart was asked for a name no service is registered under.
   * WARNING because the caller's intent was dropped: the restart returns without
   * touching anything, and no service reports the miss on its own.
   * Scope: none. Fields: `service`.
   * Caller: src/core/plugin-core.ts (restartService, the lookup guard).
   */
  "plugin-core.restart-unknown-service": {
    level: "warn",
    channel: "plugin-core",
    message:
      "a service restart was refused because no service is registered under that name",
  },

  /**
   * A restart was asked for before the core had a context.
   * WARNING because the restart returns immediately: the service keeps whatever
   * state it had, and nothing else records that the request was dropped.
   * Scope: none. Fields: `service`.
   * Caller: src/core/plugin-core.ts (restartService, the context guard).
   */
  "plugin-core.restart-no-context": {
    level: "warn",
    channel: "plugin-core",
    message:
      "a service restart was refused because the core has no initialized context",
  },

  /**
   * A service threw while it was being disposed as the first half of a restart.
   * WARNING because the restart continues into init anyway: a service that could
   * not release its state is re-initialized over it.
   * Scope: none. Fields: `service`, `error`.
   * Caller: src/core/plugin-core.ts (restartService).
   */
  "plugin-core.restart-dispose-failed": {
    level: "warn",
    channel: "plugin-core",
    message:
      "a service threw while it was being disposed for a restart; the restart continued",
  },

  // ── plugin-hooks — the plugin composition ─────────────────────────────────

  /**
   * The composition asked the core for hook-service and got nothing back, so it
   * returns no-op handlers instead of undefined.
   * ERROR because every host hook is a no-op for that process: the plugin is
   * loaded but observes nothing, and the degraded-service list is the only trace
   * of why.
   * Scope: none. Fields: `degradedServices`.
   * Caller: src/core/composition.ts (createPluginHooks).
   */
  "plugin-hooks.hook-service-unavailable": {
    level: "error",
    channel: "plugin-hooks",
    message:
      "hook-service was never registered, so no-op handlers are returned to keep the host alive",
  },

  /**
   * hook-service exists but assembled no handlers (its init was skipped or
   * degraded), so the composition again falls back to no-op handlers.
   * ERROR for the same reason as the entry above: the process runs without
   * observing anything, and the failed service chain is what names the cause.
   * Scope: none. Fields: `degradedServices`, `failedServiceChain`.
   * Caller: src/core/composition.ts (createPluginHooks).
   */
  "plugin-hooks.handlers-uninitialized": {
    level: "error",
    channel: "plugin-hooks",
    message:
      "hook-service has no handlers (degraded or skipped init), so no-op handlers are returned to keep the host alive",
  },

  // ── service-supervisor — restart discipline ───────────────────────────────

  /**
   * A service reached the restart budget for the sliding window without a
   * successful restart, so the supervisor degrades it permanently.
   * ERROR because the decision is terminal for the process: no later health
   * check will restart that service again.
   * Scope: none. Fields: `service`, `attempts`, `windowMs`.
   * Caller: src/core/service-supervisor.ts (tryRestart, the budget guard).
   */
  "service-supervisor.budget-exceeded": {
    level: "error",
    channel: "service-supervisor",
    message:
      "a service exceeded its restart budget for the window and is permanently degraded",
  },

  /**
   * The restart attempt that exhausted the budget also threw, so the service is
   * permanently degraded after a failed restart rather than a stale counter.
   * ERROR because it is the same terminal decision as the entry above, reached
   * from the failure path; the last error names why the restart could not help.
   * Scope: none. Fields: `service`, `attempts`, `error`, `windowMs`.
   * Caller: src/core/service-supervisor.ts (tryRestart, the failed-restart
   * branch).
   */
  "service-supervisor.permanently-degraded": {
    level: "error",
    channel: "service-supervisor",
    message:
      "a service is permanently degraded after exhausting its restart attempts",
  },

  // ── health-monitor — the periodic health check ────────────────────────────

  /**
   * One health-check tick found a service reporting `unhealthy`, so a supervised
   * restart is attempted for it.
   * WARNING because the tick repeats: the service is still unhealthy at this
   * point, and the detail is the health function's own reason.
   * Scope: none. Fields: `service`, `detail`.
   * Caller: src/core/services/health-monitor-service.ts (checkAll).
   */
  "health-monitor.service-unhealthy": {
    level: "warn",
    channel: "health-monitor",
    message:
      "a service reported itself unhealthy, so a supervised restart was attempted",
  },

  /**
   * The restart decision did not rescue the service: the supervisor reports it
   * permanently degraded.
   * ERROR because the service is out for the rest of the process, and this is
   * the health monitor's own record of that verdict (the supervisor reports its
   * side separately).
   * Scope: none. Fields: `service`, `detail`.
   * Caller: src/core/services/health-monitor-service.ts (checkAll).
   */
  "health-monitor.service-degraded": {
    level: "error",
    channel: "health-monitor",
    message:
      "a service stayed permanently degraded after its restart attempts",
  },

  /**
   * The supervisor itself threw during a health-check tick.
   * ERROR because the restart pipeline is what failed — not the service — so the
   * tick could not act on that service at all, and the check cycle continues
   * with the remaining ones.
   * Scope: none. Fields: `service`, `error`.
   * Caller: src/core/services/health-monitor-service.ts (checkAll).
   */
  "health-monitor.supervisor-error": {
    level: "error",
    channel: "health-monitor",
    message:
      "the service supervisor threw during a health-check cycle; the cycle continued with the remaining services",
  },

  // ── loop-service — the loop service ───────────────────────────────────────

  /**
   * The loop service came up degraded and exposes stub loop tools instead of a
   * coordinator.
   * WARNING because the service is registered and answers health as degraded:
   * the reason field distinguishes "dispatch never initialized" from "this
   * platform cannot dispatch", while the loop capability itself is absent.
   * Scope: none. Fields: `reason`.
   * Caller: src/core/services/loop-service.ts (init, the three degradation
   * branches — one code, because the decision is the same and only the reason
   * differs).
   */
  "loop-service.degraded": {
    level: "warn",
    channel: "loop-service",
    message:
      "the loop service came up degraded, so it exposes stub tools instead of a coordinator",
  },

  /**
   * Reading the persisted loop state failed, so the service starts with an empty
   * coordinator.
   * ERROR because persisted loops are not restored: running loops become
   * invisible to the coordinator until they are re-created.
   * Scope: none. Fields: `error`.
   * Caller: src/core/services/loop-service.ts (init, store.load()).
   */
  "loop-service.state-load-failed": {
    level: "error",
    channel: "loop-service",
    message:
      "reading the persisted loop state failed, so the service starts with an empty coordinator",
  },

  /**
   * Reconciling the loaded loop state against dispatch failed, so the service
   * falls back to an empty coordinator.
   * ERROR because the loop state read from disk is discarded rather than
   * reconciled, which is the same loss as a failed load.
   * Scope: none. Fields: `error`.
   * Caller: src/core/services/loop-service.ts (init, store.reconcile()).
   */
  "loop-service.state-reconcile-failed": {
    level: "error",
    channel: "loop-service",
    message:
      "reconciling the persisted loop state with dispatch failed, so the service uses an empty coordinator",
  },

  // ── dispatch-service — the dispatch service ───────────────────────────────

  /**
   * The dispatch service came up degraded because the platform cannot create
   * sessions and no session client was injected, so it exposes stub dispatch
   * tools.
   * WARNING because this is the platform's declared capability rather than a
   * failure: the degradation is expected on that platform, and the platform id
   * names which one.
   * Scope: none. Fields: `platformId`.
   * Caller: src/core/services/dispatch-service.ts (init, the capability guard).
   */
  "dispatch-service.degraded": {
    level: "warn",
    channel: "dispatch-service",
    message:
      "the dispatch service came up degraded because this platform cannot create sessions, so it exposes stub tools",
  },

  /**
   * Recovering the dispatch manager failed, so the service continues with empty
   * state.
   * ERROR because the persisted tasks are not restored: dispatch starts from
   * nothing while the state file still holds the previous run.
   * Scope: none. Fields: `error`.
   * Caller: src/core/services/dispatch-service.ts (init).
   */
  "dispatch-service.recover-failed": {
    level: "error",
    channel: "dispatch-service",
    message:
      "recovering the dispatch manager failed, so the service continues with empty state",
  },

  /**
   * Flushing the dispatch state failed — at dispose or at process exit.
   * WARNING because the failure is contained: the process is going away anyway,
   * and what is lost is the last write, not the service. The `phase` field keeps
   * the two call sites distinguishable.
   * Scope: none. Fields: `phase` ("dispose" | "exit"), `error`.
   * Caller: src/core/services/dispatch-service.ts (dispose, flushPersistSync).
   */
  "dispatch-service.flush-failed": {
    level: "warn",
    channel: "dispatch-service",
    message:
      "flushing the dispatch state failed, so the pending writes did not land",
  },

  // ── hook-tool-after — the tool.execute.after pipeline ─────────────────────

  /**
   * The function OBSERVE tier threw while it was reading a tool result.
   * WARNING because the result was left unobserved: the observe side effects and
   * injections for that call did not happen, and the tool call itself already
   * succeeded.
   * Scope: `sessionId`. Fields: `error`.
   * Caller: src/hooks/tool-after.ts (handleToolAfter).
   */
  "tool-after.observe-failed": {
    level: "warn",
    channel: "hook-tool-after",
    message:
      "running the function observe tier for a tool result failed; the result was left unobserved",
  },

  /**
   * A function's after-handler threw while it was being run for a tool result.
   * WARNING because the handler's effect was skipped — the functions after it in
   * the same pass still run — and the tool call itself is unaffected.
   * Scope: `sessionId`. Fields: `error`.
   * Caller: src/hooks/tool-after.ts (handleToolAfter).
   */
  "tool-after.handler-failed": {
    level: "warn",
    channel: "hook-tool-after",
    message:
      "running a function's after-handler for a tool result failed; the handler's effect was skipped",
  },

  // ── hook-tool-before — the tool.execute.before pipeline ───────────────────

  /**
   * A tool that was registered as deprecated was invoked.
   * WARNING because the invocation goes through unchanged: the record is the
   * only signal that a retired tool is still in use, and it repeats on every
   * call. The tool name is IDENTITY and travels in the scope; the deprecation
   * hint is data and is omitted for a tool registered without one.
   * Scope: `sessionId`, `tool`. Fields: `deprecation`.
   * Caller: src/hooks/tool-before.ts (handleToolBefore).
   */
  "tool-before.deprecated-tool": {
    level: "warn",
    channel: "hook-tool-before",
    message: "a deprecated tool was invoked",
  },

  // ── handler-drain — draining a function handler's context ─────────────────

  /**
   * A handler's injections passed the per-call byte cap, so the rest were
   * dropped.
   * WARNING because the model's context is missing part of what the handler
   * wanted to inject; the cap keeps one handler from flooding the session, and
   * the function name stays followable.
   * Scope: `sessionId`. Fields: `fn`.
   * Caller: src/hooks/drain-handler.ts (drainHandlerContext).
   */
  "handler-drain.inject-cap-reached": {
    level: "warn",
    channel: "handler-drain",
    message:
      "a handler's injections exceeded the per-call byte cap, so the remaining injections were dropped",
  },

  /**
   * A handler asked to activate more functions than the per-call cap allows, so
   * the rest were not activated.
   * WARNING because the skipped activations never run, while the ones under the
   * cap were activated normally.
   * Scope: `sessionId`. Fields: `fn`.
   * Caller: src/hooks/drain-handler.ts (drainHandlerContext).
   */
  "handler-drain.activation-cap-reached": {
    level: "warn",
    channel: "handler-drain",
    message:
      "a handler requested more activations than the per-call cap, so the remaining activations were dropped",
  },

  // ── hook-sys-xform — the system-prompt transform ──────────────────────────

  /**
   * Reading the memory store and injecting its block into the system prompt
   * failed.
   * WARNING because the prompt is still sent: the session simply runs without
   * the recalled memories for that turn.
   * Scope: `sessionId`. Fields: `error`.
   * Caller: src/hooks/system-transform.ts (handleSystemTransform).
   */
  "sys-xform.memory-inject-failed": {
    level: "warn",
    channel: "hook-sys-xform",
    message:
      "injecting the memory block into the system prompt failed; the prompt was left without it",
  },

  // ── hook:custom-registry — the custom hook registry ───────────────────────

  /**
   * A custom hook's `onLoad` threw.
   * WARNING because the hook stays registered: it will be invoked on its events,
   * and whatever onLoad was meant to prepare is now missing.
   * Scope: none (onLoad runs at registration, before any session is bound).
   * Fields: `hook`, `error`.
   * Caller: src/hooks/custom/registry.ts (register).
   */
  "custom-registry.on-load-failed": {
    level: "warn",
    channel: "hook:custom-registry",
    message: "a custom hook's onLoad threw; the hook is still registered",
  },

  /**
   * A custom hook threw while handling an event.
   * WARNING because the event continues to the remaining hooks and the session
   * is not disturbed; the named hook's contribution for that event is lost.
   * Scope: `sessionId` when the hook context carries one. Fields: `hook`,
   * `event`, `error`.
   * Caller: src/hooks/custom/registry.ts (runHooks).
   */
  "custom-registry.hook-failed": {
    level: "warn",
    channel: "hook:custom-registry",
    message:
      "a custom hook threw while handling an event; the remaining hooks still ran",
  },

  /**
   * A custom hook's `onDispose` threw during registry disposal.
   * WARNING because disposal continues with the remaining hooks: one hook's
   * cleanup did not run, and the process is shutting down anyway.
   * Scope: none. Fields: `hook`, `error`.
   * Caller: src/hooks/custom/registry.ts (dispose).
   */
  "custom-registry.on-dispose-failed": {
    level: "warn",
    channel: "hook:custom-registry",
    message:
      "a custom hook's onDispose threw; disposal went on with the remaining hooks",
  },

  // ── recovery:chain-executor — the recovery chain ──────────────────────────

  /**
   * A recovery chain names a strategy that is not registered, so the step is
   * skipped.
   * WARNING because the chain continues with the next step: the session gets a
   * chain that is shorter than configured, and nothing else reports the gap.
   * Scope: `sessionId`. Fields: `strategy`.
   * Caller: src/recovery/chain-executor.ts (executeChain).
   */
  "chain-executor.strategy-missing": {
    level: "warn",
    channel: "recovery:chain-executor",
    message:
      "a recovery chain names a strategy that is not registered, so the step was skipped",
  },

  /**
   * A recovery strategy threw while it was executing, so the chain moves to the
   * next strategy.
   * WARNING because the attempt is not lost — it is recorded and the chain goes
   * on — but the strategy's own remedy did not run.
   * Scope: `sessionId`. Fields: `strategy`, `error`.
   * Caller: src/recovery/chain-executor.ts (executeChain).
   */
  "chain-executor.strategy-threw": {
    level: "warn",
    channel: "recovery:chain-executor",
    message:
      "a recovery strategy threw, so the chain moved to the next strategy",
  },

  // ── recovery:engine — the recovery engine ─────────────────────────────────

  /**
   * A recovery chain was aborted, so the session stays unrecovered.
   * WARNING because the engine hands the failure back to its caller: the reason
   * and the attempt count are what the caller's decision is based on.
   * Scope: `sessionId`. Fields: `reason`, `totalAttempts`.
   * Caller: src/recovery/engine.ts (recover).
   */
  "engine.aborted": {
    level: "warn",
    channel: "recovery:engine",
    message:
      "the recovery chain was aborted, so the session stays unrecovered",
  },

  /**
   * Every strategy in a recovery chain was tried without recovering the session.
   * WARNING because the session stays unrecovered while the engine returns a
   * normal "not recovered" result: the exhaustion is the operator's signal, not
   * an exception.
   * Scope: `sessionId`. Fields: `reason`, `totalAttempts`.
   * Caller: src/recovery/engine.ts (recover).
   */
  "engine.exhausted": {
    level: "warn",
    channel: "recovery:engine",
    message:
      "the recovery chain was exhausted, so the session stays unrecovered",
  },

  // ── hook:context-window — the context-window monitor ──────────────────────

  /**
   * A tool returned an output large enough that the monitor considers the
   * context window under pressure.
   * WARNING because the same tool can do it again on every call: the sizes are
   * what the follow-up decision is made from, and the tool and session are
   * identity.
   * Scope: `sessionId`, `tool`. Fields: `charLength`, `estimatedTokens`.
   * Caller: src/recovery/builtin/context-window-monitor.ts (onToolAfter).
   */
  "context-window.large-output": {
    level: "warn",
    channel: "hook:context-window",
    message:
      "a tool returned an output large enough to put the context window under pressure",
  },

  // ── recovery:builtin-registry — the built-in hook registry ────────────────

  /**
   * A built-in recovery hook threw while it was handling an event.
   * WARNING because the registry continues with the remaining hooks: one hook's
   * recovery attempt did not happen, and the hook name and event name it.
   * Scope: none (the context is built per hook and this registry reports the
   * hook, not a session). Fields: `hook`, `event`, `error`.
   * Caller: src/recovery/builtin/registry.ts (runHooks).
   */
  "builtin-registry.hook-failed": {
    level: "warn",
    channel: "recovery:builtin-registry",
    message:
      "a built-in recovery hook threw while handling an event; the remaining hooks still ran",
  },

  // ── memory:store — the memory store ───────────────────────────────────────

  /**
   * Reading one memory entry by id failed, so the caller is answered with no
   * entry.
   * WARNING because "absent" and "unreadable" look the same to the caller: the id
   * is what makes the failed read distinguishable, and it is a FIELD because the
   * scope vocabulary carries sessions, not memory entries.
   * Scope: none. Fields: `id`, `error`.
   * Caller: src/memory/store.ts (read).
   */
  "store.read-failed": {
    level: "warn",
    channel: "memory:store",
    message:
      "reading a memory entry by id failed, so the caller is answered with no entry",
  },

  // ── log:compat — the logging compatibility shell ──────────────────────────
  //
  // The table's LAST section belongs to the platform itself rather than to a
  // caller: src/logger.ts is the translation layer the legacy call sites still
  // import, and this entry is how a value that layer had to drop becomes visible
  // instead of silent. The channel names the SOURCE, not the code's prefix,
  // which is why it is `log:compat` and not `log`: an operator can follow the
  // shell's own reports in <logDir>/log-compat.log beside the pipeline's
  // failures on `log`.

  /**
   * The compatibility shell dropped a caller's value because the kernel's field
   * type does not admit it — an object, a nested array, a mixed array, a
   * function — so the record is written without that key.
   * DEBUG because the record itself is still produced and the pipeline is
   * healthy: this is a hint that a call site still passes data the record may
   * not carry, not a failure of the run. It is the table's only debug entry for
   * that reason.
   * The VALUE is never carried — it is precisely what could not be recorded —
   * only the keys it was dropped under.
   * Caller: src/logger.ts (the level helpers' field adaptation).
   * Fields: `channel` (the channel the call site logged on, so an operator knows
   * which source to fix) and `keys` (the dropped key names, in call order and
   * de-duplicated; an argument that cannot become a field is named by the
   * positional key it would have had — "arg1", "arg2", …).
   * A record that had occurrences suppressed also carries `suppressed`, the
   * pipeline's own count (see THROTTLED below).
   * THROTTLED: 60s, keyed by SUBJECT — `throttleBy: "channel"`, the caller
   * channel this record already carries, so the window is per caller CHANNEL,
   * not per call site: call sites that log on the SAME channel share its window,
   * which is what keeps one source narrowing on every record from swallowing
   * another source's first report (the pre-subject window was the single channel
   * `log:compat`, i.e. one window for the whole process).
   * Evidence: `bun scripts/log-event-density.ts --dir .rolebox/logs` shows 12
   * codes in this workspace and 0 records for this one — it is emitted at
   * `debug` while the workspace runs at the default `info`, so no measured burst
   * exists here and the window is not claimed to be earned by one. What it
   * collapses is the repetition the report itself describes: a call site that
   * narrows a value on every record emits this event on every record, so the
   * per-caller-channel window turns that unbounded emission into one line per
   * caller channel per minute, with the suppressed occurrences riding on that
   * caller channel's next report as `suppressed`.
   */
  "log.field.narrowed": {
    level: "debug",
    channel: "log:compat",
    message:
      "a field value the kernel's field type does not admit was dropped from the record",
    throttleMs: 60_000,
    throttleBy: "channel",
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
