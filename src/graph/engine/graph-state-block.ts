/**
 * Graph Execution Engine v2 — per-turn `<graph_state>` system-prompt block.
 *
 * Renders the live in-memory graph registry into a compact orientation block
 * injected into the system prompt each turn: "where am I in the workflow,
 * what runs next", sourced from {@link EngineState} (the engine-v2 runtime).
 *
 * The renderer is deliberately pure and defensive. It takes a snapshot list
 * (see `GraphToolSet.liveEngineStates()`), renders only the fields that are
 * present, and returns `""` when there is nothing to show. The injection site
 * treats an empty string as a clean no-op, so no stray tags ever reach the
 * prompt when no graph is live.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md`.
 */

import { NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";

/** Minimal XML text/attribute escaper — graph names are user-supplied. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeList(state: EngineState): NodeRuntimeState[] {
  return state.nodes ? [...state.nodes.values()] : [];
}

function joinIds(nodes: readonly NodeRuntimeState[]): string {
  return nodes.length > 0 ? nodes.map((n) => esc(n.nodeId)).join(", ") : "none";
}

function renderGraph(state: EngineState): string {
  const graphId = state.graphId ?? "?";
  const phase = state.phase ?? "idle";
  const name = state.graphDeclaration?.name ?? graphId;

  const active = nodeList(state).filter((n) => n.status === NodeStatus.Running);
  const pending = nodeList(state).filter(
    (n) => n.status === NodeStatus.Pending || n.status === NodeStatus.Ready,
  );
  const blocked = nodeList(state).filter((n) => n.status === NodeStatus.Blocked);

  const lines: string[] = [];
  lines.push(`  <graph id="${esc(graphId)}" phase="${esc(phase)}">`);
  lines.push(`    <name>${esc(name)}</name>`);
  lines.push(`    <active_nodes>${joinIds(active)}</active_nodes>`);
  lines.push(`    <pending_nodes>${joinIds(pending)}</pending_nodes>`);

  const loops = state.loopGroups ? [...state.loopGroups.values()] : [];
  if (loops.length > 0) {
    lines.push("    <loop_groups>");
    for (const g of loops) {
      const count = g.traversalCount ?? 0;
      const cap = g.maxTraversals ?? 0;
      lines.push(`      <loop id="${esc(g.id)}" traversals="${esc(count)}/${esc(cap)}" />`);
    }
    lines.push("    </loop_groups>");
  }

  if (blocked.length > 0) {
    lines.push("    <blocked_nodes>");
    for (const n of blocked) {
      const reason = n.errorReason ? esc(n.errorReason) : "awaiting human approval";
      lines.push(
        `      <node id="${esc(n.nodeId)}" needs_approval="${
          n.needsApproval ? "true" : "false"
        }">${reason}</node>`,
      );
    }
    lines.push("    </blocked_nodes>");
  }

  lines.push("  </graph>");
  return lines.join("\n");
}

/**
 * Render the `<graph_state>` block for the given live engine snapshots.
 *
 * @param states Engine-state snapshots, typically
 *   `GraphToolSet.liveEngineStates()`. Each becomes one `<graph>` element in
 *   registry order.
 * @returns the block, or `""` when `states` is empty (no live graph) — the
 *   caller treats the empty string as a clean no-op.
 */
export function buildEngineGraphStateBlock(states: readonly EngineState[]): string {
  if (!states || states.length === 0) return "";
  const graphs = states.map(renderGraph);
  return `<graph_state>\n${graphs.join("\n")}\n</graph_state>`;
}
