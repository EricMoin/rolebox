import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FunctionRuntimeManager } from "../src/function/runtime-state";
import { ArtifactStore } from "../src/function/artifact-store";
import { FunctionContext } from "../src/function/context";
import { loadHandlers, safeCall } from "../src/function/handlers-loader";

function makeContext(): { ctx: FunctionContext; cleanup: () => void } {
  const rtDir = mkdtempSync(join(tmpdir(), "handler-test-rt-"));
  const wsDir = mkdtempSync(join(tmpdir(), "handler-test-ws-"));
  const rt = new FunctionRuntimeManager();
  rt.setStoreDirectory(rtDir);
  const artifacts = new ArtifactStore(wsDir);
  const ctx = new FunctionContext("sid", "testFn", rt, artifacts, null);
  return {
    ctx,
    cleanup: () => {
      rmSync(rtDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    },
  };
}

function writeHandler(dir: string, content: string): string {
  const abs = join(dir, "handlers.ts");
  writeFileSync(abs, content, "utf-8");
  return abs;
}

describe("handlers-loader", () => {
  describe("loadHandlers", () => {
    it("returns null when handlersField is undefined", async () => {
      const result = await loadHandlers("/some/fn.yaml", undefined);
      expect(result).toBeNull();
    });

    it("returns null when handler file does not exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-missing-"));
      try {
        const result = await loadHandlers(
          join(dir, "fn.yaml"),
          "nonexistent-handlers.ts",
        );
        expect(result).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("caches and returns the same module on repeated calls", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-cache-"));
      try {
        const handlerPath = writeHandler(
          dir,
          `
export function onToolAfter(ctx: any, _ev: any) {
  ctx.inject("from-handler");
}
`,
        );
        const fnPath = join(dir, "fn.yaml");
        const a = await loadHandlers(fnPath, handlerPath);
        const b = await loadHandlers(fnPath, handlerPath);
        expect(a).toBeDefined();
        expect(b).toBe(a);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("resolves absolute handlersField as-is", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-abs-"));
      try {
        const handlerPath = writeHandler(
          dir,
          `
export function onToolAfter(ctx: any, _ev: any) {
  ctx.inject("from-abs-handler");
}
`,
        );
        const result = await loadHandlers("/some/fn.yaml", handlerPath);
        expect(result).toBeDefined();
        expect(result!.onToolAfter).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("safeCall + onToolAfter", () => {
    it("executes handler and modifies context via inject", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-exec-"));
      try {
        const handlerPath = writeHandler(
          dir,
          `
export async function onToolAfter(ctx: any, _ev: any) {
  ctx.inject("from-handler");
}
`,
        );
        const { ctx, cleanup } = makeContext();
        try {
          const mod = await loadHandlers(join(dir, "fn.yaml"), handlerPath);
          expect(mod).toBeDefined();
          expect(mod!.onToolAfter).toBeDefined();

          await safeCall(() =>
            mod!.onToolAfter!(ctx, { tool: "test", args: {} }),
          );

          expect(ctx.injects).toContain("from-handler");
        } finally {
          cleanup();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns undefined when handler throws (no exception propagation)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-throw-"));
      try {
        const handlerPath = writeHandler(
          dir,
          `
export async function onToolAfter(_ctx: any, _ev: any) {
  throw new Error("boom");
}
`,
        );
        const { ctx, cleanup } = makeContext();
        try {
          const mod = await loadHandlers(join(dir, "fn.yaml"), handlerPath);
          expect(mod).toBeDefined();

          const result = await safeCall(() =>
            mod!.onToolAfter!(ctx, { tool: "test", args: {} }),
          );

          expect(result).toBeUndefined();
        } finally {
          cleanup();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns undefined for a missing handler slot", async () => {
      const dir = mkdtempSync(join(tmpdir(), "handler-empty-"));
      try {
        const handlerPath = writeHandler(dir, `export const x = 1;`);
        const mod = await loadHandlers(join(dir, "fn.yaml"), handlerPath);
        expect(mod).toBeDefined();
        // onToolAfter is not exported — safeCall on undefined returns undefined
        const result = await safeCall(() => mod!.onToolAfter?.(undefined as any, undefined as any));
        expect(result).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
