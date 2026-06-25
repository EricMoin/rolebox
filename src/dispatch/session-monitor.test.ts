import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { SessionMonitor } from "./session-monitor";
import { MIN_SESSION_GONE_POLLS } from "./config";

const TASK_ID = "task-1";
const SESSION_ID = "session-abc";
const OTHER_SESSION = "session-xyz";

function makeStatusMap(
  sessions: Record<string, { type: string }>,
): Record<string, { type: string }> {
  return sessions;
}

function createMockClient(getImpl: () => unknown): OpencodeClient {
  return {
    session: {
      get: mock(getImpl),
    },
  } as unknown as OpencodeClient;
}

describe("SessionMonitor", () => {
  // ── checkSession ──────────────────────────────────────────────────

  describe("checkSession", () => {
    let monitor: SessionMonitor;

    beforeEach(() => {
      monitor = new SessionMonitor();
    });

    it("1. returns active when session is present in statusMap", () => {
      const map = makeStatusMap({ [SESSION_ID]: { type: "busy" } });
      const result = monitor.checkSession(TASK_ID, SESSION_ID, map);

      expect(result).toEqual({ type: "active", status: { type: "busy" } });
    });

    it("1b. resets missed poll counter when session becomes present again", () => {
      // Miss once → uncertain
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      // Miss again → still uncertain
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      // Now present → should reset counter
      const map = makeStatusMap({ [SESSION_ID]: { type: "idle" } });
      const result = monitor.checkSession(TASK_ID, SESSION_ID, map);

      expect(result).toEqual({ type: "active", status: { type: "idle" } });
    });

    it("2. returns uncertain on single miss", () => {
      const map = makeStatusMap({ [OTHER_SESSION]: { type: "busy" } });
      const result = monitor.checkSession(TASK_ID, SESSION_ID, map);

      expect(result).toEqual({ type: "uncertain" });
      expect(result.status).toBeUndefined();
    });

    it("3. returns uncertain on second consecutive miss", () => {
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      const result = monitor.checkSession(TASK_ID, SESSION_ID, {});

      expect(result).toEqual({ type: "uncertain" });
    });

    it("4. returns gone after MIN_SESSION_GONE_POLLS consecutive misses", () => {
      for (let i = 0; i < MIN_SESSION_GONE_POLLS - 1; i++) {
        const r = monitor.checkSession(TASK_ID, SESSION_ID, {});
        expect(r.type).toBe("uncertain");
      }
      // The threshold poll
      const result = monitor.checkSession(TASK_ID, SESSION_ID, {});
      expect(result).toEqual({ type: "gone" });
    });

    it("5. presence resets counter — miss → present → miss returns uncertain not gone", () => {
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      // Present resets
      monitor.checkSession(
        TASK_ID,
        SESSION_ID,
        makeStatusMap({ [SESSION_ID]: { type: "busy" } }),
      );
      // Miss again — counter should be at 1, not 3
      const result = monitor.checkSession(TASK_ID, SESSION_ID, {});
      expect(result.type).toBe("uncertain");
    });

    it("tracks multiple tasks independently", () => {
      const a = "task-a";
      const b = "task-b";

      // Task A misses twice
      monitor.checkSession(a, "sa", {});
      monitor.checkSession(a, "sa", {});
      // Task B misses once
      monitor.checkSession(b, "sb", {});

      // Task A → uncertain (2 < 3)
      expect(monitor.checkSession(a, "sa", {}).type).toBe("gone");
      // Task B → uncertain (1 < 3)
      expect(monitor.checkSession(b, "sb", {}).type).toBe("uncertain");
    });

    it("empty statusMap does not crash and returns uncertain", () => {
      const result = monitor.checkSession(TASK_ID, SESSION_ID, {});
      expect(result).toEqual({ type: "uncertain" });
    });
  });

  // ── verifyExistence ───────────────────────────────────────────────

  describe("verifyExistence", () => {
    let monitor: SessionMonitor;

    beforeEach(() => {
      monitor = new SessionMonitor();
    });

    it("6. returns exists when session.get returns data", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: { id: SESSION_ID, title: "test" }, error: undefined }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("exists");
    });

    it("7. returns missing on 404 error (thrown)", async () => {
      const err = Object.assign(new Error("Not found"), { status: 404 });
      const client = createMockClient(() => Promise.reject(err));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("7b. returns missing on 404 error in result.error (not thrown)", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: undefined, error: { status: 404, message: "Not found" } }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("8. returns unknown on network/transport error", async () => {
      const err = new Error("ECONNREFUSED");
      const client = createMockClient(() => Promise.reject(err));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("unknown");
    });

    it("10. returns unknown when session.get returns neither data nor error", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("unknown");
    });

    it("returns unknown when session.get returns null data", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: null, error: undefined }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("unknown");
    });
  });

  // ── clearTask ─────────────────────────────────────────────────────

  describe("clearTask", () => {
    let monitor: SessionMonitor;

    beforeEach(() => {
      monitor = new SessionMonitor();
    });

    it("9. removes tracking state — miss twice, clear, miss again → uncertain", () => {
      // Miss twice
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      // Clear
      monitor.clearTask(TASK_ID);
      // Miss again — counter should restart at 1
      const result = monitor.checkSession(TASK_ID, SESSION_ID, {});
      expect(result.type).toBe("uncertain");
    });

    it("clearTask on non-existent task does not throw", () => {
      expect(() => monitor.clearTask("nonexistent")).not.toThrow();
    });

    it("clearTask then re-appearance resets correctly", () => {
      monitor.checkSession(TASK_ID, SESSION_ID, {});
      monitor.clearTask(TASK_ID);
      // Present immediately after clear
      const result = monitor.checkSession(
        TASK_ID,
        SESSION_ID,
        makeStatusMap({ [SESSION_ID]: { type: "busy" } }),
      );
      expect(result.type).toBe("active");
    });
  });
});
