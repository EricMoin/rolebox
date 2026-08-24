/**
 * RC-C diagnostic measurement — sidecar full re-read hypothesis.
 *
 * Verifies whether `messages()` / `status()` on a dead/recovered session
 * re-read and re-replay the ENTIRE sidecar JSONL on EVERY call:
 *
 *   - PiSessionAdapter._messagesFromSidecar (session.ts:678-969) calls
 *     readSession(id) (sidecar-persister.ts:108) — full-file read + parse,
 *     no caching, on every invocation.
 *   - PiProcessSessionAdapter.messages (process-session.ts:682-689) re-reads
 *     the sidecar whenever record.messages.length === 0 && record.sidecarPath.
 *   - Completion evaluator wraps client.messages/status in a 10s timeout
 *     (completion-evaluator.ts:381-383; MATERIALIZE_TIMEOUT_MS=10_000) and
 *     escalates after MAX_CONSECUTIVE_FETCH_FAILURES (=3) to
 *     "Cannot verify task liveness — SDK fetch failed N consecutive times"
 *     (completion-evaluator.ts:516-529).
 *
 * readSession is mocked with an invocation counter so we can measure the
 * number of full sidecar reads per API call.
 *
 * @module
 */

import { describe, it, expect, afterAll, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Instrumented readSession spy ─────────────────────────────────────────────

let readSessionCalls = 0;
const SIDECAR_DIR = join(process.cwd(), ".rolebox", "pi-sessions");

/** Real readSession implementation (mirror of sidecar-persister.ts:108-129). */
async function realReadSession(sessionId: string): Promise<unknown[] | null> {
  const filePath = join(SIDECAR_DIR, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // corrupt line — skip
    }
  }
  return events;
}

mock.module("../../src/platform/adapters/pi/sidecar-persister", () => ({
  readSession: async (id: string): Promise<unknown[] | null> => {
    readSessionCalls++;
    return realReadSession(id);
  },
  appendEvent: async (): Promise<void> => {},
  scanOrphanedSessions: (): string[] => [],
  pruneSidecars: async (): Promise<void> => {},
  MAX_RETAINED_SIDECARS: 50,
  writeSystemPrompt: async (): Promise<void> => {},
}));

// Import AFTER mock.module registration.
const { PiSessionAdapter } = await import("../../src/platform/adapters/pi/session.ts");
const { PiProcessSessionAdapter } = await import("../../src/platform/adapters/pi/process-session.ts");

// ── Fixture generation ───────────────────────────────────────────────────────

const SID = `rc-c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Generate n realistic pi JSON events (message/tool cycles). */
function genEvents(n: number): object[] {
  const events: object[] = [];
  let mi = 0;
  while (events.length < n) {
    const mid = `msg-${mi}`;
    const am = `msg-a${mi}`;
    events.push({ type: "message_start", messageID: mid, sessionID: SID, message: { role: "user", timestamp: Date.now() } });
    events.push({ type: "message_start", messageID: am, sessionID: SID, message: { role: "assistant", timestamp: Date.now() } });
    for (let d = 0; d < 3; d++) {
      events.push({ type: "message_update", messageID: am, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `delta-${mi}-${d} ` } });
    }
    events.push({ type: "tool_execution_start", toolCallId: `call-${mi}`, toolName: "bash", args: { command: "ls -la" } });
    events.push({ type: "tool_execution_end", toolCallId: `call-${mi}`, result: "output-line-ok", isError: false });
    events.push({ type: "message_end", messageID: am, message: { role: "assistant", content: [{ type: "text", text: `answer ${mi} with some body text` }], stopReason: "end_turn" } });
    events.push({ type: "turn_end" });
    mi++;
  }
  return events.slice(0, n);
}

function writeSidecar(id: string, events: object[]): void {
  mkdirSync(SIDECAR_DIR, { recursive: true });
  writeFileSync(join(SIDECAR_DIR, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function sidecarPath(id: string): string {
  return join(SIDECAR_DIR, `${id}.jsonl`);
}

function sidecarBytes(id: string): number {
  return existsSync(sidecarPath(id)) ? readFileSync(sidecarPath(id)).length : 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RC-C: PiSessionAdapter — full sidecar re-read per call", () => {
  it("re-reads the ENTIRE sidecar on EVERY messages() call (readSession count == call count)", async () => {
    const n = 520;
    writeSidecar(SID, genEvents(n));
    const bytes = sidecarBytes(SID);
    expect(bytes).toBeGreaterThan(0);

    const adapter = new PiSessionAdapter("/nonexistent/pi-sessions-dir"); // never finds native session file
    readSessionCalls = 0;

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const msgs = await adapter.messages(SID);
      timings.push(performance.now() - t0);
      expect(msgs.length).toBeGreaterThan(0);
    }

    // readSession must be invoked once per messages() call — no caching.
    expect(readSessionCalls).toBe(5);
    console.log(`[RC-C] messages() x5  -> readSession calls = ${readSessionCalls}  (sidecar=${n} events, ${(bytes / 1024).toFixed(1)} KiB)  timings(ms) = ${timings.map((t) => t.toFixed(2)).join(", ")}`);
  });

  it("re-reads the ENTIRE sidecar on EVERY status() call (readSession count == call count)", async () => {
    const n = 520;
    writeSidecar(SID, genEvents(n));

    const adapter = new PiSessionAdapter("/nonexistent/pi-sessions-dir");
    readSessionCalls = 0;

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const st = await adapter.status(SID);
      timings.push(performance.now() - t0);
      expect(st).not.toBeNull();
    }

    expect(readSessionCalls).toBe(5);
    console.log(`[RC-C] status() x5   -> readSession calls = ${readSessionCalls}  timings(ms) = ${timings.map((t) => t.toFixed(2)).join(", ")}`);
  });

  it("cost scales linearly with sidecar size (no memoization) — 500 vs 5000 vs 20000 events", async () => {
    const sizes = [500, 5000, 20000];
    const adapter = new PiSessionAdapter("/nonexistent/pi-sessions-dir");
    const results: number[] = [];

    for (const n of sizes) {
      const id = `${SID}-s${n}`;
      writeSidecar(id, genEvents(n));
      const t0 = performance.now();
      await adapter.messages(id);
      const dur = performance.now() - t0;
      results.push(dur);
      rmSync(sidecarPath(id), { force: true });
    }

    console.log(`[RC-C] single messages() latency by size: 500 events=${results[0].toFixed(2)}ms, 5000 events=${results[1].toFixed(2)}ms, 20000 events=${results[2].toFixed(2)}ms`);
    // 20000-event sidecar must cost more than 500-event sidecar (re-read scales).
    expect(results[2]).toBeGreaterThan(results[0]);
  });
});

describe("RC-C: PiProcessSessionAdapter — sidecar re-read only while record.messages is empty", () => {
  /** Create a record whose sidecar is named after the record id and wired up. */
  async function makeRecord(events: object[]): Promise<{ adapter: InstanceType<typeof PiProcessSessionAdapter>; id: string }> {
    const adapter = new PiProcessSessionAdapter(undefined, "/nonexistent/pi-sessions-dir");
    const rec = await adapter.create({ directory: "/tmp" });
    expect(rec).not.toBeNull();
    const id = rec!.id;
    writeSidecar(id, events);
    const record = (adapter as unknown as { processes: Map<string, { messages: unknown[]; sidecarPath: string | null }> }).processes.get(id)!;
    record.messages.length = 0;
    record.sidecarPath = sidecarPath(id);
    return { adapter, id };
  }

  it("messages() re-reads on EVERY call while record.messages stays empty (dead/no-message sidecar)", async () => {
    // A sidecar containing only non-message events (turn_end etc.) never
    // populates record.messages — so every messages() call re-reads+replays.
    const nonMessageEvents = Array.from({ length: 520 }, (_, i) => ({
      type: "turn_end",
      sessionID: "x",
      timestamp: Date.now() + i,
    }));
    const { adapter, id } = await makeRecord(nonMessageEvents);

    readSessionCalls = 0;
    for (let i = 0; i < 5; i++) {
      await adapter.messages(id);
    }
    expect(readSessionCalls).toBe(5);
    console.log(`[RC-C] process-session messages() x5 with NON-message sidecar -> readSession calls = ${readSessionCalls} (full re-read every call)`);
  });

  it("messages() re-reads ONCE then serves from memory once record.messages is populated", async () => {
    const { adapter, id } = await makeRecord(genEvents(520));

    readSessionCalls = 0;
    for (let i = 0; i < 5; i++) {
      await adapter.messages(id);
    }
    // The message-producing sidecar populates record.messages on the FIRST call;
    // the record guard (process-session.ts:682) then skips re-reads.
    console.log(`[RC-C] process-session messages() x5 with message-producing sidecar -> readSession calls = ${readSessionCalls} (expected 1)`);
    expect(readSessionCalls).toBe(1);
  });

  it("status() never re-reads the sidecar (process-session status path is memory-only)", async () => {
    const { adapter, id } = await makeRecord(genEvents(520));

    readSessionCalls = 0;
    for (let i = 0; i < 5; i++) {
      await adapter.status(id);
    }
    expect(readSessionCalls).toBe(0);
    console.log(`[RC-C] process-session status() x5 -> readSession calls = ${readSessionCalls} (memory-only)`);
  });
});

afterAll(() => {
  rmSync(sidecarPath(SID), { force: true });
  rmSync(sidecarPath(`${SID}-s500`), { force: true });
  rmSync(sidecarPath(`${SID}-s5000`), { force: true });
  rmSync(sidecarPath(`${SID}-s20000`), { force: true });
});
