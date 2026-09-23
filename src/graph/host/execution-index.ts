/**
 * Graph Execution Engine v2 — the host's durable dispatch-execution index
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE FACTS HALF OF THE DISPATCH HOST (D8). `src/graph/outcome/dispatch-effects.ts`
 * gives the runtime two answers it cannot derive on its own: create this
 * effect's execution (idempotently per `(graphId, effectId)`) and say whether
 * an execution for that stable id ALREADY EXISTS. This module owns the second
 * one for a real host: the record of what the host actually created.
 *
 * WHY THE RECORD EXISTS AT ALL. A dispatch effect is committed atomically with
 * the state it belongs to, and the create call happens after that commit. A
 * process that dies inside that window leaves an effect the ledger records and
 * the runtime cannot resolve: the execution may or may not exist. Neither
 * pre-marking the effect "started" nor re-issuing the create blindly answers
 * that question, so the runtime ASKS the host — and the host can only answer
 * because it writes down what it created, keyed by the stable effect id the
 * runtime derives from the attempt.
 *
 * HONEST ANSWERS, INCLUDING "I CANNOT TELL".
 *
 * - `durability: "file"` (the default) writes the index to a separate file
 *   under `root` (atomic replace, 0600, created 0700), so the host can answer
 *   for effects created by an EARLIER process too: an id it never recorded is
 *   genuinely `absent`, which is what lets a recovery create exactly once.
 * - `durability: "memory"` keeps the record in this process only. It can then
 *   answer `created` for what IT created, and it answers `unknown` for
 *   everything else — never `absent` — because an execution created by a
 *   previous process is exactly what it cannot see. The runtime reports those
 *   effects as unsettled work instead of dispatching them a second time.
 *
 * THE INDEX RECORDS THE DECISION TO CREATE, NOT THE DELIVERY'S OUTCOME. The
 * dispatch host records an effect BEFORE it hands the execution to the
 * platform seam and un-records it if the seam throws, so the two failure
 * windows are not symmetric: a crash between the record and the delivery
 * leaves the attempt reported as created-but-never-run (visible in the
 * runtime's unsettled/armed reports and in the drain audit) rather than
 * silently re-dispatched, because running one attempt twice is the outcome
 * this whole contract exists to prevent. The residual duplicate window is the
 * seam itself: a platform whose dispatch cannot dedupe on the stable effect id
 * can run an attempt twice if the host process dies inside the delivery, and
 * the documentation says so instead of implying a guarantee the host cannot
 * give.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OutcomeDispatchEffectKey,
  OutcomeExecutionLookup,
} from "../outcome/dispatch-effects.ts";

// ── Options and format ──────────────────────────────────────────────────────

/** How long the index outlives the process that wrote it. */
export type HostExecutionIndexDurability =
  /**
   * A separate file under `root` (the default): the host can answer for an
   * earlier process's creations, so an unrecorded effect is a real `absent`.
   */
  | "file"
  /**
   * This process only: `created` for what it created, `unknown` for the rest.
   */
  | "memory";

/** Inputs to {@link HostExecutionIndex.open}. */
export interface HostExecutionIndexOptions {
  /** The host-owned directory the index file lives in (created 0700 when absent). */
  readonly root: string;
  /** Defaults to `"file"` (see {@link HostExecutionIndexDurability}). */
  readonly durability?: HostExecutionIndexDurability;
}

/** The index file's name inside {@link HostExecutionIndexOptions.root}. */
export const HOST_EXECUTION_INDEX_FILE = "host-dispatch-executions.json" as const;

/** The index file's own format version, refused rather than read approximately. */
export const HOST_EXECUTION_INDEX_VERSION = 1 as const;

// ── The index ───────────────────────────────────────────────────────────────

/**
 * The host's record of the dispatch executions it has created, addressed by the
 * stable effect identity the runtime derives from the attempt
 * (`dispatch:<attemptId>`, scoped by graph).
 */
export class HostExecutionIndex {
  private readonly root: string;
  private readonly durability: HostExecutionIndexDurability;
  /** Recorded effect keys, exactly as the runtime spelled them. */
  private readonly recorded = new Set<string>();
  private readonly indexPath: string;

  private constructor(options: HostExecutionIndexOptions) {
    this.root = options.root;
    this.durability = options.durability ?? "file";
    this.indexPath = join(this.root, HOST_EXECUTION_INDEX_FILE);
    if (this.durability === "file") this.load();
  }

  /** Open one index over `root`, reading the durable record when present. */
  static open(options: HostExecutionIndexOptions): HostExecutionIndex {
    return new HostExecutionIndex(options);
  }

  /**
   * Record that this effect's execution was created (or is being created — see
   * the module header). Idempotent: recording an already-recorded effect
   * changes nothing and answers `false`.
   */
  record(effect: OutcomeDispatchEffectKey): boolean {
    const key = effectKey(effect);
    if (this.recorded.has(key)) return false;
    this.recorded.add(key);
    if (this.durability === "file") this.persist();
    return true;
  }

  /**
   * Drop one effect's record, so the host will create it again. Used by the
   * dispatch host when its delivery seam THREW: the execution demonstrably did
   * not start, and a later recovery must be allowed to create it.
   */
  unrecord(effect: OutcomeDispatchEffectKey): void {
    if (!this.recorded.delete(effectKey(effect))) return;
    if (this.durability === "file") this.persist();
  }

  /** Whether this effect is recorded as created. */
  has(effect: OutcomeDispatchEffectKey): boolean {
    return this.recorded.has(effectKey(effect));
  }

  /**
   * Whether an execution for this effect exists.
   *
   * A recorded effect is `created` in every mode. An unrecorded one is
   * `absent` only when this index is authoritative for the graph — the durable
   * mode, where every create this host ever performed is in the file — and
   * `unknown` otherwise, with the reason, because a memory-only index cannot
   * see what an earlier process created.
   */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    if (this.recorded.has(effectKey(effect))) {
      return Object.freeze({ kind: "created" as const });
    }
    if (this.durability === "file") {
      return Object.freeze({ kind: "absent" as const });
    }
    return Object.freeze({
      kind: "unknown" as const,
      reason:
        "this host keeps its execution index in memory only, so it cannot say whether " +
        "graph " +
        JSON.stringify(effect.graphId) +
        " already had an execution for effect " +
        JSON.stringify(effect.effectId) +
        " created by an earlier process",
    });
  }

  /** How many executions this host has recorded. A count, never a listing. */
  get size(): number {
    return this.recorded.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Read the index file, refusing a shape this build cannot read. */
  private load(): void {
    if (!existsSync(this.indexPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.indexPath, "utf8"));
    } catch (error) {
      throw new Error(
        "host-execution-index: the index file " +
          JSON.stringify(this.indexPath) +
          " is not readable JSON (" +
          (error instanceof Error ? error.message : String(error)) +
          ") — refusing to open the index as if it were empty, because every unrecorded " +
          "effect would then look absent and could be dispatched a second time",
      );
    }
    if (!isRecord(parsed) || parsed.version !== HOST_EXECUTION_INDEX_VERSION) {
      throw new Error(
        "host-execution-index: the index file " +
          JSON.stringify(this.indexPath) +
          " does not declare format version " +
          HOST_EXECUTION_INDEX_VERSION +
          " — refusing to read it approximately",
      );
    }
    if (!Array.isArray(parsed.effects)) {
      throw new Error(
        "host-execution-index: the index file " +
          JSON.stringify(this.indexPath) +
          " carries no effects list",
      );
    }
    for (const entry of parsed.effects) {
      if (
        !isRecord(entry) ||
        typeof entry.graphId !== "string" ||
        typeof entry.effectId !== "string"
      ) {
        throw new Error(
          "host-execution-index: the index file " +
            JSON.stringify(this.indexPath) +
            " carries an entry this build cannot read — refusing the whole file rather " +
            "than dropping one execution record",
        );
      }
      this.recorded.add(entry.graphId + "\u0000" + entry.effectId);
    }
  }

  /** Write the index atomically (temp file, then rename) with mode 0600. */
  private persist(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const effects = [...this.recorded].map((key) => {
      const [graphId, effectId] = key.split("\u0000");
      return { graphId, effectId };
    });
    const text = JSON.stringify(
      { version: HOST_EXECUTION_INDEX_VERSION, effects },
      null,
      2,
    );
    const temporary = this.indexPath + "." + process.pid + ".tmp";
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.indexPath);
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** The index's set key: graph + stable effect id, joined unambiguously. */
function effectKey(effect: OutcomeDispatchEffectKey): string {
  return effect.graphId + "\u0000" + effect.effectId;
}

/** Whether a value is a plain, non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
