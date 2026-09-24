import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openGraphWorkerChannel, invokeGraphWorkerChannel } from "../../src/graph/application/worker-channel.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import type { CanonicalToolDef } from "../../src/platform/types.ts";

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
  rmSync(graphStoreFilePath(join(root, "store")));
  const response = await fetch(grant.endpoint, {
    method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: "graph_submit_outcome", args: { value: "x" } }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Graph worker channel is unavailable" });
});
