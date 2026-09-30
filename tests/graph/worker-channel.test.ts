import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
