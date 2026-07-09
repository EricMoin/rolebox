import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stateDirFor } from "../utils/state-paths.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("hook:state-reader");

// ── Public Types ────────────────────────────────────────────────────────────

export interface DispatchTaskSummary {
  id: string;
  agent: string;
  status: string;
  startedAt?: string;
}

export interface GraphSessionSummary {
  sessionId: string;
  agentId: string;
  frontierLength: number;
  completedLength: number;
  iterationCount: number;
  status: string;
  statusEmoji: string;
  topologyLabel: string;
  terminationReason?: string | null;
}

export interface FunctionStateSummary {
  sessionId: string;
  functions: { name: string; phase: string }[];
}

export interface LoopStateSummary {
  id: string;
  agent: string;
  current: number;
  total: number;
  phase: string;
}

export interface RoleboxRuntimeState {
  dispatchTasks: DispatchTaskSummary[];
  graphSessions: GraphSessionSummary[];
  functionSessions: FunctionStateSummary[];
  loops: LoopStateSummary[];
}

// ── Reader ──────────────────────────────────────────────────────────────────

/**
 * Read all rolebox runtime state files from the .rolebox/state/ directory.
 *
 * Each state type is read defensively — if the file is missing, corrupt, or
 * unreadable, the entry is silently skipped (with a warning log) and an empty
 * array is returned for that section.
 */
export function readRuntimeState(dir: string): RoleboxRuntimeState {
  const stateDir = stateDirFor(dir);

  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  } catch {
    // Directory doesn't exist yet — clean start, no state to report
    return {
      dispatchTasks: [],
      graphSessions: [],
      functionSessions: [],
      loops: [],
    };
  }

  // Parse each file based on its type prefix
  const dispatchTasks = readDispatchState(stateDir, files);
  const graphSessions = readGraphState(stateDir, files);
  const functionSessions = readFunctionState(stateDir, files);
  const loops = readLoopState(stateDir, files);

  return { dispatchTasks, graphSessions, functionSessions, loops };
}

// ── Per-type readers ────────────────────────────────────────────────────────

function readDispatchState(
  stateDir: string,
  files: string[],
): DispatchTaskSummary[] {
  const file = files.find((f) => f.startsWith("dispatch-"));
  if (!file) return [];

  try {
    const raw = readFileSync(join(stateDir, file), "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      tasks?: Array<{
        id?: string;
        agent?: string;
        status?: string;
        startedAt?: string;
      }>;
    };

    if (!Array.isArray(parsed.tasks)) return [];

    return parsed.tasks.map((t) => ({
      id: t.id ?? "unknown",
      agent: t.agent ?? "unknown",
      status: t.status ?? "unknown",
      startedAt: t.startedAt,
    }));
  } catch (err) {
    log.warn("Failed to read dispatch state file", err);
    return [];
  }
}

function readGraphState(
  stateDir: string,
  files: string[],
): GraphSessionSummary[] {
  const file = files.find((f) => f.startsWith("graph-"));
  if (!file) return [];

  try {
    const raw = readFileSync(join(stateDir, file), "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      sessions?: Array<{
        sessionId?: string;
        agentId?: string;
        state?: {
          frontier?: string[];
          completed?: string[];
          iterationCount?: number;
          status?: string;
          terminationReason?: string | null;
        };
      }>;
    };

    if (!Array.isArray(parsed.sessions)) return [];

    return parsed.sessions
      .filter((s) => s.state != null)
      .map((s) => {
        const st = s.state!;
        const status = st.status ?? "unknown";
        return {
          sessionId: s.sessionId ?? "unknown",
          agentId: s.agentId ?? "unknown",
          frontierLength: Array.isArray(st.frontier) ? st.frontier.length : 0,
          completedLength: Array.isArray(st.completed) ? st.completed.length : 0,
          iterationCount: st.iterationCount ?? 0,
          status,
          statusEmoji: status === "active" ? "▶" : status === "complete" ? "✓" : status === "exhausted" ? "✗" : "?",
          topologyLabel: guessTopology(s.agentId ?? ""),
          terminationReason: st.terminationReason ?? null,
        };
      });
  } catch (err) {
    log.warn("Failed to read graph state file", err);
    return [];
  }
}

function readFunctionState(
  stateDir: string,
  files: string[],
): FunctionStateSummary[] {
  const file = files.find((f) => f.startsWith("fnstate-"));
  if (!file) return [];

  try {
    const raw = readFileSync(join(stateDir, file), "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      sessions?: Array<{
        sessionId?: string;
        fns?: Array<{ name?: string; state?: { phase?: string } }>;
      }>;
    };

    if (!Array.isArray(parsed.sessions)) return [];

    return parsed.sessions
      .filter((s) => Array.isArray(s.fns))
      .map((s) => ({
        sessionId: s.sessionId ?? "unknown",
        functions: s.fns!
          .filter((f) => f.name)
          .map((f) => ({
            name: f.name!,
            phase: f.state?.phase ?? "unknown",
          })),
      }));
  } catch (err) {
    log.warn("Failed to read function state file", err);
    return [];
  }
}

function readLoopState(
  stateDir: string,
  files: string[],
): LoopStateSummary[] {
  const file = files.find((f) => f.startsWith("loops-"));
  if (!file) return [];

  try {
    const raw = readFileSync(join(stateDir, file), "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      loops?: Array<{
        id?: string;
        state?: {
          agent?: string;
          current?: number;
          total?: number;
          phase?: string;
        };
      }>;
    };

    if (!Array.isArray(parsed.loops)) return [];

    return parsed.loops
      .filter((l) => l.state != null)
      .map((l) => ({
        id: l.id ?? "unknown",
        agent: l.state!.agent ?? "unknown",
        current: l.state!.current ?? 0,
        total: l.state!.total ?? 0,
        phase: l.state!.phase ?? "unknown",
      }));
  } catch (err) {
    log.warn("Failed to read loop state file", err);
    return [];
  }
}

// ── Heuristics ──────────────────────────────────────────────────────────────

/**
 * Guess topology label from agent ID name conventions.
 * Falls back to "unknown" when no heuristics match.
 */
function guessTopology(agentId: string): string {
  const lower = agentId.toLowerCase();
  if (lower.includes("loop") || lower.includes("review")) return "review-loop";
  if (lower.includes("rail") || lower.includes("nested")) return "nested-rail";
  if (lower.includes("serial") || lower.includes("chain")) return "serial-chain";
  if (lower.includes("parallel") || lower.includes("fan")) return "parallel-fan";
  return "unknown";
}
