import { findExecutable } from "../../../scripts/node-process.ts";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpToolCallResult } from "../../../src/platform/adapters/codex/tool-factory.ts";

export function startStdioClient(worktree: string, browseUse = true) {
  const repository = new URL("../../../", import.meta.url);
  const registry = new URL("dist/platform/registry.js", repository).href;
  const entry = new URL("dist/entries/codex.js", repository);
  const configDir = join(worktree, "global-config");
  const hostDir = join(worktree, "host");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(worktree, "rolebox"), { recursive: true });
  mkdirSync(join(worktree, ".rolebox"), { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), "browseUse: true\ncomputerUse: false\nregistries: []\n");
  writeFileSync(join(worktree, ".rolebox", "config.json"), JSON.stringify({ browseUse, computerUse: false }));
  const preload = join(worktree, "host-paths.mjs");
  // Isolate skill synchronization without changing the user's home environment.
  writeFileSync(preload, `
    import { PLATFORM_REGISTRY } from ${JSON.stringify(registry)};
    PLATFORM_REGISTRY.find(platform => platform.id === "codex").paths = () => (${JSON.stringify({
      platformId: "codex", configDir: hostDir, agentsDir: join(hostDir, "skills"), skillsDir: join(hostDir, "skills"),
    })});
  `);
  const node = findExecutable("node");
  if (!node) throw new Error("The stdio live suite requires Node.js and a completed build.");
  const child = spawn(node, ["--import", pathToFileURL(preload).href, fileURLToPath(entry)], {
    cwd: worktree,
    env: { ...process.env, NODE_OPTIONS: "", ROLEBOX_CONFIG_DIR: configDir, ROLEBOX_DATA_DIR: join(worktree, "data") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let failure: Error | undefined;
  const rejectPending = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const output = createInterface({ input: child.stdout });
  output.on("line", line => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error("MCP returned a protocol error."));
      else request.resolve(message.result);
    } catch {
      rejectPending(new Error("The MCP subprocess emitted non-JSON stdout."));
    }
  });
  child.stderr.resume();
  child.on("error", error => rejectPending(error));
  child.stdin.on("error", error => rejectPending(error));
  const exited = new Promise<number | null>(resolve => child.once("exit", code => {
    rejectPending(new Error(`The MCP subprocess exited with code ${String(code)}.`));
    resolve(code);
  }));

  function notify(method: string, params: unknown = {}): void {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function request<T>(method: string, params: unknown = {}, timeoutMs = 15_000): { id: number; result: Promise<T> } {
    const id = ++nextId;
    const result = new Promise<T>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
      }, timeoutMs);
      pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    return { id, result };
  }

  return {
    request,
    notify,
    async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
      return request<McpToolCallResult>("tools/call", { name, arguments: args }).result;
    },
    async close(): Promise<number | null> {
      if (!failure && browseUse) {
        for (const id of pending.keys()) notify("notifications/cancelled", { requestId: id });
        try { await request("tools/call", { name: "browse_close", arguments: {} }, 3_000).result; } catch {}
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.stdin.end();
      try { return await exited; } finally { clearTimeout(timer); output.close(); }
    },
  };
}
