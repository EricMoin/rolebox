import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import RoleboxModule from "../index";
import { buildSubagentBlock } from "../prompt-builder";
import {
  DispatchManager,
  ConcurrencyManager,
  SessionPoller,
  buildNotificationText,
  notifyParent,
  createDispatchTool,
  createDispatchOutputTool,
  createDispatchCancelTool,
} from "./index";
import type {
  DispatchTask,
  DispatchInput,
  DispatchResult,
  DispatchTaskStatus,
  DispatchManagerConfig,
  NotificationPayload,
} from "./index";

const RoleboxPlugin = RoleboxModule.server;

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-dispatch-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────

function roleboxPath(): string {
  return path.join(tmpDir, "rolebox");
}

async function writeRole(name: string, content: string): Promise<string> {
  const roleDir = path.join(roleboxPath(), name);
  mkdirSync(roleDir, { recursive: true });
  const yamlFile = path.join(roleDir, "role.yaml");
  await writeFile(yamlFile, content, "utf-8");
  return roleDir;
}

function createPluginInput(directory: string): PluginInput {
  return {
    client: {} as never,
    project: {
      id: "test",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:0"),
    $: {} as never,
  };
}

// ── 1. Module exports ────────────────────────────────────────────

describe("dispatch module exports", () => {
  it("exports DispatchManager class", () => {
    expect(DispatchManager).toBeDefined();
    expect(typeof DispatchManager).toBe("function");
  });

  it("exports ConcurrencyManager class", () => {
    expect(ConcurrencyManager).toBeDefined();
    expect(typeof ConcurrencyManager).toBe("function");
  });

  it("exports SessionPoller class", () => {
    expect(SessionPoller).toBeDefined();
    expect(typeof SessionPoller).toBe("function");
  });

  it("exports buildNotificationText function", () => {
    expect(buildNotificationText).toBeDefined();
    expect(typeof buildNotificationText).toBe("function");
  });

  it("exports notifyParent function", () => {
    expect(notifyParent).toBeDefined();
    expect(typeof notifyParent).toBe("function");
  });

  it("exports createDispatchTool function", () => {
    expect(createDispatchTool).toBeDefined();
    expect(typeof createDispatchTool).toBe("function");
  });

  it("exports createDispatchOutputTool function", () => {
    expect(createDispatchOutputTool).toBeDefined();
    expect(typeof createDispatchOutputTool).toBe("function");
  });

  it("exports createDispatchCancelTool function", () => {
    expect(createDispatchCancelTool).toBeDefined();
    expect(typeof createDispatchCancelTool).toBe("function");
  });

  it("type exports are importable (compile-time check)", () => {
    // Type-only check — if these types didn't exist, tsc would fail.
    // The variables are unused at runtime but verify type resolution.
    const _task: DispatchTask = {} as DispatchTask;
    const _input: DispatchInput = {} as DispatchInput;
    const _result: DispatchResult = {} as DispatchResult;
    const _status: DispatchTaskStatus = "pending";
    const _config: DispatchManagerConfig = {
      pollIntervalMs: 3000,
      staleTimeoutMs: 2700000,
      minRuntimeMs: 5000,
      maxConcurrent: 5,
      taskTtlMs: 600000,
    };
    const _payload: NotificationPayload = {
      taskId: "test",
      duration: "1s",
      status: "completed",
      remainingTasks: 0,
    };
    // If we got here without a type error, the exports resolve.
    expect(_task).toBeDefined();
    expect(_input).toBeDefined();
    expect(_result).toBeDefined();
    expect(_status).toBe("pending");
    expect(_config.maxConcurrent).toBe(5);
    expect(_payload.duration).toBe("1s");
  });
});

// ── 2. Prompt builder generates dispatch() syntax ─────────────────

describe("buildSubagentBlock dispatch syntax", () => {
  const sampleSubagents = [
    { id: "orchestrator--worker", name: "Worker", description: "Does the work" },
    { id: "orchestrator--researcher", name: "Researcher", description: "Researches" },
  ];

  it("generates dispatch() syntax for subagent delegation", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).toContain("dispatch(");
    expect(result).toContain('dispatch(subagent="agent-id"');
  });

  it("includes dispatch_output syntax", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).toContain("dispatch_output");
    expect(result).toContain('task_id="bg_xxx"');
  });

  it("includes dispatch_cancel syntax", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).toContain("dispatch_cancel");
    expect(result).toContain('task_id="bg_xxx"');
  });

  it("does NOT contain task(subagent_type= syntax", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).not.toContain("task(subagent_type=");
  });

  it("contains the delegation instructions text", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).toContain("You can delegate tasks to these sub-agents via the dispatch() tool.");
  });

  it("includes both subagents in the block", () => {
    const result = buildSubagentBlock(sampleSubagents);
    expect(result).toContain("<id>orchestrator--worker</id>");
    expect(result).toContain("<id>orchestrator--researcher</id>");
    expect(result).toContain("<name>Worker</name>");
    expect(result).toContain("<name>Researcher</name>");
  });
});

// ── 3. Full plugin lifecycle: dispatch tools ──────────────────────

describe("dispatch tools via plugin lifecycle", () => {
  it("registers dispatch tools when plugin runs with a role that has subagents", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Coordinates subagents",
        "prompt: You are the orchestrator.",
        "subagents:",
        "  - name: Worker",
        "    description: Does the work",
        "    prompt: Work hard.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    expect(hooks.tool).toBeDefined();

    const tools = hooks.tool!;
    expect(tools.dispatch).toBeDefined();
    expect(tools.dispatch_output).toBeDefined();
    expect(tools.dispatch_cancel).toBeDefined();
  });

  it("dispatch tool has expected shape (description, args, execute)", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Coordinates subagents",
        "prompt: Delegate work.",
        "subagents:",
        "  - name: Worker",
        "    description: Does things",
        "    prompt: Do things.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const tool = hooks.tool!.dispatch;

    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("Dispatch");
    expect(typeof tool.args).toBe("object");
    expect("subagent" in tool.args).toBe(true);
    expect("prompt" in tool.args).toBe(true);
    expect("run_in_background" in tool.args).toBe(true);
    expect(typeof tool.execute).toBe("function");
  });

  it("dispatch_output tool has expected shape", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Coordinates subagents",
        "prompt: Delegate work.",
        "subagents:",
        "  - name: Worker",
        "    description: Does things",
        "    prompt: Do things.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const tool = hooks.tool!.dispatch_output;

    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("Retrieve");
    expect(typeof tool.args).toBe("object");
    expect("task_id" in tool.args).toBe(true);
    expect("block" in tool.args).toBe(true);
    expect("timeout" in tool.args).toBe(true);
    expect(typeof tool.execute).toBe("function");
  });

  it("dispatch_cancel tool has expected shape", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Coordinates subagents",
        "prompt: Delegate work.",
        "subagents:",
        "  - name: Worker",
        "    description: Does things",
        "    prompt: Do things.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const tool = hooks.tool!.dispatch_cancel;

    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("Cancel");
    expect(typeof tool.args).toBe("object");
    expect("task_id" in tool.args).toBe(true);
    expect(typeof tool.execute).toBe("function");
  });

  it("dispatch tool validates subagent names against resolved subagents", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Coordinates subagents",
        "prompt: Delegate work.",
        "subagents:",
        "  - name: Worker",
        "    description: Does things",
        "    prompt: Do things.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const tool = hooks.tool!.dispatch;

    const result = await tool.execute(
      {
        subagent: "nonexistent-agent",
        prompt: "Do something",
        run_in_background: false,
      },
      {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "orchestrator",
        directory: tmpDir,
        worktree: tmpDir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid subagent");
    expect(result).toContain("nonexistent-agent");
    expect(result).toContain("orchestrator--worker");
  });

  it("plugin still works when role has no subagents (no dispatch tools)", async () => {
    await writeRole(
      "solo",
      [
        "name: Solo",
        "description: Works alone",
        "prompt: I work alone.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    expect(hooks.tool).toBeDefined();
    expect(hooks.tool!.dispatch).toBeDefined();
  });
});
