/**
 * Graph Execution Engine v2 — the host's durable record of a graph's declaring invocation
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS RECORD EXISTS. Every window that can arm a dispatch — the declaring
 * call's first execution, a worker's own accepted submission, an observed
 * completion settling its successor, and the boot sweep — starts a worker
 * under SOME platform invocation. The platform needs that invocation before it
 * can start a run (dsh composes the subagent under a live parent session, Pi
 * launches the task under a parent session), and the window that arms a
 * SUCCESSOR is not the window that declared the graph: a natural completion is
 * observed later, out of band, when no tool call is in effect. A host that only
 * names the invocation during the declaring call therefore loses it exactly
 * when the second node is armed.
 *
 * So the declaring invocation becomes a HOST FACT, kept per graph:
 *
 * - in this process, {@link HostInvocationOrigins} answers the origin for every
 *   dispatch the graph's runtime makes, whatever window arms it;
 * - with `durability: "file"` (the default) the same record is written to a
 *   separate file under the host-owned root (atomic replace, 0600, directory
 *   0700), so a process that starts after a restart can still name the origin
 *   instead of leaving a declared graph's pending effect un-attributable.
 *
 * WHAT IT CONTAINS, AND WHAT IT DOES NOT. A graph id and the
 * `{ sessionId, agent }` attribution the declaring call carried — no
 * credential, no prompt, no outcome. It is the same invocation identity the
 * runtime may record on an attempt when the host declares D9, and it is a host
 * record for the same reason the vault is: the module is the one place the
 * attribution is kept, and nothing in a report or a ledger row carries it
 * forward on its own.
 *
 * A FILE THIS BUILD CANNOT READ IS REFUSED, NOT IGNORED. Reading an unreadable
 * record as "no origins" would make every declared graph look like one no
 * invocation ever named, and the sweep would report a dispatch failure whose
 * real cause is an unreadable host file. The refusal names the file instead.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Options and format ──────────────────────────────────────────────────────

/** How long the origin record outlives the process that wrote it. */
export type HostInvocationOriginsDurability =
  /** A separate 0600 file under `root` (the default): restart-resolvable. */
  | "file"
  /** This process only: a restarted host knows no graph's origin. */
  | "memory";

/** Inputs to {@link HostInvocationOrigins.open}. */
export interface HostInvocationOriginsOptions {
  /** The host-owned directory the record file lives in (created 0700). */
  readonly root: string;
  /** Defaults to `"file"` (see {@link HostInvocationOriginsDurability}). */
  readonly durability?: HostInvocationOriginsDurability;
}

/** One graph's declaring invocation, as the declaring call saw it. */
export interface HostInvocationOrigin {
  /** The declaring session. Never empty: an origin without one names nothing. */
  readonly sessionId: string;
  /** The acting agent at declaration, when the platform attributed one. */
  readonly agent?: string;
}

/** The record file's name inside {@link HostInvocationOriginsOptions.root}. */
export const HOST_INVOCATION_ORIGINS_FILE = "host-invocation-origins.json" as const;

/** The record's own format version, refused rather than read approximately. */
export const HOST_INVOCATION_ORIGINS_VERSION = 1 as const;

// ── The record ──────────────────────────────────────────────────────────────

/**
 * The host's record of which invocation declared each graph.
 *
 * One entry per graph id: recording a graph again with the SAME attribution
 * changes nothing, and a DIFFERENT attribution REPLACES it — a re-declaration
 * from a new session is the newer invocation, and a later dispatch must be
 * attributed to the session that is actually running the graph.
 */
export class HostInvocationOrigins {
  private readonly root: string;
  private readonly durability: HostInvocationOriginsDurability;
  private readonly origins = new Map<string, HostInvocationOrigin>();
  private readonly recordPath: string;

  private constructor(options: HostInvocationOriginsOptions) {
    this.root = options.root;
    this.durability = options.durability ?? "file";
    this.recordPath = join(this.root, HOST_INVOCATION_ORIGINS_FILE);
    if (this.durability === "file") this.load();
  }

  /** Open one record over `root`, reading the durable file when present. */
  static open(options: HostInvocationOriginsOptions): HostInvocationOrigins {
    return new HostInvocationOrigins(options);
  }

  /**
   * Record one graph's declaring invocation.
   *
   * Returns whether the record CHANGED (a new graph, or an attribution that
   * differs from the stored one). An origin with no session is refused by name:
   * it would name nothing while looking like a recorded fact.
   */
  record(graphId: string, origin: HostInvocationOrigin): boolean {
    assertGraphId(graphId);
    assertOrigin(origin);
    const stored = this.origins.get(graphId);
    if (stored !== undefined && sameOrigin(stored, origin)) return false;
    this.origins.set(graphId, Object.freeze(origin));
    if (this.durability === "file") this.persist();
    return true;
  }

  /** The invocation that declared this graph, or `undefined` when none is known. */
  get(graphId: string): HostInvocationOrigin | undefined {
    return this.origins.get(graphId);
  }

  /** Every graph id this record holds an origin for, sorted. */
  graphIds(): readonly string[] {
    return Object.freeze([...this.origins.keys()].sort());
  }

  /** How many origins this record holds. A count, never a listing. */
  get size(): number {
    return this.origins.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Read the record file, refusing a shape this build cannot read. */
  private load(): void {
    if (!existsSync(this.recordPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.recordPath, "utf8"));
    } catch (error) {
      throw new Error(
        "host-invocation-origins: the record file " +
          JSON.stringify(this.recordPath) +
          " is not readable JSON (" +
          (error instanceof Error ? error.message : String(error)) +
          ") — refusing to open it as if it were empty, because every declared graph would " +
          "then look like one no invocation ever named and its dispatches would be " +
          "attributed to nobody",
      );
    }
    if (!isRecord(parsed) || parsed.version !== HOST_INVOCATION_ORIGINS_VERSION) {
      throw new Error(
        "host-invocation-origins: the record file " +
          JSON.stringify(this.recordPath) +
          " does not declare format version " +
          HOST_INVOCATION_ORIGINS_VERSION +
          " — refusing to read it approximately",
      );
    }
    if (!Array.isArray(parsed.origins)) {
      throw new Error(
        "host-invocation-origins: the record file " +
          JSON.stringify(this.recordPath) +
          " carries no origins list",
      );
    }
    for (const entry of parsed.origins) {
      if (
        !isRecord(entry) ||
        typeof entry.graphId !== "string" ||
        entry.graphId.length === 0 ||
        typeof entry.sessionId !== "string" ||
        entry.sessionId.length === 0 ||
        (entry.agent !== undefined &&
          (typeof entry.agent !== "string" || entry.agent.length === 0))
      ) {
        throw new Error(
          "host-invocation-origins: the record file " +
            JSON.stringify(this.recordPath) +
            " carries an entry this build cannot read — refusing the whole file rather " +
            "than dropping one graph's declaring invocation",
        );
      }
      this.origins.set(
        entry.graphId,
        Object.freeze(
          entry.agent === undefined
            ? { sessionId: entry.sessionId }
            : { sessionId: entry.sessionId, agent: entry.agent },
        ),
      );
    }
  }

  /** Write the record atomically (temp file, then rename) with mode 0600. */
  private persist(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const origins = [...this.origins.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([graphId, origin]) => ({
        graphId,
        sessionId: origin.sessionId,
        ...(origin.agent === undefined ? {} : { agent: origin.agent }),
      }));
    const text = JSON.stringify(
      { version: HOST_INVOCATION_ORIGINS_VERSION, origins },
      null,
      2,
    );
    const temporary = this.recordPath + "." + process.pid + ".tmp";
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.recordPath);
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** Refuse a graph id that names nothing. */
function assertGraphId(graphId: string): void {
  if (typeof graphId !== "string" || graphId.length === 0) {
    throw new Error("host-invocation-origins: a graph id must be a non-empty string");
  }
}

/** Refuse an origin that carries no session, or an empty agent. */
function assertOrigin(origin: HostInvocationOrigin): void {
  if (typeof origin.sessionId !== "string" || origin.sessionId.length === 0) {
    throw new Error(
      "host-invocation-origins: an origin must name the declaring session — a graph " +
        "with no session attributed is not a recorded fact",
    );
  }
  if (
    origin.agent !== undefined &&
    (typeof origin.agent !== "string" || origin.agent.length === 0)
  ) {
    throw new Error(
      "host-invocation-origins: an origin's agent must be a non-empty string when present",
    );
  }
}

/** Whether two origins name the same invocation. */
function sameOrigin(left: HostInvocationOrigin, right: HostInvocationOrigin): boolean {
  return left.sessionId === right.sessionId && left.agent === right.agent;
}

/** Whether a value is a plain, non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
