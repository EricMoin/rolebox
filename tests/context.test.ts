import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FunctionRuntimeManager } from "../src/function/runtime-state";
import { ArtifactStore } from "../src/function/artifact-store";
import { FunctionContext } from "../src/function/context";

describe("FunctionContext", () => {
  function setup(rtDir: string, wsDir: string, lastMsg: string | null = null) {
    const rt = new FunctionRuntimeManager();
    rt.setStoreDirectory(rtDir);
    const artifacts = new ArtifactStore(wsDir);
    const ctx = new FunctionContext("sid", "testFn", rt, artifacts, lastMsg);
    return { rt, artifacts, ctx };
  }

  it("ctx.state.set persists in rt", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { rt, ctx } = setup(rtDir, wsDir);
      ctx.state.set("a", 1);
      const state = rt.get("sid", "testFn");
      expect(state).toBeDefined();
      expect(state!.kv.a).toBe(1);
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.artifact.write → read roundtrip", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir);
      ctx.artifact.write("plan", "X");
      expect(ctx.artifact.read("plan")).toBe("X");
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.artifact.exists is true after write", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir);
      ctx.artifact.write("plan", "hello");
      expect(ctx.artifact.exists("plan")).toBe(true);
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.inject collects strings", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir);
      ctx.inject("hi");
      expect(ctx.injects).toContain("hi");
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.requestContinuation collects reasons", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir);
      ctx.requestContinuation("reason");
      expect(ctx.continuationReasons).toContain("reason");
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.query.lastMessage returns constructor value", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir, "Hello from assistant");
      expect(ctx.query.lastMessage()).toBe("Hello from assistant");
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("ctx.query.artifacts returns list of written artifacts", () => {
    const rtDir = mkdtempSync(join(tmpdir(), "ctx-test-rt-"));
    const wsDir = mkdtempSync(join(tmpdir(), "ctx-test-ws-"));
    try {
      const { ctx } = setup(rtDir, wsDir);
      ctx.artifact.write("plan", "P");
      ctx.artifact.write("notes", "N");
      const names = ctx.query.artifacts();
      expect(names).toContain("plan");
      expect(names).toContain("notes");
    } finally {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
