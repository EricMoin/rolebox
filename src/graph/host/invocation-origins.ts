/**
 * Graph Execution Engine v2 — a graph's declaring invocation, as a store TABLE
 *
 * Version: 2.0
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
 * So the declaring invocation becomes a HOST FACT, kept per graph — in the
 * workspace's ONE graph store (`src/graph/store/`), table
 * `graph_invocation_origins`, in the SAME database as the run state and the
 * execution bindings it belongs to.
 *
 * WHAT THIS MODULE NO LONGER IS. It used to be a WHOLE-FILE authority: a
 * `host-invocation-origins.json` rewritten in full on every change, beside the
 * acceptance ledger and committing independently of it. P1 item 3 names that
 * file as the bypass authority to eliminate, and it is gone: there is no file
 * to rewrite, no in-process snapshot to lose a concurrent writer's rows, and no
 * second format to gate. The record is a row now, so it is written, read and
 * committed with everything else the graph owns.
 *
 * WHAT IT CONTAINS, AND WHAT IT DOES NOT. A graph id and the
 * `{ sessionId, agent }` attribution the declaring call carried — no
 * credential, no prompt, no outcome. Recording a graph again with the SAME
 * attribution changes nothing, and a DIFFERENT attribution REPLACES it: a
 * re-declaration from a new session is the newer invocation, and a later
 * dispatch must be attributed to the session that is actually running the
 * graph.
 *
 * AN UNREADABLE STORE IS REFUSED, NOT IGNORED. The store's own format gate runs
 * at `open`, so a file this build cannot read throws instead of answering "no
 * origins" — reading an unreadable record as empty would make every declared
 * graph look like one no invocation ever named, and the sweep would report a
 * dispatch failure whose real cause is an unreadable store.
 */

import { GraphStore } from "../store/graph-store.ts";

// ── Options and format ──────────────────────────────────────────────────────

/** How long the origin record outlives the process that wrote it. */
export type HostInvocationOriginsDurability =
  /** The workspace's durable store (the default): restart-resolvable. */
  | "file"
  /** This process only: a restarted host knows no graph's origin. */
  | "memory";

/** Inputs to {@link HostInvocationOrigins.open}. */
export interface HostInvocationOriginsOptions {
  /** The host-owned directory the store lives in (created 0700). */
  readonly root: string;
  /** Defaults to `"file"` (see {@link HostInvocationOriginsDurability}). */
  readonly durability?: HostInvocationOriginsDurability;
  /**
   * An ALREADY OPEN workspace store to share.
   *
   * Omitted (the default), this record opens its own connection to `root` — or
   * a private in-memory store for `durability: "memory"`. A host that
   * assembles several capabilities passes ONE store so all of them address one
   * database and one transaction boundary even in memory mode.
   */
  readonly store?: GraphStore;
}

/** One graph's declaring invocation, as the declaring call saw it. */
export interface HostInvocationOrigin {
  /** The declaring session. Never empty: an origin without one names nothing. */
  readonly sessionId: string;
  /** The acting agent at declaration, when the platform attributed one. */
  readonly agent?: string;
}

// ── The record ──────────────────────────────────────────────────────────────

/**
 * The host's record of which invocation declared each graph.
 *
 * One row per graph id in the workspace's store. Every method delegates to the
 * store, so the record joins whatever transaction the caller has open and the
 * value a restart reads is the row the store committed.
 */
export class HostInvocationOrigins {
  private readonly graphStore: GraphStore;

  private constructor(graphStore: GraphStore) {
    this.graphStore = graphStore;
  }

  /** Open one record over `root`, reading the durable store when present. */
  static open(options: HostInvocationOriginsOptions): HostInvocationOrigins {
    const durability = options.durability ?? "file";
    const graphStore =
      options.store ??
      (durability === "memory"
        ? GraphStore.openMemory()
        : GraphStore.openFile(options.root));
    return new HostInvocationOrigins(graphStore);
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
    return this.graphStore.recordInvocationOrigin(graphId, origin, Date.now());
  }

  /** The invocation that declared this graph, or `undefined` when none is known. */
  get(graphId: string): HostInvocationOrigin | undefined {
    return this.graphStore.readInvocationOrigin(graphId);
  }

  /** Every graph id this record holds an origin for, sorted. */
  graphIds(): readonly string[] {
    return this.graphStore.invocationOriginGraphIds();
  }

  /** How many origins this record holds. A count, never a listing. */
  get size(): number {
    return this.graphIds().length;
  }

  /** Close the store connection. Idempotent. */
  close(): void {
    this.graphStore.close();
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
