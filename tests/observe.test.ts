import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runToolObserve, runTextCapture } from "../src/function/observe";
import { functionRuntime } from "../src/function/runtime-state";
import { ArtifactStore } from "../src/function/artifact-store";
import type { ResolvedFunction } from "../src/types";

function makeFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "plan",
    description: "",
    content: "",
    filePath: "",
    source: "built-in",
    ...overrides,
  };
}

describe("runToolObserve", () => {
  it("marks evidence when observe matches tool", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "test", set_evidence: "test" }],
    });
    functionRuntime.init("sid-1", "plan", 1);

    runToolObserve({
      sessionID: "sid-1",
      tool: "test",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
    });

    const st = functionRuntime.get("sid-1", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.test).toBe(true);
    expect(st!.toolsObserved).toContain("test");
  });

  it("captures fenced artifact from lastAssistantText", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-"));
    const fn = makeFn({
      observe: [{ on: "tool_after", capture_artifact: "plan" }],
    });
    functionRuntime.init("sid-2", "plan", 1);

    runToolObserve({
      sessionID: "sid-2",
      tool: "bash",
      activeFns: [fn],
      artifacts: new ArtifactStore(dir),
      lastAssistantText: "Here is the plan:\n```plan\nline1\nline2\n```\ndone",
    });

    const store = new ArtifactStore(dir);
    const artifact = store.read("sid-2", "plan");
    expect(artifact).toBe("line1\nline2");

    rmSync(dir, { recursive: true, force: true });
  });

  it("syncs todos into kv.__todos on todowrite from toolArgs", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", sync_todos: true }],
    });
    functionRuntime.init("sid-3", "plan", 1);

    runToolObserve({
      sessionID: "sid-3",
      tool: "todowrite",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolArgs: {
        todos: [
          { content: "Step 1", status: "completed" },
          { content: "Step 2", status: "pending" },
          { content: "Step 3", status: "in_progress" },
        ],
      },
    });

    const st = functionRuntime.get("sid-3", "plan");
    expect(st).toBeDefined();
    expect(st!.kv.__todos).toContain("- [x] Step 1");
    expect(st!.kv.__todos).toContain("- [ ] Step 2");
    expect(st!.kv.__todos).toContain("- [ ] Step 3");
  });

  it("auto-marks requires_evidence when tool matches", () => {
    const fn = makeFn({
      requires_evidence: ["lsp_diagnostics"],
    });
    functionRuntime.init("sid-4", "plan", 1);

    runToolObserve({
      sessionID: "sid-4",
      tool: "lsp_diagnostics",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
    });

    const st = functionRuntime.get("sid-4", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.lsp_diagnostics).toBe(true);
  });

  it("ignores observe with non-matching tool", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "bash" }],
    });
    functionRuntime.init("sid-5", "plan", 1);

    runToolObserve({
      sessionID: "sid-5",
      tool: "write",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
    });

    const st = functionRuntime.get("sid-5", "plan");
    expect(st).toBeDefined();
    // No observe spec matched, so no evidence set
    expect(st!.evidenceObserved).toEqual({});
  });

  it("ignores observe with non-matching on type", () => {
    const fn = makeFn({
      observe: [{ on: "activate" }],
    });
    functionRuntime.init("sid-6", "plan", 1);

    runToolObserve({
      sessionID: "sid-6",
      tool: "test",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
    });

    const st = functionRuntime.get("sid-6", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved).toEqual({});
  });

  it("when_output.contains matches and fires spec", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "test_tool", set_evidence: "ev", when_output: { contains: "success" } }],
    });
    functionRuntime.init("sid-7", "plan", 1);

    runToolObserve({
      sessionID: "sid-7",
      tool: "test_tool",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolOutput: "operation success",
    });

    const st = functionRuntime.get("sid-7", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.ev).toBe(true);
  });

  it("when_output.contains does not match and skips spec", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "test_tool", set_evidence: "ev", when_output: { contains: "success" } }],
    });
    functionRuntime.init("sid-8", "plan", 1);

    runToolObserve({
      sessionID: "sid-8",
      tool: "test_tool",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolOutput: "operation failed",
    });

    const st = functionRuntime.get("sid-8", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.ev).toBeUndefined();
  });

  it("when_output.not_contains suppresses spec on matching output", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "test_tool", set_evidence: "ev", when_output: { not_contains: "still running" } }],
    });
    functionRuntime.init("sid-9", "plan", 1);

    runToolObserve({
      sessionID: "sid-9",
      tool: "test_tool",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolOutput: "Task is still running",
    });

    const st = functionRuntime.get("sid-9", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.ev).toBeUndefined();
  });

  it("when_output.not_contains allows spec on non-matching output", () => {
    const fn = makeFn({
      observe: [{ on: "tool_after", tool: "test_tool", set_evidence: "ev", when_output: { not_contains: "still running" } }],
    });
    functionRuntime.init("sid-10", "plan", 1);

    runToolObserve({
      sessionID: "sid-10",
      tool: "test_tool",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolOutput: "Task Result\nhello",
    });

    const st = functionRuntime.get("sid-10", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.ev).toBe(true);
  });

  it("when_args.match fires spec when tool args match all conditions", () => {
    const fn = makeFn({
      observe: [
        { on: "tool_after", tool: "signal", set_evidence: "signal_answer", when_args: { match: { type: "answer" } } },
      ],
    });
    functionRuntime.init("sid-12", "plan", 1);

    runToolObserve({
      sessionID: "sid-12",
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolArgs: { type: "answer" },
    });

    const st = functionRuntime.get("sid-12", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.signal_answer).toBe(true);
  });

  it("when_args.match skips spec when tool args do not match", () => {
    const fn = makeFn({
      observe: [
        { on: "tool_after", tool: "signal", set_evidence: "signal_answer", when_args: { match: { type: "answer" } } },
      ],
    });
    functionRuntime.init("sid-13", "plan", 1);

    runToolObserve({
      sessionID: "sid-13",
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolArgs: { type: "blocked" },
    });

    const st = functionRuntime.get("sid-13", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.signal_answer).toBeUndefined();
  });

  it("when_args.match skips spec when toolArgs is undefined", () => {
    const fn = makeFn({
      observe: [
        { on: "tool_after", tool: "signal", set_evidence: "signal_answer", when_args: { match: { type: "answer" } } },
      ],
    });
    functionRuntime.init("sid-14", "plan", 1);

    runToolObserve({
      sessionID: "sid-14",
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      // toolArgs intentionally omitted — when_args should skip
    });

    const st = functionRuntime.get("sid-14", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.signal_answer).toBeUndefined();
  });

  it("when_args.not_match fires spec when tool args do not match any excluded key", () => {
    const fn = makeFn({
      observe: [
        { on: "tool_after", tool: "signal", set_evidence: "signal_ok", when_args: { not_match: { type: "blocked" } } },
      ],
    });
    functionRuntime.init("sid-15", "plan", 1);

    runToolObserve({
      sessionID: "sid-15",
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolArgs: { type: "answer" },
    });

    const st = functionRuntime.get("sid-15", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.signal_ok).toBe(true);
  });

  it("when_args.not_match skips spec when tool args match an excluded key", () => {
    const fn = makeFn({
      observe: [
        { on: "tool_after", tool: "signal", set_evidence: "signal_ok", when_args: { not_match: { type: "blocked" } } },
      ],
    });
    functionRuntime.init("sid-16", "plan", 1);

    runToolObserve({
      sessionID: "sid-16",
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolArgs: { type: "blocked" },
    });

    const st = functionRuntime.get("sid-16", "plan");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved.signal_ok).toBeUndefined();
  });

  it("requires_evidence auto-mark suppressed when output-gated observe covers same tool+evidence", () => {
    const fn = makeFn({
      requires_evidence: ["test_tool"],
      observe: [{ on: "tool_after", tool: "test_tool", set_evidence: "test_tool", when_output: { not_contains: "still running" } }],
    });
    functionRuntime.init("sid-11", "plan", 1);

    // Call with output that should NOT match the observe spec
    runToolObserve({
      sessionID: "sid-11",
      tool: "test_tool",
      activeFns: [fn],
      artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "obs-"))),
      lastAssistantText: null,
      toolOutput: "still running",
    });

    const st = functionRuntime.get("sid-11", "plan");
    expect(st).toBeDefined();
    // Auto-mark should be suppressed because output-gated observe covers same tool+evidence
    // AND the when_output condition prevents the spec from firing
    expect(st!.evidenceObserved.test_tool).toBeUndefined();
  });
});

describe("runTextCapture (idle-time artifact capture)", () => {
  it("captures a fenced artifact from completed assistant text", () => {
    const dir = mkdtempSync(join(tmpdir(), "txtcap-"));
    const fn = makeFn({ observe: [{ on: "tool_after", capture_artifact: "plan" }] });

    runTextCapture({
      sessionID: "tc-1",
      activeFns: [fn],
      artifacts: new ArtifactStore(dir),
      assistantText: "Final plan below.\n```plan\nGoal: ship\n- [ ] 1. do it\n```\nWaiting for approval.",
    });

    const artifact = new ArtifactStore(dir).read("tc-1", "plan");
    expect(artifact).toBe("Goal: ship\n- [ ] 1. do it");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not write an artifact when the fence is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "txtcap-"));
    const fn = makeFn({ observe: [{ on: "tool_after", capture_artifact: "plan" }] });

    runTextCapture({
      sessionID: "tc-2",
      activeFns: [fn],
      artifacts: new ArtifactStore(dir),
      assistantText: "Here are some thoughts, but no plan block yet.",
    });

    expect(new ArtifactStore(dir).read("tc-2", "plan")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores sync_todos and evidence specs (capture_artifact only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "txtcap-"));
    const fn = makeFn({
      name: "execute",
      observe: [
        { on: "tool_after", tool: "todowrite", sync_todos: true },
        { on: "tool_after", set_evidence: "test" },
      ],
    });
    functionRuntime.init("tc-3", "execute", 1);

    runTextCapture({
      sessionID: "tc-3",
      activeFns: [fn],
      artifacts: new ArtifactStore(dir),
      assistantText: "- [ ] 1. pending todo",
    });

    const st = functionRuntime.get("tc-3", "execute");
    expect(st!.kv.__todos).toBeUndefined();
    expect(st!.evidenceObserved).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});
