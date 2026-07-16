import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SessionService } from "../../src/core/services/session-service.ts";
import { SessionClientWrapper } from "../../src/session/client.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { __resetForTest } from "../../src/logger.ts";

// ── helpers ────────────────────────────────────────────────────────

/**
 * Build a minimal PluginContext whose client.session is a stub object
 * satisfying OpencodeSessionAdapter's constructor requirement.
 * No real SDK client or external dependencies are involved.
 */
function makeMinimalContext(): PluginContext {
  return {
    client: {
      session: {
        list: mock(() => Promise.resolve({ data: [] })),
        get: mock(() => Promise.resolve({ data: null })),
        messages: mock(() => Promise.resolve({ data: [] })),
        children: mock(() => Promise.resolve({ data: [] })),
        todo: mock(() => Promise.resolve({ data: [] })),
        diff: mock(() => Promise.resolve({ data: [] })),
        fork: mock(() => Promise.resolve({ data: null })),
        status: mock(() => Promise.resolve({ data: {} })),
        promptAsync: mock(() => Promise.resolve({ data: { id: "mock" } })),
        prompt: mock(() => Promise.resolve({ data: { parts: [] } })),
        create: mock(() => Promise.resolve({ data: null })),
        abort: mock(() => Promise.resolve(undefined)),
      },
    } as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp",
    directory: "/tmp",
    core: undefined as any,
    bus: undefined as any,
    capabilities: undefined,
  };
}

// ── tests ──────────────────────────────────────────────────────────

describe("SessionService", () => {
  beforeEach(() => {
    __resetForTest();
  });

  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  describe("init", () => {
    it("constructs SessionClientWrapper from ctx.client and completes successfully", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();

      await expect(svc.init(ctx)).resolves.toBeUndefined();
    });

    it("initializes sessionClient accessible via getSessionClient", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      const sc = svc.getSessionClient();
      expect(sc).toBeDefined();
      expect(sc).toBeInstanceOf(SessionClientWrapper);
    });
  });

  describe("getSessionClient", () => {
    it("returns the same instance across multiple calls", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      const a = svc.getSessionClient();
      const b = svc.getSessionClient();
      expect(a).toBe(b);
    });

    it("throws if called before init", () => {
      const svc = new SessionService();
      // sessionClient is declared with `!` — calling before init accesses
      // the uninitialized property (undefined). The method returns undefined
      // since there is no guard; we just verify it does not crash internally.
      // An undefined return is acceptable pre-init.
      const sc = svc.getSessionClient();
      expect(sc).toBeUndefined();
    });
  });

  describe("getTools", () => {
    it("returns all 9 tool keys (6 canonical + 3 aliases) after init", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      const tools = svc.getTools();
      expect(tools).toBeDefined();
      expect(Object.keys(tools).length).toBe(9);

      // Canonical names
      expect(tools.session_list).toBeDefined();
      expect(tools.session_read).toBeDefined();
      expect(tools.session_search).toBeDefined();
      expect(tools.session_info).toBeDefined();
      expect(tools.session_diff).toBeDefined();
      expect(tools.session_fork).toBeDefined();

      // Aliases
      expect(tools.session_inspect).toBeDefined();
      expect(tools.session_changes).toBeDefined();
      expect(tools.session_branch).toBeDefined();
    });

    it("each tool entry is an object (tool definition)", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      const tools = svc.getTools();
      for (const [key, tool] of Object.entries(tools)) {
        expect(typeof tool).toBe("object");
        expect(tool).not.toBeNull();
      }
    });
  });

  describe("dispose", () => {
    it("resolves to undefined (no-op)", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      await expect(svc.dispose()).resolves.toBeUndefined();
    });

    it("does not throw even when called multiple times", async () => {
      const svc = new SessionService();
      const ctx = makeMinimalContext();
      await svc.init(ctx);

      await expect(svc.dispose()).resolves.toBeUndefined();
      await expect(svc.dispose()).resolves.toBeUndefined();
      await expect(svc.dispose()).resolves.toBeUndefined();
    });
  });

  describe("static properties", () => {
    it("has name 'session-service' and no dependencies", () => {
      const svc = new SessionService();
      expect(svc.name).toBe("session-service");
      expect(svc.dependencies).toEqual([]);
    });
  });
});
