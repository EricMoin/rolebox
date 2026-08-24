/// <reference types="bun-types" />

/**
 * Component-level tests for the engine-graph live node-status overlay.
 *
 * Subtask 5 of the TUI live-state fix: `renderEngineGraphActivity` folds the
 * node-scoped live-status map (`${graphId}::${nodeId}` → status, fed from the
 * 250ms graph-event poll) over the disk snapshot's `node.status` (which lags
 * up to the 1s snapshot poll). These tests render the real component through
 * @opentui/solid's headless test renderer and assert on the captured frame.
 *
 * The TUI's JSX transform (babel-preset-solid via the build's bun plugin) must
 * be registered before any `.tsx` module loads, so the component is imported
 * dynamically after `Bun.plugin` runs.
 */

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import type {
  EngineGraphSnapshot,
  GraphNodeSnapshot,
} from "../../src/cli/commands/monitor/monitor-reader-types";
import type { ThemeColors } from "../../src/tui/helpers";
import { G_RUNNING, G_DONE } from "../../src/tui/helpers";

// Same transform the TUI build applies (`scripts/build-tui.ts`).
Bun.plugin(createSolidTransformPlugin({ moduleName: "@opentui/solid" }));

type EngineGraphActivityProps = {
  c: ThemeColors;
  graph: EngineGraphSnapshot;
  nodeSignals?: ReadonlyMap<string, string>;
};

let renderEngineGraphActivity: (props: EngineGraphActivityProps) => unknown;

beforeAll(async () => {
  const mod = await import("../../src/tui/components/Activity");
  renderEngineGraphActivity = mod.renderEngineGraphActivity;
});

// ── Fixtures ────────────────────────────────────────────────────────────

const c: ThemeColors = {
  info:      RGBA.fromValues(80, 160, 255, 1),
  success:   RGBA.fromValues(80, 200, 120, 1),
  warning:   RGBA.fromValues(255, 200, 80, 1),
  error:     RGBA.fromValues(255, 80, 80, 1),
  secondary: RGBA.fromValues(180, 180, 200, 1),
  textMuted: RGBA.fromValues(140, 140, 160, 1),
  text:      RGBA.fromValues(220, 220, 230, 1),
};

function makeNode(overrides: Partial<GraphNodeSnapshot> = {}): GraphNodeSnapshot {
  return {
    nodeId: "n1",
    agent: "emperor--jinyiwei--ui",
    status: "completed",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEngineGraph(overrides: Partial<EngineGraphSnapshot> = {}): EngineGraphSnapshot {
  const nodes = overrides.nodes ?? [makeNode()];
  return {
    graphId: "g1",
    phase: "complete",
    nodeCount: nodes.length,
    nodeStatusCounts: { completed: nodes.length },
    nodes,
    budget: { sessionsSpawned: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 },
    frontier: [],
    loopGroups: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(),
    hasCheckpoints: false,
    ...overrides,
  };
}

// ── Render harness ──────────────────────────────────────────────────────

let setup: TestRendererSetup | undefined;

async function renderWith(
  graph: EngineGraphSnapshot,
  nodeSignals?: ReadonlyMap<string, string>,
): Promise<string> {
  setup = await testRender(
    () => renderEngineGraphActivity({ c, graph, nodeSignals }),
    { width: 60, height: 12 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

afterEach(async () => {
  if (setup) {
    // Detach the headless renderer so later tests start from a clean frame.
    (setup.renderer as unknown as { destroy?: () => void }).destroy?.();
    setup = undefined;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("renderEngineGraphActivity live node-status overlay", () => {
  it("renders the running glyph when a live entry says running but the snapshot says completed", async () => {
    // Snapshot status: completed. Live event fold (sub-250ms poll): running.
    const graph = makeEngineGraph({ nodes: [makeNode({ status: "completed" })] });
    const live = new Map<string, string>([["g1::n1", "running"]]);

    const frame = await renderWith(graph, live);

    // The node row must show the running glyph, not the snapshot's done glyph.
    expect(frame).toContain(G_RUNNING + " ui");
    expect(frame).not.toContain(G_DONE + " ui");
  });

  it("falls back to the snapshot status when no live entry exists", async () => {
    const graph = makeEngineGraph({ nodes: [makeNode({ status: "completed" })] });

    const frame = await renderWith(graph, /* no nodeSignals */ undefined);

    // No live overlay → the snapshot's completed status drives the glyph.
    expect(frame).toContain(G_DONE + " ui");
    expect(frame).not.toContain(G_RUNNING + " ui");
  });

  it("lets a live completed entry beat a stale running snapshot", async () => {
    // The symmetric direction: the event fold already observed the terminal
    // transition, so the renderer must not keep showing a stale running glyph.
    const graph = makeEngineGraph({ nodes: [makeNode({ status: "running" })] });
    const live = new Map<string, string>([["g1::n1", "completed"]]);

    const frame = await renderWith(graph, live);

    expect(frame).toContain(G_DONE + " ui");
    expect(frame).not.toContain(G_RUNNING + " ui");
  });
});
