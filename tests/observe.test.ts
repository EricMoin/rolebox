import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runToolObserve } from "../src/function/observe";
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
});
