/**
 * Bounded retry around session creation for TRANSIENT failures
 * (src/dispatch/core/task-launcher.ts — createSessionWithRetry).
 *
 * Failure classification (contract, mirrors OpencodeSessionAdapter.create):
 *   - THROWN error  → transient transport/network failure → RETRIED with backoff.
 *                     After `createRetryAttempts` total attempts the UNDERLYING
 *                     error is surfaced (never masked).
 *   - null RETURN   → server-side rejection (r.error) → a REAL error → NEVER
 *                     retried. Exactly one create call.
 *
 * These tests drive the REAL DispatchManager → launch → startBackgroundTask path
 * with stub ISessionClient.create implementations.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import { createMockClient, parentContext } from "./helpers";
import { SessionCreateRejectedError } from "../../src/platform/types";
import type { SessionInfo } from "../../src/session/types";

// Zero backoff keeps the retry loop fast in tests.
const retryConfig = {
  createRetryAttempts: 3,
  createRetryBackoffMs: 0,
};

function makeSession(id: string): SessionInfo {
  return {
    id,
    projectID: "/tmp",
    directory: "/tmp",
    summary: { additions: 0, deletions: 0, files: 0 },
    title: `Session ${id}`,
    version: "1.0",
    time: { created: Date.now(), updated: Date.now() },
  };
}

const managed: DispatchManager[] = [];
function track(m: DispatchManager): DispatchManager {
  managed.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(managed.splice(0).map((m) => m.dispose()));
});

describe("session.create bounded retry — transient (thrown) vs rejection (null)", () => {
  it("scenario 1 — throws N times then succeeds → task 'running' after exactly N+1 create calls", async () => {
    let calls = 0;
    const client = createMockClient({
      sessionCreate: () => {
        calls++;
        if (calls <= 2) throw new Error("transport: connection reset"); // N=2 throws
        return Promise.resolve(makeSession("s3"));
      },
    });
    const manager = track(new DispatchManager(client, retryConfig));

    const task = await manager.launch(
      { subagent: "retry-agent", prompt: "x", run_in_background: true },
      parentContext(),
    );

    expect(calls).toBe(3); // 2 throws + 1 success
    expect(task.status).toBe("running");
    expect(task.sessionId).toBe("s3");
  });

  it("scenario 2 — throws N+1 times (exceeds budget) → task 'error' after exactly N+1 attempts with REAL error surfaced", async () => {
    let calls = 0;
    const client = createMockClient({
      sessionCreate: () => {
        calls++;
        throw new Error("transport: upstream 503");
      },
    });
    const manager = track(new DispatchManager(client, retryConfig));

    const task = await manager.launch(
      { subagent: "retry-agent", prompt: "x", run_in_background: true },
      parentContext(),
    );

    expect(calls).toBe(3); // N+1 where N+1 == createRetryAttempts
    expect(task.status).toBe("error");
    // The underlying (real) error must surface, not a masked/retry-generic message.
    expect(task.error).toContain("transport: upstream 503");
    expect(task.error).not.toContain("[object Object]");
  });

  it("scenario 3 — returns null via server rejection (r.error) → NOT retried (exactly 1 create call), task 'error'", async () => {
    let calls = 0;
    const client = createMockClient({
      sessionCreate: () => {
        calls++;
        return Promise.resolve(null); // server-side rejection
      },
    });
    const manager = track(new DispatchManager(client, retryConfig));

    const task = await manager.launch(
      { subagent: "retry-agent", prompt: "x", run_in_background: true },
      parentContext(),
    );

    expect(calls).toBe(1); // null rejection is NOT retried
    expect(task.status).toBe("error");
    expect(task.error).toContain("empty response");
  });

  it("scenario 4 — server REJECTION with a real reason (tagged SessionCreateRejectedError) → NOT retried, REAL reason surfaced (not 'empty response')", async () => {
    // The OpencodeSessionAdapter surfaces r.error as a tagged
    // SessionCreateRejectedError (subtask 4). This test drives the real
    // launcher path with that tagged error thrown from create.
    let calls = 0;
    const client = createMockClient({
      sessionCreate: () => {
        calls++;
        // Mirrors what OpencodeSessionAdapter.create now throws when r.error
        // is a BadRequestError (e.g. unknown parent session → HTTP 400).
        return Promise.reject(
          new SessionCreateRejectedError("parent session not found", "BadRequest"),
        );
      },
    });
    const manager = track(new DispatchManager(client, retryConfig));

    const task = await manager.launch(
      { subagent: "retry-agent", prompt: "x", run_in_background: true },
      parentContext(),
    );

    expect(calls).toBe(1); // tagged rejection is NOT retried — same as pre-change null
    expect(task.status).toBe("error");
    // The REAL server reason surfaces, not the generic "empty response" mask.
    expect(task.error).toContain("parent session not found");
    expect(task.error).not.toContain("empty response");
  });
});
