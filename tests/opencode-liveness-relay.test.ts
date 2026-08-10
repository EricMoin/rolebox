/**
 * OpenCode node-liveness relay regression tests (false-positive fix).
 *
 * Confirmed bug (live reproduction on the opencode platform): graph node
 * subagents are dispatched through the opencode SDK (`session.create`), so
 * their activity events (`part.created` / `part.updated` / `message.updated`)
 * arrive at the plugin's `event` hook. But nothing relayed them into the
 * graph engine's liveness machinery:
 *
 *   - `tool-service` built the opencode GraphToolSet WITHOUT a liveness feed,
 *     so engines never populated the `sessionId → nodeId` reverse index
 *     (`resolveSessionOwner` always returned undefined);
 *   - `hook-service`'s `event` handler never called
 *     `recordLivenessHeartbeat`, so `lastActivityAt` froze at the launch-time
 *     `dispatch` heartbeat (engine-advance.ts `_dispatchNode`);
 *   - the NodeLivenessMonitor then hard-stalled (escalate/timeout) EVERY node
 *     whose subagent worked longer than the warn+grace deadline (~90 s).
 *
 * These tests drive the REAL opencode stack (PluginCore → ToolService →
 * HookService + a real DispatchManager over a recording SDK client):
 *
 *   1. The tool-service feed threading is proven by `resolveSessionOwner`
 *      resolving the dispatched subagent session to its node.
 *   2. The hook-service relay is proven by firing the `event` handler with
 *      part.* activity and observing the node's liveness heartbeat update
 *      (`heartbeatSource: "session"`).
 *   3. An active-but-slow node (session heartbeats every 20 s across 120 s of
 *      virtual time) is NOT escalated or timed out; a genuinely idle node
 *      still warns (stalling) then hard-stalls (timeout).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { PluginCore } from "../src/core/plugin-core.ts";
import { HotReloadService } from "../src/core/services/hot-reload-service.ts";
import { DispatchService } from "../src/core/services/dispatch-service.ts";
import { LoopService } from "../src/core/services/loop-service.ts";
import { LspService } from "../src/core/services/lsp-service.ts";
import { NotificationService } from "../src/core/services/notification-service.ts";
import { SessionService } from "../src/core/services/session-service.ts";
import { RecoveryService } from "../src/core/services/recovery-service.ts";
import { ExtensionService } from "../src/core/services/extension-service.ts";
import { ToolService } from "../src/core/services/tool-service.ts";
import { HookService } from "../src/core/services/hook-service.ts";
import { HealthMonitorService } from "../src/core/services/health-monitor-service.ts";
import { OpencodeSessionAdapter } from "../src/platform/adapters/opencode/session.ts";
import type { ResolvedRole, ResolvedFunction } from "../src/types.ts";
import { RoleMode } from "../src/constants.ts";
import type { NodeLivenessMonitor } from "../src/graph/engine/engine-recovery.ts";
import type { EngineState } from "../src/types.engine-v2.ts";
import { NodeStatus } from "../src/constants.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SUBAGENT_SESSION_ID = "test-session-1";

function makePrimaryRole(): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
    } as never,
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** SDK client whose session.create yields the stable subagent session id. */
function makeMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: SUBAGENT_SESSION_ID }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: SUBAGENT_SESSION_ID }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

/** Let chained setTimeout-driven dispatch/advancement drain. */
const settle = () => new Promise((r) => setTimeout(r, 50));

interface Stack {
  core: PluginCore;
  toolService: ToolService;
  hookService: HookService;
  toolset: NonNullable<ReturnType<ToolService["getGraphToolSet"]>>;
  eventHandler: (input: { event: unknown }) => Promise<void>;
}

let tmpDir: string;
let stack: Stack | undefined;

async function buildStack(): Promise<Stack> {
  const client = makeMockClient();
  const core = new PluginCore();
  core.registerService(new HotReloadService());
  core.registerService(new DispatchService());
  core.registerService(new LoopService());
  core.registerService(new LspService());
  core.registerService(new NotificationService());
  core.registerService(new SessionService());
  core.registerService(new RecoveryService());
  core.registerService(new ExtensionService());
  core.registerService(new ToolService());
  core.registerService(new HookService());
  core.registerService(new HealthMonitorService());

  await core.init({
    session: new OpencodeSessionAdapter(client),
    resolvedRoles: [makePrimaryRole()],
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
    roleGraphMap: new Map(),
    rawDirectory: tmpDir,
    directory: tmpDir,
    core,
    bus: core.getBus(),
  });

  const toolService = core.getService<ToolService>("tool-service")!;
  const hookService = core.getService<HookService>("hook-service")!;
  const toolset = toolService.getGraphToolSet();
  if (!toolset) throw new Error("toolset not built");
  const eventHandler = (input: { event: unknown }) =>
    (hookService.getHandlers() as unknown as {
      event: (input: { event: unknown }) => Promise<void>;
    }).event(input);

  return { core, toolService, hookService, toolset, eventHandler };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-oc-liveness-"));
});

afterEach(async () => {
  try {
    await stack?.core.dispose();
  } catch {
    // best effort — never let teardown mask a test failure
  }
  stack = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  mock.restore();
});

// ── The opencode false-positive regression ───────────────────────────────────

describe("opencode liveness relay — subagent activity keeps graph nodes alive", () => {
  it("threads the feed so the reverse index resolves; relays part.* events into heartbeats; an active node is NOT stalled; a genuinely idle node IS flagged", async () => {
    stack = await buildStack();
    const { core, toolset, eventHandler } = stack;

    try {
      // 1. Create + provision + run a single-node graph through the REAL
      //    opencode assembly (ToolService-built toolset, real DispatchManager
      //    over the mock SDK client).
      const created = toolset.graph_create({ name: "oc-relay" }, "s1");
      const graphId = created.graph_id;
      toolset.graph_add_node(
        { graph_id: graphId, id: "A", agent: "a1", prompt: "work" },
        "s1",
      );
      await toolset.graph_run({ graph_id: graphId }, "s1");
      await settle();

      // 2. THE feed-threading assertion: the dispatched subagent session
      //    resolves to node A through the reverse index. Before the fix the
      //    opencode toolset carried no liveness feed, so the index was never
      //    populated and this returned undefined.
      const owner = toolset.resolveSessionOwner(SUBAGENT_SESSION_ID);
      expect(owner).toBeDefined();
      expect(owner!.nodeId).toBe("A");
      const runtime = owner!.runtime;

      let node = runtime.status().nodes.get("A")!;
      expect(node.status).toBe(NodeStatus.Running);
      // Launch heartbeat present (feed wired → dispatch heartbeat recorded).
      expect(node.liveness?.heartbeatSource).toBe("dispatch");

      // 3. THE relay assertion: subagent activity arriving through the
      //    plugin's `event` hook must refresh the node's heartbeat. Before the
      //    fix the opencode event handler never relayed, so lastActivityAt
      //    froze at the dispatch heartbeat and the node was falsely
      //    hard-stalled past the deadline.
      const before = node.liveness!.lastActivityAt!;
      await eventHandler({
        event: {
          type: "part.created",
          properties: { sessionID: SUBAGENT_SESSION_ID },
        },
      });
      await eventHandler({
        event: {
          type: "part.updated",
          properties: { sessionID: SUBAGENT_SESSION_ID },
        },
      });
      node = runtime.status().nodes.get("A")!;
      expect(node.status).toBe(NodeStatus.Running);
      expect(node.liveness!.heartbeatSource).toBe("session");
      expect(node.liveness!.lastActivityAt!).toBeGreaterThanOrEqual(before);

      // 4. Reach the engine internals for deterministic monitor ticks (same
      //    cast convention as the engine liveness-wiring tests).
      const liveState = (runtime as unknown as { state: EngineState }).state;
      const monitor = (
        runtime as unknown as { livenessMonitor?: NodeLivenessMonitor }
      ).livenessMonitor;
      expect(monitor).toBeDefined();

      // 5. ACTIVE-BUT-SLOW: the subagent keeps producing activity for 120s of
      //    virtual time (a heartbeat every 20s, ticked 19s later — just under
      //    the 60s warn). The node must NEVER be stalled or timed out.
      for (let i = 0; i < 6; i++) {
        runtime.recordLivenessHeartbeat("A", "session");
        const last = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
        monitor!.tick(liveState, last + 19_000);
        expect(liveState.nodes.get("A")!.status).toBe(NodeStatus.Running);
        expect(liveState.nodes.get("A")!.liveness!.stallStatus).not.toBe(
          "stalled",
        );
      }

      // 6. GENUINELY IDLE: the subagent goes silent AND the dispatch dies
      //    without a terminal notification (the abnormal state the stall
      //    ladder exists for — a merely-quiet node would be kept healthy by
      //    the dispatch-liveness channel). Past the 60s warn the monitor
      //    classifies `stalling` (stallWarnedAt stamped); past the hard-stall
      //    deadline (min(15 min, 60+30 s) = 90 s) it is marked timeout — the
      //    designed ladder still fires for real idleness.
      const taskId = liveState.nodes.get("A")!.dispatchTaskId!;
      const manager = core
        .getService<DispatchService>("dispatch-service")!
        .getDispatchManager();
      const liveTask = manager.getTask(taskId);
      expect(liveTask?.status).toBe("running");
      liveTask!.status = "error"; // dispatch died — probe now turns false
      const last = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
      monitor!.tick(liveState, last + 60_000);
      expect(liveState.nodes.get("A")!.liveness!.stallStatus).toBe("stalling");
      expect(liveState.nodes.get("A")!.liveness!.stallWarnedAt).toBe(
        last + 60_000,
      );

      monitor!.tick(liveState, last + 90_001);
      await settle();
      expect(liveState.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
      expect(liveState.nodes.get("A")!.liveness!.stallStatus).toBe("stalled");
      expect(liveState.nodes.get("A")!.liveness!.stallReason).toContain(
        "liveness deadline",
      );
      // The timeout propagated through the escalate ledger (downstream joins
      // must not silently stall).
      expect(liveState.signalLedger.get("A")?.signals.escalate).toBeDefined();
    } finally {
      await core.dispose();
    }
  }, 20_000);

  it("the relay no-ops for unknown sessions and for non-activity event types (never throws)", async () => {
    stack = await buildStack();
    const { core, eventHandler } = stack;
    try {
      // Unknown session — resolves to no owner, must not throw.
      await expect(
        eventHandler({
          event: { type: "part.updated", properties: { sessionID: "ses-ghost" } },
        }),
      ).resolves.toBeUndefined();
      // No session id at all — extraction no-ops.
      await expect(
        eventHandler({ event: { type: "part.created", properties: {} } }),
      ).resolves.toBeUndefined();
      // Non-activity canonical type (session.error is not a heartbeat source)
      // — relay skips; no throw.
      await expect(
        eventHandler({
          event: {
            type: "session.error",
            properties: { sessionID: "ses-ghost", error: "x" },
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await core.dispose();
    }
  });
});
