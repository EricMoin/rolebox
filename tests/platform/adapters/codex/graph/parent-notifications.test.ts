import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CodexParentNotifications, CodexParentSocketClient } from "../../../../../src/platform/adapters/codex/graph/parent-notifications.ts";
import type { GraphNotification } from "../../../../../src/graph/application/graph-notifications.ts";
import type { CodexRecord } from "../../../../../src/platform/adapters/codex/app-server/app-server.ts";

const roots: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const notice: GraphNotification = { id: "notice-1", graphId: "flow", runId: "run-1", sessionId: "parent",
  kind: "complete", reason: "All graph work completed." };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pn-")); roots.push(root);
  const socketPath = join(root, "s");
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const calls: Array<{ method: string; params: CodexRecord }> = [];
  let loaded = true;
  let malformed = false;
  let failTurn = false;
  sockets.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(data.toString());
    calls.push({ method: request.method, params: request.params });
    if (request.id === undefined) return;
    if (malformed) { socket.send("invalid-json"); return; }
    if (request.method === "turn/start" && failTurn) {
      socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: "Thread not found" } })); return;
    }
    const result = request.method === "thread/loaded/list" ? { data: loaded ? ["parent"] : [], nextCursor: null } :
      request.method === "turn/start" ? { turn: { id: "new-parent-turn" } } : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  closers.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const channel = new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: socketPath } });
  closers.push(() => channel.close());
  return { channel, calls, socketPath, setLoaded: (value: boolean) => { loaded = value; },
    setMalformed: () => { malformed = true; }, setFailTurn: () => { failTurn = true; } };
}

describe("Codex parent notifications", () => {
  it("keeps graph_wait as the fallback when no shared socket is available", async () => {
    const channel = new CodexParentNotifications({ codexHome: "/path/to/absent/codex", env: {} });
    expect(channel.configured).toBe(false);
    expect((await channel.inspect("parent")).available).toBe(false);
    expect(await channel.send(notice)).toBe(false);
    channel.close();
  });

  it("honors explicit disable and rejects relative socket paths", () => {
    const channel = new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: "off" } });
    expect(channel.configured).toBe(false);
    expect(() => new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: "host.sock" } })).toThrow("absolute socket path");
  });

  it.skipIf(process.platform === "win32")("delivers graph completion as tool output to the existing parent host", async () => {
    const f = await fixture();
    expect((await f.channel.inspect("parent")).available).toBe(true);
    expect(await f.channel.send(notice)).toBe(true);
    const start = f.calls.find(call => call.method === "turn/start")!;
    expect(start.params.threadId).toBe("parent");
    expect(start.params.input).toEqual([]);
    expect(start.params.toolOutput).toMatchObject({ namespace: "rolebox", name: "graph_notification" });
    expect(JSON.stringify(start.params.toolOutput)).toContain("[GRAPH COMPLETE]");
    expect(JSON.stringify(start.params.toolOutput)).toContain("notice-1");
    expect(f.calls.some(call => ["thread/start", "thread/resume", "thread/fork"].includes(call.method))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("never resumes a parent loaded by another app-server", async () => {
    const f = await fixture(); f.setLoaded(false);
    expect((await f.channel.inspect("parent")).available).toBe(false);
    expect(await f.channel.send(notice)).toBe(false);
    expect(f.calls.some(call => call.method === "turn/start" || call.method === "thread/resume")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rechecks loaded ownership after the declaring turn ends", async () => {
    const f = await fixture();
    expect((await f.channel.inspect("parent")).available).toBe(true);
    f.setLoaded(false);
    expect(await f.channel.send(notice)).toBe(false);
    expect(f.calls.some(call => call.method === "turn/start")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("treats host refusal as retryable delivery failure", async () => {
    const f = await fixture(); f.setFailTurn();
    expect(await f.channel.send(notice)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("releases malformed responses without waking another session", async () => {
    const f = await fixture(); f.setMalformed();
    expect((await f.channel.inspect("parent")).available).toBe(false);
    expect(f.calls.some(call => call.method === "turn/start")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("closing a client preserves the shared host", async () => {
    const f = await fixture();
    expect((await f.channel.inspect("parent")).available).toBe(true);
    f.channel.close();
    expect(await f.channel.send(notice)).toBe(false);
    const other = new CodexParentSocketClient(f.socketPath); closers.push(() => other.close());
    expect(await other.request("thread/loaded/list", {})).toMatchObject({ data: ["parent"] });
  });
});
