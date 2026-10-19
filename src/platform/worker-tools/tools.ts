import { z } from "zod";
import { defineTool } from "../ports/tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolAttachment, ToolResult } from "../types.ts";
import { WorkerToolAccessError, type WorkerToolSession } from "./session.ts";
import { WorkerCodeError } from "./code.ts";
import type { Awaitable } from "./types.ts";

export interface WorkerCapabilityToolOptions {
  resolveSession(context: CanonicalToolContext): Awaitable<WorkerToolSession | undefined>;
  formatResult?(result: unknown): ToolResult;
}

export function createWorkerCapabilityTools(options: WorkerCapabilityToolOptions): Record<string, CanonicalToolDef> {
  const format = options.formatResult ?? formatWorkerToolResult;
  const directoryArgs = {
    action: z.enum(["list", "search", "describe", "call"]),
    query: z.string().max(4096).optional(),
    source: z.string().max(1024).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    name: z.string().min(1).max(1024).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  };
  const codeArgs = {
    source: z.string().min(1).max(65_536).describe("Async JavaScript body. Use await tools.call(name, args), tools[name](args), tools.list(query), tools.describe(name), emit(value), and return. Imports and timers are unavailable. Execution uses a disposable process, not an OS sandbox."),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    maxResultBytes: z.number().int().min(1).max(1_048_576).optional(),
    maxCalls: z.number().int().min(1).max(100).optional(),
  };
  return {
    graph_worker_tools: defineTool({
      description: "Discover this worker's authorized host tools. list/search return compact pages; describe returns the full schema and activates a native tool when supported. call invokes the named tool through the host's normal permission and execution pipeline. Discovery never grants additional permissions.",
      args: directoryArgs,
      async execute(input, context) {
        try {
          const args = z.object(directoryArgs).parse(input);
          const session = await options.resolveSession(context);
          if (!session || session.presentation.mode === "native") throw new WorkerToolAccessError("Tool discovery is not enabled for this worker");
          context.abort.throwIfAborted();
          switch (args.action) {
            case "list": case "search":
              return format(await session.list({ query: args.query, source: args.source, offset: args.offset, limit: args.limit }));
            case "describe":
              if (!args.name) throw new TypeError("describe requires name");
              return format(await session.describe(args.name));
            case "call":
              if (!args.name) throw new TypeError("call requires name");
              return format(await session.call(args.name, args.arguments ?? {}, { signal: context.abort }));
          }
        } catch (error) { return failure(error); }
      },
    }),
    graph_worker_code: defineTool({
      description: "Compose authorized host tool calls in asynchronous JavaScript. Filter intermediate results in code and use emit(result) to retain rich content. The script process is terminated on timeout/cancellation; in-flight tools receive cancellation through the host with a 1s grace period. Unsettled calls are reported explicitly. Await every host call before returning. This executor is not an OS security sandbox.",
      args: codeArgs,
      async execute(input, context) {
        try {
          const args = z.object(codeArgs).parse(input);
          const session = await options.resolveSession(context);
          if (!session) throw new WorkerToolAccessError("Code execution is not enabled for this worker");
          return format(await session.runCode(args.source, { ...args, signal: context.abort }));
        } catch (error) { return failure(error); }
      },
    }),
  };
}

/** Retain native payloads for adapters, alongside portable text and media attachments. */
export function formatWorkerToolResult(value: unknown): ToolResult {
  const attachments: ToolAttachment[] = [];
  collectAttachments(value, attachments);
  return {
    output: typeof value === "string" ? value : JSON.stringify(value) ?? "null",
    metadata: { nativeResult: value, ...(hasToolError(value) ? { error: true } : {}) },
    ...(attachments.length ? { attachments } : {}),
  };
}

function hasToolError(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (object.isError === true) return true;
  if (object.metadata && typeof object.metadata === "object" && (object.metadata as Record<string, unknown>).error === true) return true;
  return false;
}

function collectAttachments(value: unknown, attachments: ToolAttachment[]): void {
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.attachments)) {
    for (const item of object.attachments) {
      if (item?.type === "file" && typeof item.mime === "string" && typeof item.url === "string") attachments.push(item);
    }
  }
  if (Array.isArray(object.content)) {
    for (const item of object.content) {
      if ((item?.type === "image" || item?.type === "audio") && typeof item.data === "string" && typeof item.mimeType === "string") {
        attachments.push({ type: "file", mime: item.mimeType, url: `data:${item.mimeType};base64,${item.data}` });
      } else if (item?.type === "resource" && typeof item.resource?.blob === "string" && typeof item.resource?.mimeType === "string") {
        attachments.push({ type: "file", mime: item.resource.mimeType, url: `data:${item.resource.mimeType};base64,${item.resource.blob}` });
      } else if (item?.type === "resource_link" && typeof item.uri === "string" && typeof item.mimeType === "string") {
        attachments.push({ type: "file", mime: item.mimeType, url: item.uri,
          ...(typeof item.name === "string" ? { filename: item.name } : {}),
        });
      }
    }
  }
  if ("emitted" in object && Array.isArray(object.emitted)) {
    for (const item of object.emitted) collectAttachments(item, attachments);
    collectAttachments(object.value, attachments);
  }
}

function failure(error: unknown): ToolResult {
  return { output: `Error: ${error instanceof Error ? error.message : String(error)}`, metadata: { error: true, ...(error instanceof WorkerCodeError ? { code: error.code, pendingCalls: error.pendingCalls } : {}) } };
}
