import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openGraphWorkerChannel, invokeGraphWorkerChannel } from "../../src/graph/application/worker-channel.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { storeIdentityPath } from "../../src/graph/store/identity.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import type { CanonicalToolDef } from "../../src/platform/types.ts";
import { attemptStoreEntryRemoval, attemptStoreRootMoveAside } from "./helpers/vanish-store.ts";

/** SQLite's own file magic, the first 16 bytes of every database file. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

const roots: string[] = [];
const channels: Awaited<ReturnType<typeof openGraphWorkerChannel>>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-channel-")); roots.push(root);
  const tools: Record<string, CanonicalToolDef> = {
    graph_submit_outcome: {
      description: "Verify authenticated caller", args: { value: z.string() },
      execute: async (args, ctx) => JSON.stringify({ value: args.value, caller: ctx?.sessionID }),
    },
  };
  const open = async () => {
    const channel = await openGraphWorkerChannel(tools, root, join(root, "store"));
    channels.push(channel); return channel;
  };
  return { root, open };
}

it("binds added host tools to the authenticated caller and aborts them when HTTP disconnects", async () => {
  const { root } = fixture();
  let started!: () => void;
  let aborted!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const channel = await openGraphWorkerChannel({}, root, join(root, "store"), {
    resolveTool(name, context) {
      if (name !== "custom_wait" || context.sessionID !== "worker") return undefined;
      return { description: "Wait", args: {}, execute: async (_args, ctx) => {
        started();
        await new Promise<void>(resolve => ctx.abort.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
        return "cancelled";
      } };
    },
  });
  channels.push(channel);
  const grant = channel.issue("worker");
  const signal = new AbortController();
  const call = invokeGraphWorkerChannel(grant, "custom_wait", {}, signal.signal).catch(() => undefined);
  await entered;
  signal.abort();
  await call;
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("Host tool was not cancelled")), 2_000))]);
  const other = channel.issue("other");
  await expect(invokeGraphWorkerChannel(other, "custom_wait", {})).rejects.toThrow("403");
  await expect(invokeGraphWorkerChannel(grant, "graph_arbitrary", {})).rejects.toThrow("403");
});

it("never replays a host tool after its response is lost", async () => {
  const { root } = fixture();
  let executions = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the complete submitted call */ }
    executions++;
    if (executions === 1) response.socket?.destroy();
    else response.end(JSON.stringify({ result: "duplicate execution" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invoke`;
  const routeFile = join(root, "route.json");
  writeFileSync(routeFile, JSON.stringify({ endpoint }));
  try {
    await expect(invokeGraphWorkerChannel({ endpoint, routeFile, token: "fixture" }, "memory_write", {})).rejects.toThrow();
    expect(executions).toBe(1);
  } finally { server.closeAllConnections(); server.close(); }
});

it("preserves caller authentication across host restart without storing the bearer", async () => {
  const { root, open } = fixture();
  const first = await open();
  const grant = first.issue("session-one", "worker");
  expect(JSON.parse(String(await invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "before" })))).toEqual({ value: "before", caller: "session-one" });
  expect(readFileSync(graphStoreFilePath(join(root, "store"))).includes(Buffer.from(grant.token))).toBe(false);
  expect(readFileSync(grant.routeFile!, "utf8")).not.toContain(grant.token);
  first.close();
  const second = await open();
  expect(JSON.parse(String(await invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "after" })))).toEqual({ value: "after", caller: "session-one" });
  second.revoke("session-one");
  await expect(invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "revoked" })).rejects.toThrow("403");
});

it("rejects unauthorized tools, forged context, malformed arguments and cross-session tokens", async () => {
  const { open } = fixture();
  const channel = await open();
  const one = channel.issue("one"), two = channel.issue("two");
  await expect(invokeGraphWorkerChannel(one, "graph_control", {})).rejects.toThrow("403");
  await expect(invokeGraphWorkerChannel(one, "graph_submit_outcome", { value: "x", sessionID: "two" })).rejects.toThrow("400");
  await expect(invokeGraphWorkerChannel({ ...one, token: "invalid" }, "graph_submit_outcome", { value: "x" })).rejects.toThrow("403");
  const results = await Promise.all([one, two].map(grant => invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "x" })));
  expect(results.map(value => JSON.parse(String(value)).caller)).toEqual(["one", "two"]);
});

it("rolls back channel grants with the owning store transaction", () => {
  const { root } = fixture();
  const store = GraphStore.openFile(join(root, "store"));
  try {
    expect(() => store.transaction(tx => {
      tx.rememberWorkerChannel({ tokenDigest: "a".repeat(64), sessionId: "worker", agent: "" });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.workerChannels()).toEqual([]);
    expect(() => store.rememberWorkerChannel({ tokenDigest: "b".repeat(64), sessionId: "../escape", agent: "" })).toThrow("identity");
  } finally { store.close(); }
});


it("returns unavailable when its authoritative store disappears", async () => {
  const { root, open } = fixture();
  const channel = await open();
  const grant = channel.issue("worker");
  const storeRoot = join(root, "store");
  const file = graphStoreFilePath(storeRoot);
  // Can this platform make an OPEN database's path disappear? The POSIX family
  // unlinks it under the channel's handle; windows-latest refuses the unlink
  // (`EBUSY`) and the move of the entry (`EPERM`) — the CI finding
  // helpers/vanish-store.ts records. Each platform asserts the truth it can have.
  const removal = attemptStoreEntryRemoval(storeRoot);
  if (removal.removed) {
    const response = await fetch(grant.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "graph_submit_outcome", args: { value: "x" } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Graph worker channel is unavailable" });
  } else {
    // The OS refused, and it changed nothing: the channel is still authoritative
    // and keeps answering for its live grant instead of reporting a false 503,
    // and the file is still the database that holds that grant.
    for (const refusal of removal.refusals) {
      expect(refusal.code, refusal.operation).toMatch(/^(EBUSY|EPERM|EACCES)$/);
    }
    const served = await fetch(grant.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "graph_submit_outcome", args: { value: "x" } }),
    });
    expect(served.status).toBe(200);
    const body = await served.json() as { result: string };
    expect(JSON.parse(body.result)).toEqual({ value: "x", caller: "worker" });
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 16).toString("latin1")).toBe(SQLITE_MAGIC);
    // The refusal was the open handle's, not the path's: with the channel closed
    // the very same removal is permitted, and the next open refuses the bound
    // database it can no longer find.
    channel.close();
    expect(attemptStoreEntryRemoval(storeRoot).removed).toBe(true);
    expect(() => GraphStore.openFile(storeRoot)).toThrow("bound database is missing");
  }
});

it("returns unavailable when its store root can be moved out of the way, and keeps serving when the platform refuses", async () => {
  const { root, open } = fixture();
  const channel = await open();
  const grant = channel.issue("worker");
  const storeRoot = join(root, "store");
  const file = graphStoreFilePath(storeRoot);
  // The root has no open handle of its own, so the POSIX family moves it out from
  // under the live database; windows-latest refuses that move while the store is
  // open (`EPERM`, run 36673190424) — see helpers/vanish-store.ts.
  const attempt = attemptStoreRootMoveAside(storeRoot);
  if (attempt.removed) {
    const response = await fetch(grant.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "graph_submit_outcome", args: { value: "x" } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Graph worker channel is unavailable" });
  } else {
    // The refusal moved nothing: the root, its marker and its database are exactly
    // where they were, and the channel keeps answering for its live grant instead
    // of reporting a false 503.
    for (const refusal of attempt.refusals) {
      expect(refusal.operation).toBe("rename-root");
      expect(refusal.code, refusal.operation).toMatch(/^(EBUSY|EPERM|EACCES)$/);
    }
    expect(existsSync(file)).toBe(true);
    expect(existsSync(storeIdentityPath(file))).toBe(true);
    const served = await fetch(grant.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "graph_submit_outcome", args: { value: "x" } }),
    });
    expect(served.status).toBe(200);
    // The refusal was the open handle's, not the directory's: with the channel
    // closed the very same move succeeds, and the next open refuses the database
    // the recreated root no longer holds.
    channel.close();
    const afterClose = attemptStoreRootMoveAside(storeRoot);
    expect(afterClose.removed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(() => GraphStore.openFile(storeRoot)).toThrow("bound database is missing");
  }
});
