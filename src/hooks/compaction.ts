import { createSubLogger } from "../logger.ts";
import { readRuntimeState } from "./state-reader.ts";

const log = createSubLogger("hook:compaction");

/**
 * Maximum total characters of context strings to inject.
 * Keeps compaction context concise and avoids bloating the prompt.
 * Each section is ~300-500 chars; with 4 sections, this cap gives plenty of room.
 */
const MAX_CONTEXT_CHARS = 2000;

/**
 * Handle the `experimental.session.compacting` hook.
 *
 * Reads rolebox runtime state (dispatch tasks, graph progress, function state,
 * loop coordinator state) from persisted state files and injects a concise
 * summary into the compaction context so critical state survives compression.
 *
 * Fully defensive: missing or corrupt state files silently produce empty
 * sections — never crashes compaction.
 */
export async function handleCompacting(
  _input: { sessionID: string },
  output: { context: string[]; prompt?: string },
  dir: string,
): Promise<void> {
  log.debug("Compaction hook triggered");

  let state;
  try {
    state = readRuntimeState(dir);
  } catch (err) {
    log.warn("Failed to read runtime state for compaction", err);
    return;
  }

  const blocks: string[] = [];

  // ── Dispatch Tasks ────────────────────────────────────────────────
  if (state.dispatchTasks.length > 0) {
    const lines: string[] = ["### Active Dispatch Tasks"];
    for (const t of state.dispatchTasks) {
      const started = t.startedAt ? `, started=${t.startedAt}` : "";
      lines.push(`- Task ${t.id}: agent=${t.agent}, status=${t.status}${started}`);
    }
    blocks.push(lines.join("\n"));
  }

  // ── Graph Sessions ────────────────────────────────────────────────
  if (state.graphSessions.length > 0) {
    const lines: string[] = ["### Collaboration Graph"];
    for (const g of state.graphSessions) {
      const topo = g.topologyLabel;
      const iter = g.iterationCount > 0 ? `, iteration=${g.iterationCount}` : "";
      const term = g.terminationReason ? `, reason=${g.terminationReason}` : "";
      lines.push(
        `- ${g.statusEmoji} Agent=${g.agentId}, topology=${topo}, status=${g.status}, ` +
        `frontier=${g.frontierLength}, completed=${g.completedLength}${iter}${term}`,
      );
    }
    blocks.push(lines.join("\n"));
  }

  // ── Function State ────────────────────────────────────────────────
  if (state.functionSessions.length > 0) {
    const lines: string[] = ["### Function State"];
    for (const s of state.functionSessions) {
      if (s.functions.length === 0) continue;
      const fnNames = s.functions.map((f) => f.name).join(", ");
      const phases = s.functions.map((f) => `${f.name}=${f.phase}`).join(", ");
      lines.push(`- Session=${s.sessionId}: ${fnNames} (${phases})`);
    }
    if (lines.length > 1) {
      blocks.push(lines.join("\n"));
    }
  }

  // ── Loop Coordinator ──────────────────────────────────────────────
  if (state.loops.length > 0) {
    const lines: string[] = ["### Loop Coordinator"];
    for (const l of state.loops) {
      lines.push(
        `- Loop ${l.id}: agent=${l.agent}, phase=${l.phase}, round=${l.current}/${l.total}`,
      );
    }
    blocks.push(lines.join("\n"));
  }

  // Nothing to inject
  if (blocks.length === 0) {
    log.debug("No runtime state to inject into compaction context");
    return;
  }

  // Assemble the context string within the character cap
  let totalChars = 0;
  const header = "## Rolebox Runtime State (preserve across compaction)";
  const contextLines: string[] = [header, ""];

  for (const block of blocks) {
    const needed = block.length + 1; // +1 for newline separator
    if (totalChars + needed > MAX_CONTEXT_CHARS) {
      contextLines.push(
        "_(additional state truncated — too large for compaction context)_",
      );
      break;
    }
    contextLines.push(block);
    contextLines.push("");
    totalChars += needed;
  }

  const contextString = contextLines.join("\n");

  // Push context strings — one per logical section
  output.context.push(contextString);

  log.debug("Injected runtime state into compaction context", {
    charCount: contextString.length,
    dispatchTasks: state.dispatchTasks.length,
    graphSessions: state.graphSessions.length,
    functionSessions: state.functionSessions.length,
    loops: state.loops.length,
  });
}
