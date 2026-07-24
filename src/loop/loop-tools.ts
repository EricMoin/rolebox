import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LoopCoordinator } from "./coordinator.js";
import type { LoopState, LoopPhase, RoundRecord } from "./types.js";
import { applyWindow, DEFAULT_MAX_RESULT_CHARS } from "../dispatch/completion/result-extractor.js";
import type { ISessionClient } from "../platform/ports/session-client.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool-facing type definitions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Human-readable snapshot of a single loop's runtime state.
 * Mirrors LoopState fields surfaced to tool consumers.
 */
export interface LoopStatusSnapshot {
  originSessionId: string;
  agent: string;
  mode: string;
  total: number;
  current: number;
  phase: LoopPhase;
  cancelRequested: boolean;
  errorReason?: string;
  startedAt: number;
  updatedAt: number;
  roundStartedAt: number;
  activeWorkerTaskId?: string;
  activeWorkerSessionId?: string;
  roundCount: number;
  lastSummary?: string;
}

/**
 * Record of a single loop round for tool output.
 * Mirrors RoundRecord with simplified fields.
 */
export interface LoopHistoryEntry {
  round: number;
  workerTaskId: string;
  workerSessionId: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: string;
}

/**
 * Aggregate metrics across all tracked loop instances.
 * Provides a high-level view of loop subsystem health.
 */
export interface LoopMetricsSnapshot {
  totalLoops: number;
  activeLoops: number;
  terminalLoops: number;
  byPhase: Record<string, number>;
  advancingLockState: {
    activeLocks: number;
    staleLocks: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Projection helpers (file-private)
// ═══════════════════════════════════════════════════════════════════════════

const TERMINAL_PHASE_SET = new Set<LoopPhase>([
  "complete",
  "cancelled",
  "error",
  "interrupted",
]);

function toStatusSnapshot(state: LoopState): LoopStatusSnapshot {
  return {
    originSessionId: state.originSessionId,
    agent: state.agent,
    mode: state.mode,
    total: state.total,
    current: state.current,
    phase: state.phase,
    cancelRequested: state.cancelRequested,
    errorReason: state.errorReason,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    roundStartedAt: state.roundStartedAt,
    activeWorkerTaskId: state.activeWorkerTaskId,
    activeWorkerSessionId: state.activeWorkerSessionId,
    roundCount: state.rounds?.length ?? 0,
    lastSummary: state.lastSummary,
  };
}

function toHistoryEntry(round: RoundRecord): LoopHistoryEntry {
  return {
    round: round.round,
    workerTaskId: round.workerTaskId,
    workerSessionId: round.workerSessionId,
    startedAt: round.startedAt,
    completedAt: round.completedAt,
    durationMs: round.durationMs,
    status: round.status,
  };
}

function buildMetricsSnapshot(
  states: Map<string, LoopState>,
  coordinator: LoopCoordinator,
): LoopMetricsSnapshot {
  let activeLoops = 0;
  let terminalLoops = 0;
  const byPhase: Record<string, number> = {};

  for (const state of states.values()) {
    byPhase[state.phase] = (byPhase[state.phase] ?? 0) + 1;
    if (TERMINAL_PHASE_SET.has(state.phase)) {
      terminalLoops++;
    } else {
      activeLoops++;
    }
  }

  return {
    totalLoops: states.size,
    activeLoops,
    terminalLoops,
    byPhase,
    advancingLockState: coordinator.getAdvancingLockState(),
  };
}

/** Format milliseconds as a human-readable duration string. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Truncate a session ID with ellipsis for display. */
function shortenId(id: string, len = 20): string {
  if (id.length <= len) return id;
  return id.slice(0, len - 3) + "...";
}

// ═══════════════════════════════════════════════════════════════════════════
// Tree rendering helpers (for loop_list summary format)
// ═══════════════════════════════════════════════════════════════════════════

/** Flat entry produced by flattenLoopTree for row-by-row rendering. */
interface FlatTreeEntry {
  id: string;
  state: LoopState;
  depth: number;
  isLast: boolean;
  /** For each ancestor depth, whether that ancestor is the last child. */
  ancestorsLast: boolean[];
}

/**
 * Build a tree from entries keyed by originSessionId, then flatten into
 * depth-first order with connector metadata for rendering.
 *
 * Entries whose parentLoopId is absent or not in the idSet are treated
 * as root nodes. Children are grouped by parentLoopId and sorted by
 * startedAt for deterministic output.
 */
function buildAndFlattenTree(
  entries: [string, LoopState][],
): FlatTreeEntry[] {
  const idSet = new Set(entries.map(([id]) => id));
  const childrenMap = new Map<string, [string, LoopState][]>();

  for (const [id, state] of entries) {
    const parentId = state.parentLoopId;
    if (parentId && idSet.has(parentId)) {
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId)!.push([id, state]);
    }
  }

  // Sort children by startedAt for each parent
  for (const [, kids] of childrenMap) {
    kids.sort((a, b) => a[1].startedAt - b[1].startedAt);
  }

  // Roots: entries with no parentLoopId or parent not in filtered set
  const roots: [string, LoopState][] = [];
  for (const [id, state] of entries) {
    if (!state.parentLoopId || !idSet.has(state.parentLoopId)) {
      roots.push([id, state]);
    }
  }
  roots.sort((a, b) => a[1].startedAt - b[1].startedAt);

  // Recursively flatten
  const result: FlatTreeEntry[] = [];
  const flatten = (
    nodes: [string, LoopState][],
    ancestorsLast: boolean[],
    depth: number,
  ) => {
    for (let i = 0; i < nodes.length; i++) {
      const [id, state] = nodes[i];
      const isLast = i === nodes.length - 1;
      result.push({ id, state, depth, isLast, ancestorsLast: [...ancestorsLast] });
      const kids = childrenMap.get(id) ?? [];
      if (kids.length > 0) {
        flatten(kids, [...ancestorsLast, isLast], depth + 1);
      }
    }
  };
  flatten(roots, [], 0);

  return result;
}

/**
 * Render the tree connector prefix for a given depth and position.
 * Uses Unicode box-drawing characters.
 */
function renderTreePrefix(ancestorsLast: boolean[], isLast: boolean): string {
  if (ancestorsLast.length === 0) return ""; // root — no prefix
  let prefix = "";
  for (const ancestorLast of ancestorsLast) {
    prefix += ancestorLast ? "    " : "  │ ";
  }
  prefix += isLast ? "  └── " : "  ├── ";
  return prefix;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool factories
// ═══════════════════════════════════════════════════════════════════════════

/**
 * loop_status — Inspect a single loop or return aggregate metrics.
 *
 * Without session_id: returns a LoopMetricsSnapshot across all loops.
 * With session_id: returns a detailed LoopStatusSnapshot for that loop.
 */
export function createLoopStatusTool(coordinator: LoopCoordinator) {
  return defineTool({
    description:
      "Get runtime status of a loop execution or all loops. " +
      "Without session_id, returns aggregate metrics. " +
      "With session_id, returns a detailed snapshot of that loop.",
    args: {
      session_id: z
        .string()
        .optional()
        .describe(
          "Origin session ID of the loop. Omit for aggregate metrics.",
        ),
    },
    async execute(input) {
      if (input.session_id) {
        // ── Direct lookup by origin session ID ──────────────────────
        let state = coordinator.getLoopState(input.session_id);
        let matchedVia: string | null = null;

        // ── Fallback: search by worker session ID across all loops ─
        if (!state) {
          for (const s of coordinator.getAllLoopStates().values()) {
            if (s.activeWorkerSessionId === input.session_id) {
              state = s;
              matchedVia = `active worker (\`${shortenId(input.session_id)}\`)`;
              break;
            }
            if (
              s.rounds?.some(
                (r) => r.workerSessionId === input.session_id,
              )
            ) {
              state = s;
              matchedVia = `completed round worker (\`${shortenId(input.session_id)}\`)`;
              break;
            }
          }
        }

        if (!state) {
          return `No loop found for session: ${input.session_id}`;
        }

        const elapsedMs = Date.now() - state.startedAt;

        const lines: string[] = [];
        lines.push("## Loop Status");
        lines.push("");
        lines.push("| Field | Value |");
        lines.push("|-------|-------|");
        lines.push(`| Origin Session | \`${state.originSessionId}\` |`);
        lines.push(`| Agent | ${state.agent} |`);
        lines.push(`| Mode | ${state.mode} |`);
        if (state.parentLoopId) {
          lines.push(`| Parent Loop | \`${shortenId(state.parentLoopId)}\` |`);
        }
        lines.push(
          `| Phase | ${state.phase}${state.cancelRequested ? " ⛔" : ""} |`,
        );
        lines.push(`| Round | ${state.current}/${state.total} |`);
        lines.push(`| Elapsed | ${formatDurationMs(elapsedMs)} |`);

        if (state.activeWorkerSessionId) {
          lines.push(
            `| Active Worker Session | \`${state.activeWorkerSessionId}\` |`,
          );
        }
        if (state.activeWorkerTaskId) {
          lines.push(
            `| Active Worker Task | \`${state.activeWorkerTaskId}\` |`,
          );
        }
        if (state.errorReason) {
          lines.push(`| Error | ${state.errorReason} |`);
        }
        if (matchedVia) {
          lines.push(`| Matched Via | ${matchedVia} |`);
        }

        // ── Last summary (if present) ──────────────────────────────
        if (state.lastSummary) {
          lines.push("");
          lines.push("### Last Summary");
          lines.push(state.lastSummary);
        }

        // ── Round history table ────────────────────────────────────
        const rounds = state.rounds ?? [];
        if (rounds.length > 0) {
          lines.push("");
          lines.push("### Rounds");
          lines.push("| # | Worker Session | Status | Duration |");
          lines.push("|---|---------------|--------|----------|");
          for (const r of rounds) {
            const dur =
              r.durationMs !== undefined
                ? formatDurationMs(r.durationMs)
                : "—";
            lines.push(
              `| ${r.round} | \`${shortenId(r.workerSessionId, 16)}\` | ${r.status} | ${dur} |`,
            );
          }
        }

        return lines.join("\n");
      }

      // ── Aggregate metrics (no session_id) ────────────────────────
      const allStates = coordinator.getAllLoopStates();
      if (allStates.size === 0) {
        return "No loops tracked.";
      }
      const metrics = buildMetricsSnapshot(allStates, coordinator);
      return JSON.stringify(metrics, null, 2);
    },
  });
}

/**
 * loop_cancel — Cancel a running loop.
 *
 * Accepts either an origin session ID or a worker session ID.
 * Calls coordinator.cancelNow() which resolves worker→origin internally.
 */
export function createLoopCancelTool(coordinator: LoopCoordinator) {
  return defineTool({
    description:
      "Cancel a running loop by session ID (origin or worker). " +
      "The loop stops after the current round. Already-terminal loops are unaffected.",
    args: {
      session_id: z
        .string()
        .describe("Session ID of the loop to cancel (origin or worker)."),
    },
    async execute(input) {
      // Resolve session_id to the loop's origin session ID for reporting.
      // cancelNow() handles worker→origin resolution internally via the
      // private _workerToOrigin map; we only need this for the status
      // lookup after cancellation completes.
      let originId: string | undefined = input.session_id;
      if (!coordinator.getLoopState(input.session_id)) {
        // input.session_id is not a direct origin — search all loops
        // for a matching worker session (active or in round history).
        originId = undefined;
        for (const [id, state] of coordinator.getAllLoopStates()) {
          if (state.activeWorkerSessionId === input.session_id) {
            originId = id;
            break;
          }
          if (state.rounds?.some((r) => r.workerSessionId === input.session_id)) {
            originId = id;
            break;
          }
        }
      }

      // Issue cancellation — cancelNow resolves worker→origin internally
      // and cascades to all descendants.
      await coordinator.cancelNow(input.session_id);

      // Read post-cancellation state using the resolved origin ID
      const resolvedId = originId ?? input.session_id;
      const state = coordinator.getLoopState(resolvedId);

      if (!state) {
        return `No active loop found for session: ${input.session_id}`;
      }

      // Count descendants for cascade reporting
      const descendants = coordinator.getLoopDescendants(resolvedId);
      const descendantCount = descendants.length;

      const roundSummary = `round ${state.current}/${state.total}`;
      const cascadeMsg =
        descendantCount > 0
          ? ` — cascaded to ${descendantCount} descendant loop(s)`
          : "";
      return `Loop cancelled: ${state.originSessionId} (phase: ${state.phase}, ${roundSummary})${cascadeMsg}`;
    },
  });
}

/**
 * loop_output — Retrieve worker output for a specific round of a loop.
 *
 * Parallels dispatch_output: accepts round number or resolves worker session
 * from the provided session_id. Reads the worker's session messages and
 * supports max_chars / offset / tail pagination. Falls back to reading
 * session messages via the ISessionClient when available.
 */
export function createLoopOutputTool(
  coordinator: LoopCoordinator,
  sessionClient?: ISessionClient,
) {
  return defineTool({
    description:
      "Retrieve worker output for a specific loop round. " +
      "Accepts origin session ID, worker session ID, or round number. " +
      "Supports max_chars/offset/tail pagination like dispatch_output. " +
      "Without session_client, returns loop metadata only.",
    args: {
      session_id: z
        .string()
        .describe("Origin session ID or worker session ID of the loop."),
      round: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Specific round number (1-based) to retrieve output for. " +
            "Omit for the latest completed round or active worker.",
        ),
      max_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(DEFAULT_MAX_RESULT_CHARS)
        .describe(
          "Maximum characters to return in the inline result body. " +
            "Results larger than this are truncated with a next_offset hint.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Start position in the result text (0-based)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Maximum characters to return from offset, capped at max_chars.",
        ),
      tail: z
        .boolean()
        .optional()
        .describe(
          "Return the last max_chars characters of the result instead of a window from offset.",
        ),
    },
    async execute(input) {
      // ── Resolve session_id to LoopState (same fallback as loop_status) ──
      let state = coordinator.getLoopState(input.session_id);
      let matchedVia: string | null = null;
      let resolvedWorkerFromLookup: string | undefined;

      if (!state) {
        for (const s of coordinator.getAllLoopStates().values()) {
          if (s.activeWorkerSessionId === input.session_id) {
            state = s;
            resolvedWorkerFromLookup = s.activeWorkerSessionId;
            matchedVia = `active worker (\`${shortenId(input.session_id)}\`)`;
            break;
          }
          const matchingRound = s.rounds?.find(
            (r) => r.workerSessionId === input.session_id,
          );
          if (matchingRound) {
            state = s;
            resolvedWorkerFromLookup = matchingRound.workerSessionId;
            matchedVia = `completed round worker (\`${shortenId(input.session_id)}\`)`;
            break;
          }
        }
      }

      if (!state) {
        return `No loop found for session: ${input.session_id}`;
      }

      // ── Determine target worker session ──────────────────────────
      let workerSessionId: string | undefined;
      let roundLabel: string;

      if (input.round !== undefined) {
        const target = state.rounds?.find((r) => r.round === input.round);
        if (!target) {
          const available =
            state.rounds?.map((r) => String(r.round)).join(", ") ?? "none";
          return (
            `Round ${input.round} not found for loop ${state.originSessionId}. ` +
            `Available rounds: ${available}.`
          );
        }
        workerSessionId = target.workerSessionId;
        roundLabel = `round ${input.round}`;
      } else if (resolvedWorkerFromLookup) {
        workerSessionId = resolvedWorkerFromLookup;
        roundLabel = `matched via ${matchedVia}`;
      } else {
        const rounds = state.rounds ?? [];
        const lastRound = rounds[rounds.length - 1];
        if (lastRound) {
          workerSessionId = lastRound.workerSessionId;
          roundLabel = `round ${lastRound.round} (latest completed)`;
        } else if (state.activeWorkerSessionId) {
          workerSessionId = state.activeWorkerSessionId;
          roundLabel = `active round ${state.current}`;
        } else {
          roundLabel = "none";
        }
      }

      // ── Build header ────────────────────────────────────────────
      const lines: string[] = [];
      lines.push("## Loop Output");
      lines.push("");
      lines.push("| Field | Value |");
      lines.push("|-------|-------|");
      lines.push(
        `| Origin Session | \`${state.originSessionId}\` |`,
      );
      lines.push(`| Agent | ${state.agent} |`);
      lines.push(`| Phase | ${state.phase} |`);
      lines.push(`| Round | ${state.current}/${state.total} |`);
      lines.push(`| Target | ${roundLabel} |`);
      if (matchedVia) {
        lines.push(`| Matched Via | ${matchedVia} |`);
      }
      if (workerSessionId) {
        lines.push(
          `| Worker Session | \`${shortenId(workerSessionId, 24)}\` |`,
        );
      }
      if (state.errorReason) {
        lines.push(`| Error | ${state.errorReason} |`);
      }

      if (!workerSessionId) {
        lines.push("");
        lines.push(
          "No worker session available yet — the loop has not dispatched any rounds.",
        );
        return lines.join("\n");
      }

      // ── Read worker session messages ──────────────────────────────
      if (!sessionClient) {
        lines.push("");
        lines.push(
          "No session client available — cannot read worker output.",
        );
        lines.push(
          `Use \`session_read(session_id="${workerSessionId}")\` to read the worker session.`,
        );
        return lines.join("\n");
      }

      let workerText = "";
      try {
        const messages = await sessionClient.messages(workerSessionId);
        if (messages && messages.length > 0) {
          const textParts: string[] = [];
          for (const msg of messages) {
            if (msg.info?.role === "assistant" && msg.parts) {
              for (const part of msg.parts) {
                if (
                  part.type === "text" &&
                  "text" in part &&
                  typeof part.text === "string"
                ) {
                  textParts.push(part.text);
                }
              }
            }
          }
          workerText = textParts.join("");
        }
      } catch {
        // Worker session may not be accessible — continue with what we have
      }

      lines.push("");

      // ── Apply pagination ──────────────────────────────────────────
      const maxChars = input.max_chars ?? DEFAULT_MAX_RESULT_CHARS;
      const offset = input.offset ?? 0;
      const limit = Math.min(input.limit ?? maxChars, maxChars);
      const tail = input.tail ?? false;

      if (workerText) {
        const windowed = applyWindow(workerText, {
          maxChars,
          offset,
          limit,
          tail,
        });
        lines.push("---");
        lines.push("");
        lines.push(windowed.text);

        // Pagination envelope (mirrors dispatch_output envelope format)
        const envelopeParts: string[] = [];
        envelopeParts.push(
          `[result ${windowed.returnedChars}/${windowed.totalChars} chars]`,
        );
        if (windowed.truncated) {
          envelopeParts.push("(truncated)");
        }
        if (windowed.nextOffset !== undefined) {
          envelopeParts.push(`next_offset=${windowed.nextOffset}`);
        }
        if (envelopeParts.length > 0) {
          lines.push("");
          lines.push(envelopeParts.join(" "));
        }
      } else {
        lines.push("---");
        lines.push("");
        lines.push("(no output text from worker session)");
      }

      return lines.join("\n");
    },
  });
}

/**
 * loop_history — Retrieve full round-by-round execution history.
 *
 * Returns an array of LoopHistoryEntry records for all completed rounds
 * of the given loop.
 */
export function createLoopHistoryTool(coordinator: LoopCoordinator) {
  return defineTool({
    description:
      "Retrieve round-by-round execution history for a loop. " +
      "Each entry includes the worker session ID, timing, and status. " +
      "Optionally filter to a specific round number.",
    args: {
      session_id: z
        .string()
        .describe("Origin session ID of the loop."),
      round: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter to a specific round number (1-based). Omit for all rounds."),
    },
    async execute(input) {
      const state = coordinator.getLoopState(input.session_id);
      if (!state) {
        return `No loop found for session: ${input.session_id}`;
      }

      let rounds = state.rounds ?? [];

      if (input.round !== undefined) {
        rounds = rounds.filter(r => r.round === input.round);
      }

      if (rounds.length === 0) {
        if (input.round !== undefined) {
          return `No round ${input.round} found for loop ${input.session_id} (phase: ${state.phase}, total rounds: ${state.total}).`;
        }
        return `Loop ${input.session_id} has no completed rounds yet (phase: ${state.phase}, round ${state.current}/${state.total}).`;
      }

      const lines: string[] = [
        `## Loop Round History`,
        ``,
        `Session: \`${input.session_id}\` | Agent: ${state.agent} | Mode: ${state.mode} | Phase: ${state.phase}`,
        ``,
      ];

      lines.push("| Round | Worker Session | Status | Duration | Started At |");
      lines.push("|-------|---------------|--------|----------|------------|");

      for (const r of rounds) {
        const shortId = r.workerSessionId.length > 24
          ? r.workerSessionId.slice(0, 21) + "..."
          : r.workerSessionId;
        const duration = r.durationMs !== undefined
          ? `${(r.durationMs / 1000).toFixed(1)}s`
          : "-";
        const started = new Date(r.startedAt).toISOString();

        lines.push(
          `| ${r.round} | ${shortId} | ${r.status} | ${duration} | ${started} |`,
        );
      }

      return lines.join("\n");
    },
  });
}

/**
 * loop_list — List all tracked loop instances.
 *
 * Returns a markdown table (or JSON) of all loops with session ID,
 * agent, phase, round progress, elapsed time, and mode.
 * Supports optional filtering by phase (running/terminal) and agent name.
 */
export function createLoopListTool(coordinator: LoopCoordinator) {
  return defineTool({
    description:
      "List loop executions tracked by the coordinator. " +
      "Filter by phase (running/terminal) and/or agent. " +
      "Returns a table with origin session ID, agent, phase, round progress, elapsed time, and mode.",
    args: {
      phase: z
        .enum(["running", "terminal"])
        .optional()
        .describe(
          "Filter by phase: 'running' for active loops (activating/dispatching/awaiting_worker/summarizing/finalizing), " +
            "'terminal' for finished loops (complete/cancelled/error/interrupted). Omit for all.",
        ),
      agent: z
        .string()
        .optional()
        .describe(
          "Filter by agent name (case-insensitive substring match). Omit for all agents.",
        ),
      format: z
        .enum(["summary", "json"])
        .optional()
        .default("summary")
        .describe(
          "Output format: 'summary' for human-readable table, 'json' for machine parsing",
        ),
    },
    async execute(input) {
      const allStates = coordinator.getAllLoopStates();

      // ── Convert to array for filtering ──────────────────────────
      let entries = [...allStates.entries()];

      // ── Phase filter ─────────────────────────────────────────────
      if (input.phase === "running") {
        entries = entries.filter(([, s]) => !TERMINAL_PHASE_SET.has(s.phase));
      } else if (input.phase === "terminal") {
        entries = entries.filter(([, s]) => TERMINAL_PHASE_SET.has(s.phase));
      }

      // ── Agent filter ─────────────────────────────────────────────
      if (input.agent) {
        const agentLower = input.agent.toLowerCase();
        entries = entries.filter(([, s]) =>
          s.agent.toLowerCase().includes(agentLower),
        );
      }

      // ── Empty result ─────────────────────────────────────────────
      if (entries.length === 0) {
        const extras: string[] = [];
        if (input.phase) extras.push(`phase=${input.phase}`);
        if (input.agent) extras.push(`agent="${input.agent}"`);
        const filterDesc =
          extras.length > 0 ? ` (${extras.join(", ")})` : "";
        return `No loops found${filterDesc}.`;
      }

      // ── JSON output ──────────────────────────────────────────────
      if (input.format === "json") {
        const now = Date.now();
        const jsonEntries = entries.map(([id, state]) => ({
          sessionId: id,
          agent: state.agent,
          mode: state.mode,
          phase: state.phase,
          rounds: `${state.current}/${state.total}`,
          elapsedMs: now - state.startedAt,
          cancelRequested: state.cancelRequested,
          startedAt: state.startedAt,
          updatedAt: state.updatedAt,
          errorReason: state.errorReason,
          parentLoopId: state.parentLoopId ?? null,
        }));
        return JSON.stringify(jsonEntries, null, 2);
      }

      // ── Markdown table (summary format) ──────────────────────────
      // Build tree from parentLoopId relationships, flatten with indentation.
      const treeEntries = buildAndFlattenTree(entries);
      const hasTree = treeEntries.some((e) => e.depth > 0);

      const now = Date.now();
      const lines: string[] = [
        "## Loop List",
        "",
        `Total: ${entries.length} loop(s)`,
        "",
      ];

      if (hasTree) {
        lines.push(
          "| Session ID        | Agent | Phase | Rounds | Elapsed | Mode |",
        );
        lines.push(
          "|-------------------|-------|-------|--------|---------|------|",
        );
      } else {
        lines.push(
          "| Session ID | Agent | Phase | Rounds | Elapsed | Mode |",
        );
        lines.push(
          "|-----------|-------|-------|--------|---------|------|",
        );
      }

      for (const entry of treeEntries) {
        const { id, state } = entry;
        const shortId = id.length > 24 ? id.slice(0, 21) + "..." : id;
        const flag = state.cancelRequested ? " ⛔" : "";
        const elapsed = formatDurationMs(now - state.startedAt);
        const treePrefix = renderTreePrefix(entry.ancestorsLast, entry.isLast);
        const cell = `${treePrefix}${shortId}`;
        lines.push(
          `| ${cell} | ${state.agent} | ${state.phase}${flag} | ${state.current}/${state.total} | ${elapsed} | ${state.mode} |`,
        );
      }

      lines.push("");
      lines.push(
        "Use loop_status(session_id=\"...\") for detailed state, " +
          "loop_history(session_id=\"...\") for round-by-round history.",
      );

      return lines.join("\n");
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Registration helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register all loop tool factories into a named record.
 *
 * Returns an object suitable for merging into a platform tool registry:
 *
 *   const coordinator = new LoopCoordinator(adapter);
 *   const loopTools = createLoopTools(coordinator, sessionClient);
 *   platform.registerTools(loopTools);
 */
export function createLoopTools(
  coordinator: LoopCoordinator,
  sessionClient?: ISessionClient,
) {
  return {
    loop_status: createLoopStatusTool(coordinator),
    loop_cancel: createLoopCancelTool(coordinator),
    loop_output: createLoopOutputTool(coordinator, sessionClient),
    loop_history: createLoopHistoryTool(coordinator),
    loop_list: createLoopListTool(coordinator),
  };
}
