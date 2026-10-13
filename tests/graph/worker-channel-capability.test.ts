/**
 * THE REMOTE WORKER CHANNEL'S GRAPH FACE IS THE DELIVERY CHANNEL ALONE.
 *
 * WHAT THIS FILE PINS. `WORKER_CHANNEL_GRAPH_TOOLS`
 * (`src/graph/application/worker-channel.ts`) is the ONE declaration that is at
 * once the face the Pi worker process is handed, the face the channel serves
 * (`allowedTools`) and — now — the face the host's own per-call boundary
 * enforces (`WORKER_GRANTED_GRAPH_TOOLS`, `src/graph/host/tool-binding.ts`).
 * The two lists agree exactly: a worker's contract is the attempt credential,
 * its prompt and its input view, and it settles by SUBMITTING AN OUTCOME.
 * `graph_status` and `graph_audit` read the authoritative store, which the
 * boundary reserves to the declaring/operating principal, and the worker's
 * input view IS its information boundary — a store reader would bypass it.
 *
 * WHAT IS ASSERTED, and how.
 *
 * 1. THE FACE. The exported list is exactly `["graph_submit_outcome"]`, frozen,
 *    drawn from the closed vocabulary, and equal to the in-process grant — so
 *    the two worker faces cannot drift apart silently.
 * 2. THE SERVED FACE, over REAL HTTP. A forwarded `graph_status` and a
 *    forwarded `graph_audit` each answer the channel's own 403
 *    ("This worker channel does not expose that tool") and NOTHING runs: the
 *    tool record the channel was opened with deliberately DEFINES both readers,
 *    so the refusal proves the channel's name gate rather than a missing
 *    definition, and each reader body records its own invocation. The record
 *    stays empty — the body is the only path from one of those names to the
 *    store, so no store read happens (fail-closed, no data).
 * 3. THE DELIVERY CHANNEL, end to end. The same channel still serves
 *    `graph_submit_outcome` through `invokeGraphWorkerChannel`: the result
 *    envelope parses to the tool's own value and the strict argument rule is
 *    unchanged (a field the tool does not declare is still a 400).
 *
 * STRENGTH: real HTTP against the shipped server, a real file-backed store in a
 * temp root. No host SDK runs.
 *
 * @module
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  invokeGraphWorkerChannel,
  openGraphWorkerChannel,
  WORKER_CHANNEL_GRAPH_TOOLS,
} from "../../src/graph/application/worker-channel.ts";
import {
  GRAPH_TOOL_NAMES,
  WORKER_GRANTED_GRAPH_TOOLS,
  type GraphToolName,
} from "../../src/graph/host/tool-binding.ts";
import type { CanonicalToolDef } from "../../src/platform/types.ts";

/** The channel's own refusal, byte-for-byte (`worker-channel.ts`, the 403). */
const CHANNEL_REFUSAL = { error: "This worker channel does not expose that tool" };

// The type-level pins: the day either face goes back to a bare-string list,
// these annotations stop compiling (`bun run typecheck:tests` is the authority).
const CHANNEL_FACE: readonly GraphToolName[] = WORKER_CHANNEL_GRAPH_TOOLS;
const HOST_FACE: readonly GraphToolName[] = WORKER_GRANTED_GRAPH_TOOLS;

const roots: string[] = [];
const channels: Awaited<ReturnType<typeof openGraphWorkerChannel>>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A channel opened over a real store, with a tool record that DEFINES both
 * store readers. Each reader body appends its name to `readerCalls`; a
 * forwarded call that reached one would therefore be observable.
 */
async function servedChannel() {
  const root = mkdtempSync(join(tmpdir(), "worker-capability-"));
  roots.push(root);
  const readerCalls: string[] = [];
  const tools: Record<string, CanonicalToolDef> = {
    graph_submit_outcome: {
      description: "Verify the authenticated caller and answer its value.",
      args: { value: z.string() },
      execute: async (args, context) =>
        JSON.stringify({ value: args.value, caller: context?.sessionID }),
    },
    // Deliberately DEFINED and NOT SERVED: the refusal below is the channel's
    // name gate, not an absent definition.
    graph_status: {
      description: "Read the authoritative store.",
      args: {},
      execute: async () => {
        readerCalls.push("graph_status");
        return "the store was read";
      },
    },
    graph_audit: {
      description: "Inventory the authoritative store.",
      args: {},
      execute: async () => {
        readerCalls.push("graph_audit");
        return "the store was inventoried";
      },
    },
  };
  const channel = await openGraphWorkerChannel(tools, root, join(root, "store"));
  channels.push(channel);
  return { channel, grant: channel.issue("session-one", "worker"), readerCalls };
}

/** One forwarded invocation, read as the channel's own status and body. */
async function forward(endpoint: string, token: string, tool: string, args: unknown) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return { status: response.status, body: await response.json() };
}

describe("the remote worker channel's graph face", () => {
  it("serves exactly the in-process worker grant: the delivery channel alone", () => {
    expect([...CHANNEL_FACE]).toEqual(["graph_submit_outcome"]);
    expect(CHANNEL_FACE.length).toBe(1);
    expect(Object.isFrozen(WORKER_CHANNEL_GRAPH_TOOLS)).toBe(true);
    // THE TWO FACES AGREE — the subset relation is the unified contract, not an
    // accident: every served name is granted in process, and nothing more.
    for (const name of WORKER_CHANNEL_GRAPH_TOOLS) {
      expect(GRAPH_TOOL_NAMES).toContain(name);
      expect(WORKER_GRANTED_GRAPH_TOOLS).toContain(name);
    }
    expect([...CHANNEL_FACE]).toEqual([...HOST_FACE]);
    for (const reader of ["graph_status", "graph_audit"] as const) {
      expect(WORKER_CHANNEL_GRAPH_TOOLS).not.toContain(reader);
      expect(WORKER_GRANTED_GRAPH_TOOLS).not.toContain(reader);
    }
  });

  it("refuses a forwarded store reader by name, running no body and reading nothing", async () => {
    const { grant, readerCalls } = await servedChannel();
    for (const reader of ["graph_status", "graph_audit"] as const) {
      const response = await forward(grant.endpoint, grant.token, reader, {});
      expect(response.status).toBe(403);
      expect(response.body).toEqual(CHANNEL_REFUSAL);
      // The worker's own client reports the same refusal rather than a result.
      await expect(invokeGraphWorkerChannel(grant, reader, {})).rejects.toThrow("403");
    }
    // NO BODY RAN, so no store read happened: the readers' bodies are the only
    // path from either name to the authoritative store on this channel.
    expect(readerCalls).toEqual([]);
  });

  it("still serves graph_submit_outcome end to end, with its argument rule intact", async () => {
    const { grant } = await servedChannel();
    const result = await invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "settled" });
    expect(JSON.parse(String(result))).toEqual({ value: "settled", caller: "session-one" });
    // The strict parse is unchanged: a field the tool does not declare is still
    // refused by the channel (the 400 path), not executed.
    await expect(
      invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "x", sessionID: "two" }),
    ).rejects.toThrow("400");
  });
});
