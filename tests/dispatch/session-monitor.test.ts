import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import { SessionMonitor } from "../../src/dispatch/completion/session-monitor";

const SESSION_ID = "session-abc";

function createMockClient(getImpl: () => unknown): ISessionClient {
  return {
    get: mock(getImpl),
  } as unknown as ISessionClient;
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

    it("returns missing when session.get returns null (not found via adapter)", async () => {
      // ISessionClient.get() returns null when the session is not found
      const client = createMockClient(() => Promise.resolve(null));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("returns unknown on network/transport error", async () => {
      const err = new Error("ECONNREFUSED");
      const client = createMockClient(() => Promise.reject(err));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("unknown");
    });

    it("returns missing when session.get returns null (no data, handled by adapter)", async () => {
      // ISessionClient.get() returns null when no session is found
      const client = createMockClient(() => Promise.resolve(null));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });

    it("returns missing when session.get returns null data (handled by adapter)", async () => {
      // ISessionClient.get() returns null when no session data is available
      const client = createMockClient(() => Promise.resolve(null));

      const result = await monitor.verifyExistence(client, SESSION_ID);
      expect(result).toBe("missing");
    });
  });
});
