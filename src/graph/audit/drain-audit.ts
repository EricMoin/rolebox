/**
 * Graph Execution Engine v2 — Read-only drain / migration audit (E stage entry)
 *
 * Version: 2.0
 * Date: 2026-09-23
 *
 * The read-only inventory of the workspace's ONE graph store, kept after the
 * legacy execution path was retired: it is how a store is shown to hold nothing
 * the deleted runtime would have been needed for. One total, read-only inventory
 * of the store, in which every declared graph is
 *
 * - `terminal` — readable and quiescent: the record takes no further step;
 * - `in-flight` — readable and still owed work: the outcome run path has
 *   not finished it; or
 * - `blocked` — the record cannot be read, its definition fails a gate, or
 *   its run-state row is not the state the strict reader accepts. Every blocked
 *   entry is a BLOCKER for the drain decision and is listed individually — it is
 *   never folded into a count and never ignored.
 *
 * THE UNIVERSE IS THE STORE, NOT A DIRECTORY OF FILES (P1 item 5). The audit
 * used to list `engine-*.json` and classify each through the v2 container
 * loader. That container is no longer written, so the inventory is now the
 * `graph_definitions` table of `graph-acceptance-ledger.sqlite`, and each
 * graph is classified from its DEFINITION plus its `ledger_graph_state` row
 * and its `ledger_pending_effects` rows — all read from the same open
 * store. The retired per-graph container is never a record this audit
 * interprets: a non-empty one found where the previous layout kept it is
 * reported as a `retired-state-record` blocker that names the file (plan
 * §P6.4), and one beside the store itself makes the store `unsupported` at
 * the gate.
 *
 * STRICTLY READ-ONLY, BY CONSTRUCTION. Nothing here writes a graph, a state row,
 * a definition row or a file: the store is opened through
 * `loadGraphStoreSync`, which runs the format gate and hands back a handle
 * whose connection refuses every write at the SQLite layer. A store the gate
 * refuses — a foreign file, a zero-byte file, an unknown format, a retired
 * authority beside it, a WAL-mode store whose read-only open would rewrite its
 * `-shm` side file — is refused BEFORE a row is read and reported as a
 * blocker, so the no-write promise holds for every store, not only the ones this
 * build writes. A store that does not exist is `absent`, which is a reading
 * and never a licence to initialize one.
 *
 * TERMINAL MEANS QUIESCENT, AND THE PHASE IS ALWAYS REPORTED. A run is terminal
 * when its phase is `complete` OR `stopped`: a stopped run is
 * deliberately NOT `complete` (it was cut short by a declared hard limit or
 * progress threshold), but it refuses every further advance and launches nothing
 * on recovery, so it takes no further step and is migration-quiescent. The entry
 * carries the exact `phase` and, for a stop, its reason and description, so
 * "cut short" is never read as "finished" and the audit's judgement stays
 * checkable.
 *
 * IN-FLIGHT IS MORE THAN "NOT TERMINAL". A readable entry is in flight when it
 * is not quiescent: a definition whose run-state row is `ready` /
 * `executing`, or one whose store holds no run-state row yet — nothing has
 * ever committed one, so the graph's first execution is still owed and the run
 * path (not the audit) is what performs it. The entry names the WORK, not just
 * the phase: every node the run state records as in flight, with its attempt,
 * and every effect still `pending` or `started`.
 *
 * UNSETTLED EFFECTS ARE REPORTED FOR EVERY READABLE GRAPH, terminal or not. An
 * effect a process left `started` is real outstanding work even when the
 * graph around it finished, so it is listed rather than filtered by phase — and
 * it holds the verdict below open even when the graph count alone would look
 * drained.
 *
 * THE VERDICT IS NOT A COUNT. `drained` requires BOTH halves: no blocker
 * AND no in-flight graph AND no unsettled effect. A store with zero non-terminal
 * graphs but one unreadable definition, or one `started` effect nobody
 * settled, is NOT drained — it is `blocked` or `in-flight`
 * respectively. That is the whole point of the report: "nothing looked
 * non-terminal" is not evidence that the store is quiescent.
 *
 * THE IN-FLIGHT SET IS DECIDABLE, NOT MERELY COUNTED (E gate, step 1). "Six
 * graphs are in flight" cannot be acted on; "six records with nothing queued and
 * no state update for 9 to 13 days" can. Every readable in-flight entry carries
 * a `staleness` block — the record's own last update, its age, the
 * threshold that was applied, the queue facts and the inference — and
 * `totals` splits the in-flight count into `staleLocks` /
 * `activelyExecuting`. It is an INFERENCE with a stated basis, never a
 * write: a stale lock is reported, never resolved, and the verdict rules above
 * are unchanged.
 *
 * Dependency note: this module reads the store, the domain loader verdict and
 * the outcome state reader, and imports no run path. It dispatches nothing,
 * recovers nothing, migrates nothing and compiles nothing.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { errorText } from "../../utils/error-text.ts";
import {
  describeOutcomeStop,
  readOutcomeGraphState,
  type OutcomeGraphState,
  type OutcomeStop,
} from "../outcome/graph-state.ts";
import { ledgerFilePath } from "../ledger/sqlite-ledger.ts";
import type { EffectStatus, PendingEffectRecord } from "../ledger/types.ts";
import { engineStateDir } from "../persistence/engine-persistence.ts";
import {
  decodeStoredDefinition,
  describeStoreVerdict,
  type StoredDeclaredGraph,
} from "../persistence/declared-record.ts";
import {
  RETIRED_AUTHORITY_PREFIX,
  RETIRED_AUTHORITY_SUFFIX,
} from "../store/schema.ts";
import { loadGraphStoreSync, type GraphStoreLoadResult } from "../store/load.ts";
import type { GraphStore } from "../store/graph-store.ts";

// ── Blocker vocabulary ──────────────────────────────────────────────────────

/**
 * Everything that makes one graph unusable as drain evidence. A CLOSED
 * vocabulary: each code names one condition the audit decided from the store
 * itself, so a caller branches on the code instead of parsing a message.
 *
 * - `state-store-unreadable` — the store could not be listed at all;
 *   nothing was audited. The verdict's own text rides in `detail`.
 * - `retired-state-record` — a NON-EMPTY retired per-graph v2 container
 *   (`engine-<slug>.json`) is still present where the previous layout kept
 *   it. This build neither reads nor converts it, so its graph must be
 *   inventoried and archived by an operator before the workspace can be called
 *   drained (plan §P6.4). The blocker names the file.
 * - `corrupt-record` — the authoritative store exists but is not a store
 *   this build can read (a foreign file, a zero-byte file, a reshaped layout).
 *   `dimension` names the violated axis.
 * - `unsupported-version` — a well-formed store format this build has no
 *   decoder for (newer, older, unknown). `dimension` names the axis.
 * - `unrunnable-definition` — the store holds a definition row for this
 *   graph that fails a decode gate: the declaration is not a strict v3
 *   declaration, its digest does not address its content, or the persisted plan
 *   is a draft, malformed, or disagrees with its binding. The detail names the
 *   gate.
 * - `ledger-refused` / `ledger-unreadable` — the store exists but
 *   this build may not read it (foreign / unknown / newer / older / reshaped
 *   format), or could not be opened. Every definition's run state is in that
 *   store, so every graph is a blocker.
 * - `state-plan-mismatch` / `state-version-unsupported` /
 *   `state-malformed` / `state-unreadable` — the store's run-state
 *   row for this graph is not the state the strict reader accepts: bound to
 *   another plan revision, written in a body version this build has no reader
 *   for, malformed, or refused by an unexpected error — including an effect-row
 *   read the store's own gate threw on, which is contained here rather than
 *   escaping.
 */
export type DrainAuditBlockerCode =
  | "state-store-unreadable"
  | "retired-state-record"
  | "corrupt-record"
  | "unsupported-version"
  | "unrunnable-definition"
  | "ledger-refused"
  | "ledger-unreadable"
  | "state-plan-mismatch"
  | "state-version-unsupported"
  | "state-malformed"
  | "state-unreadable";

/** The axis a blocker belongs to, when one owns it. */
export type DrainAuditBlockerDimension =
  | "storage"
  | "contract"
  | "ledger"
  | "outcome-state";

/** One reason a graph cannot be used as drain evidence. */
export interface DrainAuditBlocker {
  readonly code: DrainAuditBlockerCode;
  /** The axis that owns the condition; absent when none does. */
  readonly dimension?: DrainAuditBlockerDimension;
  /** What was found. Wording is not API; the code is. */
  readonly detail: string;
  /** The graph id the blocker belongs to, when one was readable. */
  readonly graphId?: string;
  /** The retired container file the blocker names, when it is one. */
  readonly file?: string;
}

// ── Report model ────────────────────────────────────────────────────────────

/** The protocol an entry is bound to, as far as the audit could read it. */
export type DrainAuditProtocol = "outcome" | "unknown";

/** The three-way classification the drain decision reads. */
export type DrainAuditClassification = "terminal" | "in-flight" | "blocked";

/**
 * How long a readable in-flight record must have gone without a state update
 * before the audit will call it a STALE LOCK rather than work that may still be
 * moving. It is the whole threshold — nothing else in this module hard-codes an
 * idle duration — and every entry reports the value that was applied
 * ({@link DrainAuditStalenessFacts.staleAfterMs}), so a reader can recompute the
 * classification by hand instead of trusting it.
 *
 * THE BASIS, stated so it can be argued with rather than guessed at:
 *
 * - A live run commits its run state SYNCHRONOUSLY with every acceptance, so the
 *   only window in which a running graph produces no state update is while a
 *   dispatched task is executing. Silence is therefore evidence, not noise.
 * - The build's own liveness rule is that a `running` node past its
 *   staleness deadline is dead: `DEFAULT_NODE_STALE_TIMEOUT_MS` is 15
 *   minutes and the tool surface configures it on every engine it builds,
 *   persisting a `timeout` transition when it fires. A record older than
 *   that deadline, with nothing queued, is one whose own watchdog never fired —
 *   which is what a process that is no longer alive looks like.
 * - 24 hours is 96x that default deadline. The multiple is deliberate: a node
 *   may declare a `budget.timeout_ms` longer than the default, and a
 *   single long dispatch is the one legitimate reason for silence, so the
 *   threshold is set far above any plausible single task rather than just above
 *   the default.
 * - It is a JUDGEMENT, not a protocol invariant, and it is not derived from the
 *   store it is applied to. For the reading that motivated it — records 9 to 13
 *   days old — it is decisive with two orders of magnitude to spare, and a
 *   caller that disagrees passes its own value through
 *   {@link DrainAuditOptions.staleAfterMs} rather than editing this module.
 */
export const STALE_LOCK_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a readable in-flight record looks dead or may still be moving.
 *
 * This is an INFERENCE from the facts below, never a rewrite: the audit reads
 * the store and changes nothing, so a `stale-lock` verdict resolves no
 * lock, re-dispatches nothing and deletes nothing. It answers one question and
 * only that one — "is any live process plausibly advancing this record?":
 *
 * - `stale-lock` — nothing is queued (no armed attempt and no unsettled
 *   effect) AND the last state update is at least
 *   {@link STALE_LOCK_IDLE_THRESHOLD_MS} old. No live run is advancing it.
 * - `actively-executing` — something is queued OR the last update is
 *   inside the threshold. The audit REFUSES to call this dead; that is not the
 *   same as observing a live process, and the facts that decided it stay on the
 *   entry.
 */
export type DrainAuditStaleness = "stale-lock" | "actively-executing";

/**
 * The staleness reading for one readable in-flight record: the inference, the
 * threshold applied, and every fact it was drawn from.
 *
 * Present exactly on a readable `in-flight` entry — never on a
 * `terminal` one (it takes no further step, so there is no lock to judge)
 * and never on a `blocked` one (nothing about it is known well enough to
 * infer anything; the blocker is the answer).
 */
export interface DrainAuditStalenessFacts {
  /** Epoch ms of the record's own last state update, as persisted. */
  readonly lastUpdatedAt: number;
  /**
   * How long ago that was, in ms. Clamped at 0: a timestamp in the future
   * (clock skew between the writing and reading process) is reported as "just
   * now", never as a negative age that would read as ancient.
   */
  readonly idleMs: number;
  /** The threshold this entry was classified against. */
  readonly staleAfterMs: number;
  readonly staleness: DrainAuditStaleness;
  /** Whether the record holds work the engine has not consumed. */
  readonly hasQueuedWork: boolean;
}

/** One node the run state records as in flight. */
export interface DrainAuditArmedNode {
  readonly nodeId: string;
  /** The attempt a submission must settle (never the credential). */
  readonly attemptId: string;
}

/** One effect the store still records `pending` or `started`. */
export interface DrainAuditEffect {
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly status: EffectStatus;
}

/** The persisted stop an outcome run ended on. */
export interface DrainAuditStop {
  readonly reason: string;
  /** The one shared formatter's description of the stop. */
  readonly summary: string;
}

/** One graph's audited record. */
export interface DrainAuditEntry {
  /** The graph id this entry was read from — the store's own key. */
  readonly graphId: string;
  readonly protocol: DrainAuditProtocol;
  readonly classification: DrainAuditClassification;
  /** The persisted phase, exactly as recorded. */
  readonly phase?: string;
  /** The definition's own content-addressed plan revision. */
  readonly planRevision?: string;
  /** Outcome only: nodes the run state records as in flight. */
  readonly armed?: readonly DrainAuditArmedNode[];
  /** Outcome only: effects still `pending` or `started`. */
  readonly unsettledEffects?: readonly DrainAuditEffect[];
  /** Outcome only: present exactly when the run ended on a declared stop. */
  readonly stop?: DrainAuditStop;
  /**
   * Outcome only: whether the store holds a run-state row for this graph.
   * `false` means the first execution is still owed, not that the state
   * was lost and not that it is unreadable — a state this build cannot read is
   * a blocker.
   */
  readonly hasState?: boolean;
  /**
   * In-flight only: the stale-lock inference and the facts behind it. Absent on
   * a terminal entry (quiescent, so no lock exists) and on a blocked one
   * (unreadable, so nothing may be inferred).
   */
  readonly staleness?: DrainAuditStalenessFacts;
  /** Every blocker code observed for this entry, in report order. */
  readonly blockerCodes: readonly DrainAuditBlockerCode[];
}

/** The store-level reading the report is built on. */
export type DrainAuditLedgerStatus = "opened" | "absent" | "refused" | "unreadable";

/** Counts, including the ones the three-way partition does NOT carry. */
export interface DrainAuditTotals {
  /** Definitions found in the store. */
  readonly graphs: number;
  /** Readable and quiescent. */
  readonly terminal: number;
  /** Readable with work still owed. */
  readonly inFlight: number;
  /** Unreadable or refused by a gate. */
  readonly blocked: number;
  /** Of the in-flight entries, those bound to the outcome protocol. */
  readonly outcomeInFlight: number;
  /**
   * Of the in-flight entries, those the staleness inference calls
   * `stale-lock`: nothing queued and no state update for at least the
   * applied threshold. A count of READABLE records, not a write: the audit
   * resolves no lock and retires nothing.
   */
  readonly staleLocks: number;
  /**
   * Of the in-flight entries, those it refuses to call dead — something is
   * queued or the last update is inside the threshold. `staleLocks` and
   * this field always sum to {@link inFlight}, which is what makes the pair
   * checkable rather than merely informative.
   */
  readonly activelyExecuting: number;
  /** Unsettled effects across every outcome entry, terminal included. */
  readonly unsettledEffects: number;
  /** Blocker count per code, over the whole report. */
  readonly blockersByCode: Readonly<Record<string, number>>;
}

/**
 * The drain verdict.
 *
 * `drained` requires all three: no blocker, no in-flight graph and no
 * unsettled effect. `blocked` wins over `in-flight`: an unreadable
 * record could be anything, and the drain decision must resolve it before it can
 * be called safe.
 */
export type DrainAuditVerdict = "drained" | "in-flight" | "blocked";

/** The whole audit. Every array is in deterministic store order. */
export interface DrainAuditReport {
  /** The workspace directory the audit was addressed to. */
  readonly directory: string;
  /** The store directory actually read. */
  readonly storeDirectory: string;
  /** The authoritative store file path (reported even when it is absent). */
  readonly ledgerFilePath: string;
  readonly ledger: DrainAuditLedgerStatus;
  /** One entry per stored definition, sorted by graph id. */
  readonly entries: readonly DrainAuditEntry[];
  /** Every blocker, store-level and per-entry, in report order. */
  readonly blockers: readonly DrainAuditBlocker[];
  readonly totals: DrainAuditTotals;
  readonly verdict: DrainAuditVerdict;
  /** `true` exactly when the verdict is `drained`. */
  readonly drained: boolean;
}

/** Inputs for {@link auditGraphStore}. */
export interface DrainAuditOptions {
  /** Workspace directory the audit is addressed to (names the report). */
  readonly directory: string;
  /**
   * The directory the graph store is opened from. Defaults to the workspace
   * state directory (`engineStateDir(directory)`).
   *
   * A host that keeps its store at its OWN declared root — the same root the
   * submission ingress opens its ledger at — passes that root here, so the audit
   * reads the store the run actually wrote instead of reporting a healthy graph
   * as "store absent".
   */
  readonly ledgerDirectory?: string;
  /**
   * Where the RETIRED per-graph v2 containers would be, when that is a different
   * directory from the store. Defaults to the workspace state directory. This
   * build does not read them, but it must report them: an operator cannot call a
   * workspace drained while records it cannot decode are still on disk
   * (plan §P6.4).
   */
  readonly retiredRecordDirectory?: string;
  /**
   * Read "now" for the staleness inference; defaults to `Date.now`.
   * Injected by a caller (or a test) that must classify against a fixed instant
   * instead of the wall clock — the audit is read-only either way.
   */
  readonly now?: () => number;
  /**
   * Override the idle threshold the staleness inference applies; defaults to
   * {@link STALE_LOCK_IDLE_THRESHOLD_MS}. The value actually used is reported on
   * every classified entry, so an override is visible in the report and a
   * reviewer can recompute the classification.
   */
  readonly staleAfterMs?: number;
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** One blocker, with the graph (and file, when it is one) it belongs to. */
function blocker(
  code: DrainAuditBlockerCode,
  detail: string,
  where: { readonly graphId?: string; readonly file?: string },
  dimension?: DrainAuditBlockerDimension,
): DrainAuditBlocker {
  return Object.freeze({
    code,
    ...(dimension === undefined ? {} : { dimension }),
    detail,
    ...(where.graphId === undefined ? {} : { graphId: where.graphId }),
    ...(where.file === undefined ? {} : { file: where.file }),
  });
}

/** A blocked entry: a definition the audit could not classify. */
function blockedEntry(
  graphId: string,
  codes: readonly DrainAuditBlockerCode[],
): DrainAuditEntry {
  return Object.freeze({
    graphId,
    protocol: "unknown" as const,
    classification: "blocked" as const,
    blockerCodes: Object.freeze([...codes]),
  });
}

/** Project one effect row into the report's own shape. */
function toAuditEffect(effect: PendingEffectRecord): DrainAuditEffect {
  return Object.freeze({
    effectId: effect.effectId,
    attemptId: effect.attemptId,
    kind: effect.kind,
    status: effect.status,
  });
}

/** Project one persisted stop into the report's own shape. */
function toAuditStop(stop: OutcomeStop): DrainAuditStop {
  return Object.freeze({
    reason: stop.reason,
    summary: describeOutcomeStop(stop),
  });
}

// ── Entry classification ────────────────────────────────────────────────────

/**
 * One record's queue. Internal: the report exposes the fact through
 * {@link DrainAuditStalenessFacts} and the entry's own work fields, never as
 * this alias.
 */
interface EntryQueue {
  /** Whether the record holds work the engine has not consumed. */
  readonly hasQueuedWork: boolean;
}

/** Everything a classification pass may add to an entry. */
interface EntryBody {
  readonly protocol: DrainAuditProtocol;
  readonly classification: DrainAuditClassification;
  readonly phase?: string;
  readonly planRevision?: string;
  readonly armed?: readonly DrainAuditArmedNode[];
  readonly unsettledEffects?: readonly DrainAuditEffect[];
  readonly stop?: DrainAuditStop;
  readonly hasState?: boolean;
  /** The record's own last state-update timestamp, when it holds one. */
  readonly lastUpdatedAt?: number;
  /** The record's queue, when it holds one. Internal — never reported as-is. */
  readonly queue?: EntryQueue;
  readonly blockerCodes: readonly DrainAuditBlockerCode[];
  /**
   * Per-code detail that OVERRIDES the generic sentence, for a blocker whose
   * concrete cause (a contained error's text, say) is evidence the caller
   * should see. Absent codes fall back to {@link describeEntryBlocker}.
   */
  readonly blockerDetails?: Readonly<
    Partial<Record<DrainAuditBlockerCode, string>>
  >;
}

/** The outcome protocol's queue: armed attempts and unsettled effects. */
function outcomeQueue(armedCount: number, effectCount: number): EntryQueue {
  return Object.freeze({ hasQueuedWork: armedCount > 0 || effectCount > 0 });
}

/**
 * The queue of a graph that was declared but never started. Its queue is the
 * FIRST EXECUTION ITSELF: the run path starts the graph from the stored plan at
 * any time, so the record is not a dead lock and must never be reported as one.
 * No frontier exists to report — there is no run state yet — so only
 * `hasQueuedWork` is carried.
 */
const UNSTARTED_OUTCOME_QUEUE: EntryQueue = Object.freeze({
  hasQueuedWork: true,
});

/**
 * Decide one in-flight record's staleness — the SINGLE owner of the rule.
 *
 * `stale-lock` requires BOTH halves: nothing queued and no state update
 * for at least the threshold. Either half alone keeps the entry
 * `actively-executing`, because the audit must not call a record dead on
 * evidence that does not support it.
 */
function stalenessFacts(
  lastUpdatedAt: number,
  queue: EntryQueue,
  now: number,
  staleAfterMs: number,
): DrainAuditStalenessFacts {
  const idleMs = Math.max(0, now - lastUpdatedAt);
  const staleness: DrainAuditStaleness =
    queue.hasQueuedWork || idleMs < staleAfterMs
      ? "actively-executing"
      : "stale-lock";
  return Object.freeze({
    lastUpdatedAt,
    idleMs,
    staleAfterMs,
    staleness,
    hasQueuedWork: queue.hasQueuedWork,
  });
}

/**
 * Read one graph's unsettled effects, CONTAINED.
 *
 * A store read can THROW: the store's own row gate refuses a hand-edited or
 * foreign row instead of returning it. The audit must report that as a blocker
 * for the entry and never let it escape — totality is what makes the report
 * evidence rather than a crash waiting for a bad row.
 */
function readUnsettledEffects(
  store: GraphStore,
  graphId: string,
):
  | { readonly ok: true; readonly effects: readonly DrainAuditEffect[] }
  | { readonly ok: false; readonly reason: string } {
  try {
    const rows = store.pendingEffects(graphId);
    return { ok: true, effects: Object.freeze(rows.map(toAuditEffect)) };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Classify one DECODED definition against the store's run state.
 *
 * The definition's own gates have already run (`decodeStoredDefinition`),
 * so this pass only reads the run: the state row through the strict versioned
 * reader, against the SAVED plan. A state this build cannot read is a BLOCKER,
 * never a clean start and never a guess.
 */
function classifyOutcome(
  declared: StoredDeclaredGraph,
  store: GraphStore,
): EntryBody {
  const graphId = declared.graphId;
  const planRevision = declared.plan.planRevision;
  const effects = readUnsettledEffects(store, graphId);
  if (!effects.ok) {
    const detail =
      "graph " + JSON.stringify(graphId) +
      " has effect rows this build could not read (" + effects.reason + ")";
    return {
      protocol: "outcome",
      classification: "blocked",
      planRevision,
      blockerCodes: ["state-unreadable"],
      blockerDetails: { "state-unreadable": detail },
    };
  }

  let raw: ReturnType<GraphStore["readGraphState"]>;
  try {
    raw = store.readGraphState(graphId);
  } catch (error) {
    // The store's own row gate refused a row (a hand-edited or foreign record):
    // contained as a blocker, never thrown past the audit.
    const detail =
      "graph " + JSON.stringify(graphId) +
      " has a run-state row this build could not read (" + errorText(error) + ")";
    return {
      protocol: "outcome",
      classification: "blocked",
      planRevision,
      blockerCodes: ["state-unreadable"],
      blockerDetails: { "state-unreadable": detail },
    };
  }
  if (raw === undefined) {
    // No run-state row: the graph was declared but never started, so its first
    // execution is still owed. That is in flight, NOT blocked — nothing about
    // the record is unreadable.
    return {
      protocol: "outcome",
      classification: "in-flight",
      planRevision,
      hasState: false,
      armed: Object.freeze([]),
      unsettledEffects: effects.effects,
      lastUpdatedAt: declared.recordedAt,
      queue: UNSTARTED_OUTCOME_QUEUE,
      blockerCodes: [],
    };
  }

  let outcomeState: OutcomeGraphState;
  try {
    outcomeState = readOutcomeGraphState(raw, declared.plan);
  } catch (error) {
    const detail =
      "graph " + JSON.stringify(graphId) +
      " has a run-state row that is not the state its plan defines: " +
      errorText(error);
    return {
      protocol: "outcome",
      classification: "blocked",
      planRevision,
      hasState: true,
      blockerCodes: ["state-malformed"],
      blockerDetails: { "state-malformed": detail },
    };
  }

  const armed: DrainAuditArmedNode[] = [];
  for (const node of outcomeState.nodes) {
    if (node.status === "dispatched" && node.attemptId !== undefined) {
      armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
    }
  }
  const quiescent =
    outcomeState.phase === "complete" || outcomeState.phase === "stopped";
  return {
    protocol: "outcome",
    classification: quiescent ? "terminal" : "in-flight",
    phase: outcomeState.phase,
    planRevision: outcomeState.planRevision,
    hasState: true,
    armed: Object.freeze(armed),
    unsettledEffects: effects.effects,
    lastUpdatedAt: raw.updatedAt,
    queue: outcomeQueue(armed.length, effects.effects.length),
    ...(outcomeState.stop === undefined
      ? {}
      : { stop: toAuditStop(outcomeState.stop) }),
    blockerCodes: [],
  };
}

/**
 * Turn one stored definition (or the decode refusal it produced) into an entry
 * plus the blockers it produced.
 */
function entryForDefinition(
  graphId: string,
  decoded: ReturnType<typeof decodeStoredDefinition>,
  store: GraphStore | undefined,
  storeBlocker: DrainAuditBlockerCode | undefined,
  now: number,
  staleAfterMs: number,
): {
  readonly entry: DrainAuditEntry;
  readonly blockers: readonly DrainAuditBlocker[];
} {
  if (decoded.kind === "refused") {
    const detail = decoded.issues
      .map((issue) => "[" + issue.code + "] " + issue.path + ": " + issue.message)
      .join("; ");
    return {
      entry: blockedEntry(graphId, ["unrunnable-definition"]),
      blockers: [
        blocker("unrunnable-definition", detail, { graphId }, "contract"),
      ],
    };
  }
  if (store === undefined) {
    // The store could not be opened, so this definition was never reached; the
    // store-level blocker is the answer and every graph inherits it.
    return {
      entry: blockedEntry(graphId, [storeBlocker ?? "ledger-unreadable"]),
      blockers: [],
    };
  }

  const body = classifyOutcome(decoded.declared, store);
  // The queue is an INPUT to the staleness inference, not part of the report:
  // the entry's own work fields (`armed` / `unsettledEffects`)
  // surface it. Dropped here rather than duplicated as a second shape that
  // could drift.
  const { lastUpdatedAt, queue, ...reportable } = body;
  const staleness =
    body.classification === "in-flight" &&
    lastUpdatedAt !== undefined &&
    queue !== undefined
      ? stalenessFacts(lastUpdatedAt, queue, now, staleAfterMs)
      : undefined;
  const entry = Object.freeze({
    graphId,
    ...reportable,
    ...(staleness === undefined ? {} : { staleness }),
    blockerCodes: Object.freeze([...body.blockerCodes]),
  });
  return {
    entry,
    blockers: body.blockerCodes.map((code) =>
      blocker(
        code,
        body.blockerDetails?.[code] ?? describeEntryBlocker(code, graphId),
        { graphId },
        blockerDimensionFor(code),
      ),
    ),
  };
}

/** The axis a per-entry blocker code belongs to, when one owns it. */
function blockerDimensionFor(
  code: DrainAuditBlockerCode,
): DrainAuditBlockerDimension | undefined {
  if (code === "ledger-refused" || code === "ledger-unreadable") return "ledger";
  if (code === "unrunnable-definition") return "contract";
  if (
    code === "state-plan-mismatch" ||
    code === "state-version-unsupported" ||
    code === "state-malformed" ||
    code === "state-unreadable"
  ) {
    return "outcome-state";
  }
  return undefined;
}

/** One honest sentence for a per-entry blocker, derived from its code. */
function describeEntryBlocker(
  code: DrainAuditBlockerCode,
  graphId: string,
): string {
  switch (code) {
    case "unrunnable-definition":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a stored definition this build cannot run"
      );
    case "ledger-refused":
      return (
        "graph " + JSON.stringify(graphId) +
        " keeps its run state in the graph store, which exists but is not a " +
        "store this build may read"
      );
    case "ledger-unreadable":
      return (
        "graph " + JSON.stringify(graphId) +
        " keeps its run state in the graph store, which could not be opened " +
        "for reading"
      );
    case "state-plan-mismatch":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a run-state row bound to a different graph or plan revision than " +
        "the definition it belongs to"
      );
    case "state-version-unsupported":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a run-state row written in a body version this build has no " +
        "reader for — refusing it rather than reading it partially"
      );
    case "state-malformed":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a run-state row that is not the shape its declared body version " +
        "defines"
      );
    case "state-unreadable":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a run-state row the strict reader could not process (an " +
        "unexpected error was contained)"
      );
    default:
      // The store-level codes carry their own verdict text in the blocker
      // detail; this path is not reachable for them.
      return "graph " + JSON.stringify(graphId) + ": " + code;
  }
}

// ── Retired records ─────────────────────────────────────────────────────────

/**
 * The retired per-graph v2 containers still on disk under `directory`.
 *
 * A NON-EMPTY `engine-<slug>.json` is a record of a layout this build no
 * longer writes and has no decoder for. The audit does not read it — it reports
 * it, by name, as the reason the workspace is not drained: "no readable graph is
 * in flight" is not the same fact as "nothing is left to account for"
 * (plan §3.6, §P6.4). A missing directory is an empty list, never an error.
 */
function retiredRecordFiles(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory, { encoding: "utf-8" });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(RETIRED_AUTHORITY_PREFIX)) continue;
    if (!name.endsWith(RETIRED_AUTHORITY_SUFFIX)) continue;
    try {
      if (statSync(join(directory, name)).size > 0) found.push(name);
    } catch {
      // A path that cannot be stat'ed is not evidence of a record.
    }
  }
  return found;
}

// ── The audit ───────────────────────────────────────────────────────────────

/**
 * Audit one workspace's graph store, READ-ONLY.
 *
 * TOTAL: a missing store is an empty report, an unreadable store is one
 * store-level blocker, and every per-graph failure is contained as its own
 * entry. Nothing is thrown for a state of the store; a thrown exception here
 * would be a bug in the audit, not a fact about a graph.
 */
export async function auditGraphStore(
  options: DrainAuditOptions,
): Promise<DrainAuditReport> {
  const defaultStateDirectory = engineStateDir(options.directory);
  const storeDirectory = options.ledgerDirectory ?? defaultStateDirectory;
  const retiredDirectory = options.retiredRecordDirectory ?? defaultStateDirectory;
  const filePath = ledgerFilePath(storeDirectory);
  // "Now" is read ONCE: every entry in one report is classified against the
  // same instant, so two entries with the same age cannot land on opposite sides
  // of the threshold because the audit took a while.
  const now = (options.now ?? Date.now)();
  const staleAfterMs = options.staleAfterMs ?? STALE_LOCK_IDLE_THRESHOLD_MS;

  const blockers: DrainAuditBlocker[] = [];
  const entries: DrainAuditEntry[] = [];

  // 1. The retired per-graph containers, BEFORE the store is opened: they are
  //    the records this build refuses to interpret, and a workspace that still
  //    holds one is never drained whatever the store says.
  for (const name of retiredRecordFiles(retiredDirectory)) {
    blockers.push(
      blocker(
        "retired-state-record",
        "the retired per-graph engine-state container " +
          join(retiredDirectory, name) +
          " is still present; this build neither reads it nor converts it, so " +
          "its graph must be inventoried and archived before the workspace can " +
          "be called drained",
        { file: name },
        "storage",
      ),
    );
  }

  // 2. The store, opened READ-ONLY through the format gate and never created.
  //    A refusal is a store-level blocker that every definition inherits, and
  //    an absent store is a fact about the whole report.
  const loaded: GraphStoreLoadResult = loadGraphStoreSync(storeDirectory);
  let store: GraphStore | undefined;
  let ledgerStatus: DrainAuditLedgerStatus;
  let storeBlocker: DrainAuditBlockerCode | undefined;
  if (loaded.kind === "valid") {
    store = loaded.value;
    ledgerStatus = "opened";
  } else if (loaded.kind === "absent") {
    ledgerStatus = "absent";
  } else if (loaded.kind === "unsupported") {
    ledgerStatus = "refused";
    storeBlocker = "ledger-refused";
    blockers.push(
      blocker(
        "ledger-refused",
        "graph store " + filePath + " is not a store this build may read (" +
          describeStoreVerdict(loaded) + ")",
        {},
        "ledger",
      ),
    );
  } else if (loaded.kind === "corrupt") {
    ledgerStatus = "unreadable";
    storeBlocker = "ledger-unreadable";
    blockers.push(
      blocker(
        "ledger-unreadable",
        "graph store " + filePath + " could not be read (" +
          describeStoreVerdict(loaded) + ")",
        {},
        "ledger",
      ),
    );
  } else {
    // `migration-required` is uninhabited while no conversion is
    // registered; reported by name rather than folded into another branch.
    ledgerStatus = "refused";
    storeBlocker = "ledger-refused";
    blockers.push(
      blocker(
        "ledger-refused",
        "graph store " + filePath + " needs a registered conversion (" +
          describeStoreVerdict(loaded) + ")",
        {},
        "ledger",
      ),
    );
  }

  // 3. Every stored definition, classified against the same store. The store's
  //    own row gate is total over raw SQL, and each failure is contained, so one
  //    hostile row cannot hide the rest of the store.
  let graphIds: readonly string[] = [];
  if (store !== undefined) {
    try {
      graphIds = store.definitionGraphIds();
    } catch (error) {
      blockers.push(
        blocker(
          "state-store-unreadable",
          "the graph store " + storeDirectory + " could not be listed: " +
            errorText(error),
          {},
          "storage",
        ),
      );
      graphIds = [];
    }
  }
  try {
    for (const graphId of graphIds) {
      let decoded: ReturnType<typeof decodeStoredDefinition>;
      try {
        const row = store?.readDefinition(graphId);
        if (row === undefined) continue;
        decoded = decodeStoredDefinition(row);
      } catch (error) {
        entries.push(blockedEntry(graphId, ["unrunnable-definition"]));
        blockers.push(
          blocker(
            "unrunnable-definition",
            "graph " + JSON.stringify(graphId) +
              " has a definition row the store could not read (" +
              errorText(error) + ")",
            { graphId },
            "contract",
          ),
        );
        continue;
      }
      const audited = entryForDefinition(
        graphId,
        decoded,
        store,
        storeBlocker,
        now,
        staleAfterMs,
      );
      entries.push(audited.entry);
      blockers.push(...audited.blockers);
    }
  } finally {
    // The audit owns the handle only when it opened it.
    store?.close();
  }

  // 4. Counts. The three-way partition is the headline; the protocol split and
  //    the effect count are what the drain decision actually turns on.
  let terminal = 0;
  let inFlight = 0;
  let blocked = 0;
  let outcomeInFlight = 0;
  let staleLocks = 0;
  let activelyExecuting = 0;
  let unsettledEffects = 0;
  const blockersByCode: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.classification === "terminal") terminal += 1;
    else if (entry.classification === "in-flight") {
      inFlight += 1;
      if (entry.protocol === "outcome") outcomeInFlight += 1;
      // Every in-flight entry is readable, so every one of them carries the
      // inference: the pair sums to inFlight by construction.
      if (entry.staleness?.staleness === "stale-lock") staleLocks += 1;
      else activelyExecuting += 1;
    } else blocked += 1;
    unsettledEffects += entry.unsettledEffects?.length ?? 0;
  }
  for (const entry of blockers) {
    blockersByCode[entry.code] = (blockersByCode[entry.code] ?? 0) + 1;
  }

  // 5. The verdict. NOT a count: every half is required.
  const verdict: DrainAuditVerdict =
    blockers.length > 0
      ? "blocked"
      : inFlight > 0 || unsettledEffects > 0
        ? "in-flight"
        : "drained";

  return Object.freeze({
    directory: options.directory,
    storeDirectory,
    ledgerFilePath: filePath,
    ledger: ledgerStatus,
    entries: Object.freeze(entries),
    blockers: Object.freeze(blockers),
    totals: Object.freeze({
      graphs: graphIds.length,
      terminal,
      inFlight,
      blocked,
      outcomeInFlight,
      staleLocks,
      activelyExecuting,
      unsettledEffects,
      blockersByCode: Object.freeze(blockersByCode),
    }),
    verdict,
    drained: verdict === "drained",
  });
}
