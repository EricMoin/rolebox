import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { SessionMonitor } from "../../src/dispatch/session-monitor";

const SESSION_ID = "session-abc";

function createMockClient(getImpl: () => unknown): OpencodeClient {
  return {
    session: {
      get: mock(getImpl),
    },
  } as unknown as OpencodeClient;
}

describe("SessionMonitor", () => {
  // ── verifyExistence ───────────────────────────────────────────────

  describe("verifyExistence", () => {
    let monitor: SessionMonitor;

    beforeEach(() => {
      monitor = new SessionMonitor();
    });

    it("returns exists when session.get returns data", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: { id: SESSION_ID, title: "test" }, error: undefined }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("exists");
    });

    it("returns missing on 404 error (thrown)", async () => {
      const err = Object.assign(new Error("Not found"), { status: 404 });
      const client = createMockClient(() => Promise.reject(err));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("returns missing on 404 error in result.error (not thrown)", async () => {
      const client = createMockClient(() =>
        Promise.resolve({ data: undefined, error: { status: 404, message: "Not found" } }),
      );

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("returns unknown on network/transport error", async () => {
      const err = new Error("ECONNREFUSED");
      const client = createMockClient(() => Promise.reject(err));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("unknown");
    });

    it("returns unknown when session.get returns neither data nor error", async () => {
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
});
