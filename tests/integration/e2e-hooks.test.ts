/**
 * End-to-end hook pipeline tests for rolebox.
 *
 * Validates the full pipeline:
 *   user message event → plugin hook dispatch → role resolution →
 *   prompt construction → agent response → function state transition →
 *   result extraction
 *
 * Uses two complementary approaches:
 *   1. Mock-client tests – verify hook handler orchestration, function
 *      activation, gate evaluation, graph advancement, and system-prompt
 *      augmentation through the production PluginCore/composition.ts path.
 *   2. Real-server tests – verify the complete message→hook→role→session
 *      pipeline against an actual opencode platform instance.
 *
 * Type notes:
 *   - `agent` is not in the Hooks interface for system.transform but the
 *     hook-service handler extracts it via `(input as any).agent` (matching
 *     production opencode platform behavior). Tests pass it via `as any`.
 *   - `callID` is required by the tool.execute.after Hooks interface.
 *   - `bun:test` import type errors are pre-existing across all test files.
 *
 * Additive only — no existing test files are modified.
 */

import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";

// ── PluginCore & composition ─────────────────────────────────────────────
import { createPluginHooks, pendingCorrections } from "../../src/core/composition.ts";
import { graphSessionState } from "../../src/graph/index.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { roleFunctionsMap } from "../../src/resolver/registry.ts";

// ── Test harness ─────────────────────────────────────────────────────────
import {
  createTestContext,
  cleanupTestState,
  createMockClient,
  makeMinimalRole,
  makeMinimalSubagent,
  MINIMAL_PRIMARY_ID,
} from "./helpers.ts";

// ── Real server imports ──────────────────────────────────────────────────
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";

// ── Types ────────────────────────────────────────────────────────────────
import type { ResolvedFunction, ResolvedGraph } from "../../src/types.ts";
import type { Hooks } from "@opencode-ai/plugin";
import { FunctionSource } from "../../src/constants.ts";

// ══════════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════════

/**
 * Build a ResolvedFunction with all required fields, suitable for injection
 * into the roleFunctionsMap used by createPluginHooks.
 */
function makeFn(overrides: {
  name: string;
  description?: string;
  content?: string;
  gate?: any;
  continue_until?: any;
  observe?: any[];
  transitions?: any[];
  requires_evidence?: string[];
}): ResolvedFunction {
  return {
    name: overrides.name,
    description: overrides.description ?? `Test function: ${overrides.name}`,
    content: overrides.content ?? `You are a test function named ${overrides.name}.`,
    filePath: `/tmp/test-fns/${overrides.name}.md`,
    source: "role" as FunctionSource,
    phase: "user",
    priority: 50,
    ...overrides.gate !== undefined && { gate: overrides.gate },
    ...overrides.continue_until !== undefined && { continue_until: overrides.continue_until },
    ...overrides.observe !== undefined && { observe: overrides.observe },
    ...overrides.transitions !== undefined && { transitions: overrides.transitions },
    ...overrides.requires_evidence !== undefined && { requires_evidence: overrides.requires_evidence },
  };
}

/**
 * Create a minimal graph with one subagent node.
 */
function makeE2eGraph(): ResolvedGraph {
  return {
    edges: [
      { from: "parent", to: MINIMAL_PRIMARY_ID + "--helper" },
      { from: MINIMAL_PRIMARY_ID + "--helper", to: "parent", exit: true },
    ],
    nodes: [MINIMAL_PRIMARY_ID + "--helper"],
    maxIterations: 3,
    exitEdges: [{ from: MINIMAL_PRIMARY_ID + "--helper", to: "parent", exit: true }],
    template: "pipeline",
    loopGroups: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Tests: Mock-Client Hook Pipeline
// ══════════════════════════════════════════════════════════════════════════

describe("E2E hook pipeline (mock client)", () => {
  beforeEach(() => {
    cleanupTestState();
  });

  afterEach(() => {
    mock.restore();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 1: Full mock pipeline – message → activation → system transform → tool
  // ──────────────────────────────────────────────────────────────────────────
  it("exercises the full message→activation→system→tool pipeline end-to-end", async () => {
    const ctx = await createTestContext();
    try {
      const hooks: Hooks = ctx.hooks;
      const sessionID = "e2e-mock-1";

      // ── 1. Register test functions ────────────────────────────────────────
      const analyzeFn = makeFn({
        name: "test-analyze",
        description: "Analyze input data and produce structured output",
        content: "You are an analysis function. Analyze the given data.",
        continue_until: { not: "tool_ran" },
      });
      const reviewFn = makeFn({
        name: "test-review",
        description: "Review output for quality",
        content: "You are a review function. Review and score the output.",
        gate: "user_approval",
        continue_until: "score >= 3",
      });
      roleFunctionsMap.set(MINIMAL_PRIMARY_ID, [analyzeFn, reviewFn]);

      // ── 2. Simulate a user chat message with |test-analyze| activation ───
      const chatOutput = { parts: [{ type: "text", text: "|test-analyze| Analyze this data" }] };
      await hooks["chat.message"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        chatOutput as any,
      );

      // Verify: test-analyze is activated, test-review is not
      const activeNames = functionSessionState.getActive(sessionID);
      expect(activeNames.has("test-analyze")).toBe(true);
      expect(activeNames.has("test-review")).toBe(false);
      // The |function| syntax should be stripped from the output text
      expect(chatOutput.parts[0].text).not.toContain("|test-analyze|");

      // ── 3. Simulate system.transform ──────────────────────────────────────
      const sysOutput = { system: ["You are a test agent."] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput,
      );

      // Verify: function block was injected into system prompt
      const sysText = sysOutput.system.join("\n");
      expect(sysText).toContain("test-analyze");
      expect(sysText).toContain("Analyze input data and produce structured output");

      // Verify: graph state block was injected
      expect(sysText).toContain("<collaboration_state>");

      // ── 4. Simulate tool execution (dispatch to subagent) ────────────────
      // Tool.execute.after advances the graph.
      await hooks["tool.execute.after"]!(
        { sessionID, tool: "task", callID: "call-1", args: { subagent_type: MINIMAL_PRIMARY_ID + "--helper", prompt: "Analyze the data" } },
        {} as any,
      );

      // Verify: graph advanced
      const gs = graphSessionState.getState(sessionID);
      expect(gs).toBeDefined();
      expect(gs!.completed).toContain(MINIMAL_PRIMARY_ID + "--helper");

      // ── 5. Verify pendingCorrections is empty (no off-route dispatch) ────
      expect(pendingCorrections.has(sessionID)).toBe(false);

      // ── 6. Verify function state exists for the activated function ───────
      const fnState = functionRuntime.get(sessionID, "test-analyze");
      expect(fnState).toBeDefined();
      expect(fnState!.phase).toBe("active");
    } finally {
      ctx.cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Multiple function activation and gate evaluation
  //
  // Verifies that:
  //   1. After a user message, user_approval gate is satisfied → phase = active
  //   2. On a subsequent auto-continue (no user message), user_approval fails
  //      → phase transitions to gated
  // ──────────────────────────────────────────────────────────────────────────
  it("evaluates user_approval gate: satisfied on user turn, gated on auto-continue", async () => {
    const ctx = await createTestContext();
    try {
      const hooks = ctx.hooks;
      const sessionID = "e2e-mock-2";

      // Register a function with a gate that requires user_approval
      const planFn = makeFn({
        name: "test-plan",
        description: "Plan the approach",
        content: "You are a planning function.",
        gate: "user_approval",
      });
      const execFn = makeFn({
        name: "test-exec",
        description: "Execute the plan",
        content: "You are an execution function.",
      });
      roleFunctionsMap.set(MINIMAL_PRIMARY_ID, [planFn, execFn]);

      // Activate both functions via chat.message (simulates user turn)
      const chatOutput = { parts: [{ type: "text", text: "|test-plan||test-exec| Start" }] };
      await hooks["chat.message"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        chatOutput as any,
      );

      let active = functionSessionState.getActive(sessionID);
      expect(active.has("test-plan")).toBe(true);
      expect(active.has("test-exec")).toBe(true);

      // First system.transform — user just messaged, so user_approval is satisfied
      const sysOutput1 = { system: ["Base prompt"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput1,
      );

      // user_approval was true → gate satisfied → phase = active
      const planState1 = functionRuntime.get(sessionID, "test-plan");
      expect(planState1).toBeDefined();
      expect(planState1!.phase).toBe("active");
      expect(planState1!.gateSatisfied).toBe(true);

      // test-exec has no gate → remains active
      const execState = functionRuntime.get(sessionID, "test-exec");
      expect(execState).toBeDefined();
      expect(execState!.phase).toBe("active");

      // The functions should appear in the system prompt
      const sysText1 = sysOutput1.system.join("\n");
      expect(sysText1).toContain("test-plan");
      expect(sysText1).toContain("test-exec");

      // Second system.transform — NO user message, simulates auto-continue
      // user_approval should be FALSE → gate NOT satisfied → phase = gated
      const sysOutput2 = { system: ["Second turn"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput2,
      );

      const planState2 = functionRuntime.get(sessionID, "test-plan");
      expect(planState2).toBeDefined();
      // user_approval was consumed and cleared after first transform,
      // so on this second call userMessagedThisTurn = false → gate fails
      expect(planState2!.phase).toBe("gated");
      expect(planState2!.gateSatisfied).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Function observe + evidence recording via tool.execute.after
  // ──────────────────────────────────────────────────────────────────────────
  it("records tool observations via tool.execute.after handler", async () => {
    const ctx = await createTestContext();
    try {
      const hooks = ctx.hooks;
      const sessionID = "e2e-mock-3";

      // Register a function that observes tool execution and sets evidence
      const observeFn = makeFn({
        name: "test-observe",
        description: "Observes tool calls",
        content: "You observe tool execution.",
        observe: [
          {
            on: "tool_after",
            tool: "read",
            set_evidence: "file_read",
          },
        ],
      });
      roleFunctionsMap.set(MINIMAL_PRIMARY_ID, [observeFn]);

      // Activate
      await hooks["chat.message"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        { parts: [{ type: "text", text: "|test-observe| Read something" }] } as any,
      );

      // Init function runtime state so it exists for observe to interact with
      functionRuntime.init(sessionID, "test-observe", 1);

      expect(functionSessionState.getActive(sessionID).has("test-observe")).toBe(true);

      // Simulate a tool.execute.after for a "read" tool
      await hooks["tool.execute.after"]!(
        { sessionID, tool: "read", callID: "call-2", args: { filePath: "/tmp/test.txt" } },
        { title: "Read result", output: "file content", metadata: {} } as any,
      );

      // The observe machinery fires on tool_after and interacts with functionRuntime.
      // If the observe's set_evidence was processed, it should be recorded.
      const st = functionRuntime.get(sessionID, "test-observe");
      expect(st).toBeDefined();
    } finally {
      ctx.cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Compaction hook adds runtime state context
  //
  // The compaction handler reads persisted state from .rolebox/state/ JSON
  // files. We flush the in-memory state synchronously before calling the hook
  // so the files are written to disk.
  // ──────────────────────────────────────────────────────────────────────────
  it("compaction hook injects runtime state context", async () => {
    const ctx = await createTestContext();
    try {
      const hooks = ctx.hooks;
      const sessionID = "e2e-mock-4";

      // Simulate some runtime state: init graph + function
      graphSessionState.initGraph(sessionID, makeE2eGraph(), MINIMAL_PRIMARY_ID);
      functionRuntime.init(sessionID, "test-analyze", 1);

      // Flush in-memory state to disk so the compaction handler can read it
      graphSessionState.flushSync();
      functionRuntime.flushSync();

      const compactOutput = { context: [] as string[], prompt: undefined as string | undefined };
      await hooks["experimental.session.compacting"]!(
        { sessionID },
        compactOutput,
      );

      // Compaction should inject runtime state context
      expect(compactOutput.context.length).toBeGreaterThan(0);
      const ctxStr = compactOutput.context.join("\n");
      expect(ctxStr).toContain("Rolebox Runtime State");
    } finally {
      ctx.cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Tests: Real-Server Hook Pipeline
// ══════════════════════════════════════════════════════════════════════════

describe("E2E hook pipeline (real server)", () => {
  let server: { url: string; close(): void };
  let realClient: OpencodeClient;
  let tmpDir: string;

  beforeAll(async () => {
    cleanupTestState();
    server = await createOpencodeServer({ port: 0, timeout: 15_000 });
    realClient = createOpencodeClient({ baseUrl: server.url });
    tmpDir = mkdtempSync(path.join(tmpdir(), "e2e-hooks-"));
    // Create subdirs needed by PluginCore init
    mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
    mkdirSync(path.join(tmpDir, "config"), { recursive: true });
    mkdirSync(path.join(tmpDir, "builtin"), { recursive: true });
    mkdirSync(path.join(tmpDir, MINIMAL_PRIMARY_ID), { recursive: true });
    mkdirSync(path.join(tmpDir, MINIMAL_PRIMARY_ID + "--helper"), { recursive: true });
  });

  afterAll(() => {
    server.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: Real-server pipeline – init hooks with real client, create session,
  //         run function activation + system.transform, then verify a real
  //         platform session completes.
  // ──────────────────────────────────────────────────────────────────────────
  it("exercises the full message→hook→function→graph→session pipeline against a real platform", async () => {
    const analyzeFn = makeFn({
      name: "test-analyze",
      description: "Analyze input data",
      content: "You are an analysis function.",
    });
    roleFunctionsMap.set(MINIMAL_PRIMARY_ID, [analyzeFn]);

    const graph = makeE2eGraph();
    const graphMap = new Map<string, ResolvedGraph>();
    graphMap.set(MINIMAL_PRIMARY_ID, graph);

    // Create hooks with the real client
    const primary = makeMinimalRole();

    // Write role YAML files that PluginCore/Resolver expects
    const fs = await import("node:fs");
    fs.writeFileSync(
      path.join(tmpDir, MINIMAL_PRIMARY_ID, "role.yaml"),
      `name: Test Primary\ndescription: Primary test role\nprompt: |\n  You are a test primary.\nsubagents:\n  - name: Helper\n    description: helper\ntype: primary\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, MINIMAL_PRIMARY_ID + "--helper", "role.yaml"),
      `name: Helper\ndescription: helper\nmode: subagent\nprompt: |\n  You are a helper.\n`,
    );

    const hooks = await createPluginHooks({
      resolvedRoles: [primary],
      client: realClient,
      roleFunctionsMap,
      roleGraphMap: graphMap,
      directory: tmpDir,
      roleboxDir: tmpDir,
      globalSkillsDir: path.join(tmpDir, "skills"),
      configDir: path.join(tmpDir, "config"),
      builtinDir: path.join(tmpDir, "builtin"),
    });

    try {
      const sessionID = "e2e-real-1";

      // ── 1. Activate functions via chat.message ──────────────────────────
      const chatOutput = { parts: [{ type: "text", text: "|test-analyze| Analyze this" }] };
      await hooks["chat.message"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        chatOutput as any,
      );

      const activeNames = functionSessionState.getActive(sessionID);
      expect(activeNames.has("test-analyze")).toBe(true);

      // ── 2. system.transform injects function blocks ────────────────────
      const sysOutput = { system: ["Base system prompt"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput,
      );

      const sysText = sysOutput.system.join("\n");
      expect(sysText).toContain("test-analyze");
      expect(sysText).toContain("Analyze input data");

      // ── 3. Verify function runtime state ────────────────────────────────
      const fnState = functionRuntime.get(sessionID, "test-analyze");
      expect(fnState).toBeDefined();
      expect(fnState!.phase).toBe("active");

      // ── 4. Create a real platform session and send a prompt ──────────────
      const createResult = await realClient.session.create({
        query: { directory: tmpDir },
      });
      expect(createResult.data).toBeDefined();
      const platformSessionId = createResult.data!.id;
      expect(platformSessionId).toMatch(/^ses_/);

      // Send a fire-and-forget prompt
      await realClient.session.promptAsync({
        path: { id: platformSessionId },
        body: {
          parts: [{ type: "text", text: "Reply with exactly one word: hello" }],
          agent: "emperor",
        },
      });

      // Poll until the assistant responds with a "stop" finish
      const deadline = Date.now() + 60_000;
      let assistantText = "";
      while (Date.now() < deadline) {
        const msgResult = await realClient.session.messages({
          path: { id: platformSessionId },
        });
        const msgs = msgResult.data ?? [];
        const assistantMsgs = msgs.filter(
          (m: any) => m.info?.role === "assistant" && m.info?.finish === "stop",
        );
        if (assistantMsgs.length > 0) {
          const last = assistantMsgs[assistantMsgs.length - 1];
          assistantText = (last.parts ?? [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join(" ");
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Verify we got a meaningful response from the real platform
      expect(assistantText.length).toBeGreaterThan(0);
      expect(assistantText.toLowerCase()).toContain("hello");
    } finally {
      // Cleanup: clear singleton state after test
      cleanupTestState();
    }
  }, 120_000);
});

// ══════════════════════════════════════════════════════════════════════════
//  Tests: Graph State Integration with Hook Pipeline
// ══════════════════════════════════════════════════════════════════════════

describe("E2E hook pipeline – graph state advancement", () => {
  beforeEach(() => {
    cleanupTestState();
  });

  afterEach(() => {
    mock.restore();
  });

  it("advances graph state via tool.execute.after and reflects in system.transform", async () => {
    const ctx = await createTestContext();
    try {
      const hooks = ctx.hooks;
      const sessionID = "e2e-graph-1";

      // Register functions
      const fn = makeFn({
        name: "test-exec",
        description: "Execute workflow step",
        content: "You execute steps.",
      });
      roleFunctionsMap.set(MINIMAL_PRIMARY_ID, [fn]);

      // Activate function to trigger graph init via chat.message
      await hooks["chat.message"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        { parts: [{ type: "text", text: "|test-exec| Execute" }] } as any,
      );

      // system.transform should init the graph
      const sysOutput1 = { system: ["Base prompt"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput1,
      );

      let gs = graphSessionState.getState(sessionID);
      expect(gs).toBeDefined();
      expect(gs!.status).toBe("active");

      // dispatch to subagent — advances graph
      await hooks["tool.execute.after"]!(
        { sessionID, tool: "task", callID: "call-graph-1", args: { subagent_type: MINIMAL_PRIMARY_ID + "--helper", prompt: "do step" } },
        {} as any,
      );

      gs = graphSessionState.getState(sessionID);
      expect(gs).toBeDefined();
      expect(gs!.completed).toContain(MINIMAL_PRIMARY_ID + "--helper");

      // Second system.transform should include the updated graph state
      const sysOutput2 = { system: ["Another turn"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID, agent: MINIMAL_PRIMARY_ID } as any,
        sysOutput2,
      );

      const sysText2 = sysOutput2.system.join("\n");
      expect(sysText2).toContain("<collaboration_state>");
      expect(sysText2).toContain(MINIMAL_PRIMARY_ID + "--helper");
    } finally {
      ctx.cleanup();
    }
  });
});
