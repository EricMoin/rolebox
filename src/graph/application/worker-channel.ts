import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { GraphStore } from "../store/graph-store.ts";
import { isGraphToolName, type GraphToolName } from "../host/tool-binding.ts";
import { z } from "zod";
import type {
  CanonicalToolDef,
  CanonicalToolContext,
  ToolResult,
} from "../../platform/types.ts";

export interface WorkerChannelGrant {
  readonly endpoint: string;
  readonly token: string;
  readonly routeFile?: string;
}

/**
 * THE GRAPH FACE THIS REMOTE CHANNEL EXPOSES to the worker process it serves.
 *
 * The list is the channel's own access decision (`allowedTools` below), the set
 * the Pi worker process registers as model-facing tools
 * (`src/platform/adapters/pi/graph-worker.ts`) AND the host's own per-call
 * worker boundary ({@link WORKER_GRANTED_GRAPH_TOOLS},
 * `src/graph/host/tool-binding.ts`), so the face a worker process is HANDED, the
 * face the channel SERVES and the face the host ENFORCES are one and the same
 * declaration and cannot drift apart. Typed by the closed vocabulary
 * ({@link GraphToolName}), so a misspelled or renamed entry is a compile error
 * rather than a 403 a worker only discovers at runtime.
 *
 * THE FACE IS THE DELIVERY CHANNEL ALONE, because that is the whole contract a
 * dispatched worker holds: the attempt credential it was handed, the prompt it
 * was dispatched with, and its input view. It settles its node by SUBMITTING AN
 * OUTCOME — `graph_submit_outcome` — and nothing else of the graph face.
 * `graph_status` and `graph_audit` read the authoritative store, which
 * {@link WORKER_GRANTED_GRAPH_TOOLS}' boundary reserves to the
 * declaring/operating principal, and the worker's input view IS its information
 * boundary: a worker that could read the store would bypass the very view the
 * dispatch derived for it, learning the runs, nodes and effects it was never
 * given. A forwarded `graph_status` or `graph_audit` is therefore refused BY
 * NAME through the channel's existing refusal path (403, "This worker channel
 * does not expose that tool"), fail-closed, with no tool body run and no store
 * read — the same call the host refuses to the same worker in process with
 * `worker-tool-forbidden`. Widening this list would hand a worker the readers
 * the boundary withholds; the two faces are kept in step, never allowed to
 * drift.
 */
export const WORKER_CHANNEL_GRAPH_TOOLS: readonly GraphToolName[] = Object.freeze([
  "graph_submit_outcome",
]);
const allowedTools: ReadonlySet<GraphToolName> = new Set(WORKER_CHANNEL_GRAPH_TOOLS);
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * THE TOOL ONE WORKER-CHANNEL NAME DENOTES, WITH THE DEFINITION'S OWN TYPES.
 *
 * The channel is handed a CALLER-SUPPLIED record (`T`), while the name it
 * serves by arrives as runtime data. Resolving that name here is what keeps
 * each definition's declared types attached all the way to the call: the answer
 * is the record's own value type, so `args` stays the tool's zod shape and
 * `execute` keeps the argument type its author declared — instead of the
 * erased `z.ZodRawShape` / `{[k: string]: any}` an index signature over
 * `Record<string, CanonicalToolDef>` answers, which accepted a call the tool
 * never declared and only the runtime parse stood between.
 *
 * THE LOOKUP IS KEYED BY THE RECORD, not asserted: `name` is a key of the
 * record's own type, so `tools[name]` IS the named definition's own type, and a
 * name the record does not hold answers `undefined` for the caller to refuse.
 */
export function workerChannelToolOf<
  T extends Record<string, CanonicalToolDef>,
  K extends keyof T,
>(tools: T, name: K): T[K] | undefined {
  return holdsWorkerChannelTool(tools, name) ? tools[name] : undefined;
}

/**
 * Whether the record itself carries the name (an own property).
 *
 * A plain predicate, never an assertion: the record's own value type already
 * describes what a present name denotes, so this check establishes presence and
 * nothing more.
 */
function holdsWorkerChannelTool(tools: object, name: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(tools, name);
}

/**
 * PARSE ONE CALL'S ARGUMENTS AGAINST THE TOOL'S OWN DECLARED SHAPE AND RUN IT.
 *
 * `Def` carries its `Args` from the definition itself, so the value `z.object`
 * answers is exactly what `execute` declares and the two cannot drift apart: an
 * argument object that does not match the tool's shape is refused by the parse,
 * and the executed call is checked against the declared argument type rather than
 * against an index signature. The `strict` parse is the worker face's argument
 * rule and is unchanged — a call carrying a field the tool does not declare is
 * refused, as before.
 */
async function invokeWorkerChannelTool<Def extends CanonicalToolDef>(
  tool: Def,
  rawArgs: unknown,
  context: CanonicalToolContext,
): Promise<ToolResult> {
  const args = z.object(tool.args).strict().parse(rawArgs);
  return tool.execute(args, context);
}

/**
 * THE HOST'S RESPONSE ENVELOPE, READ RATHER THAN ASSERTED.
 *
 * `response.json()` is `any`, so the assertion this replaces manufactured the
 * tool's `ToolResult` from the host's convention: a 200 carrying `{ error }`
 * answered `undefined` TYPED as the tool's result, and the waiting worker could
 * not tell a result from a protocol failure. The envelope is now validated — a
 * string result, or the declared result object — so a response this protocol
 * does not define is REFUSED BY NAME instead of becoming a fabricated result.
 * A well-formed envelope is unchanged: `loose` objects keep the fields they
 * carry, and the same bytes parse to the same `ToolResult`.
 */
const workerChannelToolResult: z.ZodType<ToolResult> = z.union([
  z.string(),
  z.object({
    title: z.string().optional(),
    output: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    attachments: z.array(z.object({
      type: z.literal("file"),
      mime: z.string(),
      url: z.string(),
      filename: z.string().optional(),
    })).optional(),
  }).loose(),
]);
const workerChannelEnvelope = z.object({ result: workerChannelToolResult }).loose();

/**
 * A worker submits to its owning host; it never starts a second scheduler.
 *
 * THE TOOL RECORD IS THE CALLER'S OWN TYPE. `T` is inferred from the record the
 * host passes — the concrete definitions, each with its declared `Args` — so
 * the face this channel serves keeps the tools' argument and result types
 * (see {@link workerChannelToolOf}); a record whose values are not canonical
 * tool definitions is refused at the call site rather than erased here.
 */
export async function openGraphWorkerChannel<T extends Record<string, CanonicalToolDef>>(
  tools: T,
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
        ? workerChannelToolOf(tools, envelope.tool) : undefined;
      if (!tool) { reply(403, { error: "This worker channel does not expose that tool" }); return; }
      const context: CanonicalToolContext = {
        sessionID: caller.sessionId, agent: caller.agent, directory, worktree: directory,
        messageID: "worker-channel", abort: new AbortController().signal,
        metadata() { }, async ask() { throw new Error("Worker channel cannot approve permissions"); },
      };
      reply(200, { result: await invokeWorkerChannelTool(tool, envelope.args, context) });
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
  const body: unknown = await response.json();
  const envelope = workerChannelEnvelope.safeParse(body);
  if (!envelope.success) {
    throw new Error(
      "Graph worker channel answered a malformed response envelope for " +
        JSON.stringify(tool) +
        ", so no tool result is fabricated",
    );
  }
  return envelope.data.result;
}
