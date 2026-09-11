import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { LspService } from "../../src/core/services/lsp-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { __resetForTest } from "../../src/logger.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp",
    directory: "/tmp",
    core: undefined as any,
    bus: undefined as any,
    capabilities: undefined,
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────

describe("LspService", () => {
  beforeEach(() => {
    __resetForTest();
  });

  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  describe("init", () => {
    it("creates LspClientManager and LspDocumentManager accessible via getters", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      const clientMgr = svc.getLspClientManager();
      expect(clientMgr).toBeDefined();
      expect(clientMgr.constructor.name).toBe("LspClientManager");

      const docMgr = svc.getLspDocumentManager();
      expect(docMgr).toBeDefined();
      expect(docMgr.constructor.name).toBe("LspDocumentManager");
    });
  });

  describe("health()", () => {
    it("returns healthy with detail when no LSP servers configured", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      const h = svc.health();
      expect(h.status).toBe("healthy");
      expect(h.detail).toBe("no LSP servers configured");
    });

    it("returns unhealthy when all servers failed", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      // Inject failed servers into the client manager
      const mgr = svc.getLspClientManager();
      mgr.servers.set("typescript", {
        languageId: "typescript",
        status: "failed",
        process: null,
        capabilities: {},
        startedAt: new Date(),
        pendingRequests: new Map(),
        diagnosticCache: new Map(),
        restartCount: 0,
      });
      mgr.servers.set("python", {
        languageId: "python",
        status: "failed",
        process: null,
        capabilities: {},
        startedAt: new Date(),
        pendingRequests: new Map(),
        diagnosticCache: new Map(),
        restartCount: 0,
      });

      const h = svc.health();
      expect(h.status).toBe("unhealthy");
      expect(h.detail).toBe("all 2 LSP servers failed");
    });

    it("returns degraded when some servers are dead", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getLspClientManager();
      mgr.servers.set("typescript", {
        languageId: "typescript",
        status: "running",
        process: null,
        capabilities: {},
        startedAt: new Date(),
        pendingRequests: new Map(),
        diagnosticCache: new Map(),
        restartCount: 0,
      });
      mgr.servers.set("python", {
        languageId: "python",
        status: "dead",
        process: null,
        capabilities: {},
        startedAt: new Date(),
        pendingRequests: new Map(),
        diagnosticCache: new Map(),
        restartCount: 0,
      });

      const h = svc.health();
      expect(h.status).toBe("degraded");
      expect(h.detail).toBe("1/2 LSP servers dead");
    });

    it("returns healthy when all servers are running", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getLspClientManager();
      mgr.servers.set("typescript", {
        languageId: "typescript",
        status: "running",
        process: null,
        capabilities: {},
        startedAt: new Date(),
        pendingRequests: new Map(),
        diagnosticCache: new Map(),
        restartCount: 0,
      });

      const h = svc.health();
      expect(h.status).toBe("healthy");
    });
  });

  describe("getTools()", () => {
    it("returns a non-empty tools map after init", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      const tools = svc.getTools();
      expect(tools).toBeDefined();
      expect(typeof tools).toBe("object");
      expect(Object.keys(tools).length).toBeGreaterThan(0);

      // Spot-check a few known LSP tool names
      expect(tools.lsp_diagnostics).toBeDefined();
      expect(tools.lsp_hover).toBeDefined();
      expect(tools.lsp_goto_definition).toBeDefined();
      expect(tools.lsp_completion).toBeDefined();
    });
  });

  describe("dispose", () => {
    it("disposes gracefully without throwing", async () => {
      const svc = new LspService();
      const ctx = makeContext();
      await svc.init(ctx);

      // Should not throw
      await expect(svc.dispose()).resolves.toBeUndefined();
    });
  });
});
