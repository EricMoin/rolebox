import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { GraphStore } from "../store/graph-store.ts";
import { isGraphToolName, type GraphToolName } from "../host/tool-binding.ts";
import { z } from "zod";
import type { CanonicalToolDef, CanonicalToolContext } from "../../platform/types.ts";

export interface WorkerChannelGrant {
  readonly endpoint: string;
  readonly token: string;
  readonly routeFile?: string;
}

/**
 * THE GRAPH FACE THIS REMOTE CHANNEL EXPOSES to the worker process it serves.
 *
 * The list is the channel's own access decision (`allowedTools` below) AND the
 * set the Pi worker process registers as model-facing tools
 * (`src/platform/adapters/pi/graph-worker.ts`), so the two are one declaration:
 * the face a worker process is handed and the face the channel will serve
 * cannot drift apart. Typed by the closed vocabulary
 * ({@link GraphToolName}), so a misspelled or renamed entry is a compile error
 * rather than a 403 a worker only discovers at runtime.
 *
 * THE MEMBERSHIP DIVERGES FROM THE IN-PROCESS WORKER BASELINE ON PURPOSE, AND
 * THE DIVERGENCE IS RECORDED RATHER THAN UNIFIED. `graph_status` and
 * `graph_audit` read the authoritative store, which
 * `src/graph/host/tool-binding.ts` reserves to the declaring principal, so the
 * in-process face refuses them to a dispatched worker
 * ({@link WORKER_GRANTED_GRAPH_TOOLS} — the delivery channel alone). This
 * remote channel exposes the pair to the worker process it serves today, and
 * narrowing it would withdraw a capability the audit did not authorize
 * changing; the choice is a product decision, so the lists stay typed and
 * comparable instead of being silently reconciled. Widening the in-process
 * face would be the same unauthorized change in the other direction.
 */
export const WORKER_CHANNEL_GRAPH_TOOLS: readonly GraphToolName[] = Object.freeze([
  "graph_submit_outcome",
  "graph_status",
  "graph_audit",
]);
const allowedTools: ReadonlySet<GraphToolName> = new Set(WORKER_CHANNEL_GRAPH_TOOLS);
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_REQUEST_BYTES = 1024 * 1024;

/** A worker submits to its owning host; it never starts a second scheduler. */
export async function openGraphWorkerChannel(
  tools: Record<string, CanonicalToolDef>,
  directory: string,
  storeRoot: string,
) {
  const store = GraphStore.openFile(storeRoot);
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const authorization = request.headers.authorization;
    let caller;
    try {
      caller = typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? store.workerChannels().find(record => record.tokenDigest === tokenDigest(authorization.slice(7))) : undefined;
    } catch {
      reply(503, { error: "Graph worker channel is unavailable" });
      return;
    }
    if (!caller || request.method !== "POST" || request.url !== "/invoke") {
      reply(403, { error: "Worker channel rejected the invocation" });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) {
          reply(413, { error: "Worker invocation exceeds the size limit" });
          return;
        }
        chunks.push(bytes);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const envelope = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).strict().parse(input);
      // The name arrives as an unchecked `string`: it is narrowed into the
      // closed vocabulary FIRST, so the typed membership below is a real check
      // and a name outside the face cannot reach a tool definition at all.
      const tool = isGraphToolName(envelope.tool) && allowedTools.has(envelope.tool)
        ? tools[envelope.tool] : undefined;
      if (!tool) { reply(403, { error: "This worker channel does not expose that tool" }); return; }
      const args = z.object(tool.args).strict().parse(envelope.args);
      const context: CanonicalToolContext = {
        sessionID: caller.sessionId, agent: caller.agent, directory, worktree: directory,
        messageID: "worker-channel", abort: new AbortController().signal,
        metadata() { }, async ask() { throw new Error("Worker channel cannot approve permissions"); },
      };
      reply(200, { result: await tool.execute(args, context) });
    } catch {
      // Exceptions may contain caller data; the protocol deliberately returns no raw exception.
      reply(400, { error: "Worker invocation failed validation or execution" });
    }
  });
  server.requestTimeout = 30_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { store.close(); throw error; }
  server.unref();
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invoke`;
  const routeFor = (sessionId: string) => join(directory, ".rolebox", "pi-sessions", "native", `${sessionId}.channel.json`);
  const publishRoute = (sessionId: string) => {
    const path = routeFor(sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ endpoint }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    return path;
  };
  try { for (const caller of store.workerChannels()) publishRoute(caller.sessionId); }
  catch (error) { server.close(); store.close(); throw error; }
  let closed = false;
  return {
    issue(sessionID: string, agent = ""): WorkerChannelGrant {
      const token = randomBytes(32).toString("base64url");
      if (closed) throw new Error("Worker channel is closed");
      store.rememberWorkerChannel({ tokenDigest: tokenDigest(token), sessionId: sessionID, agent });
      return { endpoint, token, routeFile: publishRoute(sessionID) };
    },
    revoke(sessionID: string) {
      store.forgetWorkerChannels(sessionID);
    },
    close() { if (closed) return; closed = true; server.closeAllConnections(); server.close(); store.close(); },
  };
}

export async function invokeGraphWorkerChannel(grant: WorkerChannelGrant, tool: string, args: unknown, signal?: AbortSignal) {
  const currentEndpoint = () => grant.routeFile
    ? z.object({ endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+\/invoke$/) }).strict().parse(JSON.parse(readFileSync(grant.routeFile, "utf8"))).endpoint
    : grant.endpoint;
  const send = async (endpoint: string) => {
    const response = await fetch(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, args }), signal,
    });
    if (response.status >= 500) throw new Error("Graph worker channel is unavailable");
    return response;
  };
  let response: Response;
  try { response = await send(currentEndpoint()); }
  catch (error) {
    if (!grant.routeFile || signal?.aborted) throw error;
    const deadline = Date.now() + 15_000;
    while (true) {
      signal?.throwIfAborted();
      try {
        response = await send(currentEndpoint());
        break;
      } catch {
        if (Date.now() >= deadline || signal?.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  if (!response.ok) throw new Error(`Graph host rejected the worker invocation (${response.status})`);
  const body = await response.json() as { result: Awaited<ReturnType<CanonicalToolDef["execute"]>> };
  return body.result;
}
