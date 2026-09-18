/**
 * Codex MCP server entry point — the process Codex spawns.
 *
 * Codex is extended by a local plugin bundle whose .mcp.json starts this
 * module on stdio (`command: node`, `args: [dist/entries/codex.js]`). It boots
 * the same role runtime every other harness uses — resolve directories, load
 * and resolve roles, sync skill symlinks, assemble the canonical tool set —
 * then serves those tools over newline-delimited JSON-RPC until stdin closes.
 *
 * Tool surface (deliberately NOT expanded here): the canonical intersection set
 * that buildCanonicalTools() assembles for a harness with no session client and
 * no dispatch backend, plus load_role_skill. There are no session_* tools (the
 * stdio transport exposes no rolebox session client) and no dispatch_/loop_/
 * task_/graph_* tools — orchestration needs a dispatch backend, which this
 * entry does not construct, so buildCanonicalTools() registers no graph_* tools
 * either. No stubs stand in for any of them.
 *
 * Run directly with `node dist/entries/codex.js` (or `bun src/entries/codex.ts`).
 * Importing the module does NOT start the server or read stdin; the module-level
 * logger does open its log file and install its signal handlers on first
 * evaluation.
 *
 * @module
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createLoadRoleSkillTool } from "../asset/skill-tool.ts";
import { codexCapabilities } from "../platform/capabilities.ts";
import {
  createCodexMcpServer,
  type CodexMcpServer,
} from "../platform/adapters/codex/server.ts";
import { installProtocolStdoutGuard } from "../platform/adapters/codex/stdout-guard.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "../platform/factory.ts";
import { buildCanonicalTools } from "../platform/tool-assembly.ts";
import type { CanonicalToolContext } from "../platform/types.ts";
import { roleFunctionsMap } from "../resolver/registry.ts";
import { syncSkillSymlinks } from "../sync/skill-symlinks.ts";
import { configureLogDirectory, createSubLogger, formatError } from "../logger.ts";

/** Env var overriding the session id reported to tools (wins over the handshake). */
export const CODEX_SESSION_ID_ENV = "ROLEBOX_SESSION_ID";

/** Session id used when neither the env override nor the handshake supplies one. */
export const DEFAULT_CODEX_SESSION_ID = "codex";

const log = createSubLogger("codex");

/**
 * Resolve the session id for a tool call: the ROLEBOX_SESSION_ID override
 * first, then a session id the MCP client sent in its initialize clientInfo
 * (the stdio transport carries no Mcp-Session-Id header, so this is usually
 * absent), then the stable "codex" fallback.
 */
export function resolveCodexSessionId(
  clientInfo: Record<string, unknown> | undefined,
): string {
  const override = process.env[CODEX_SESSION_ID_ENV]?.trim();
  if (override) return override;

  if (clientInfo) {
    for (const key of ["sessionId", "sessionID", "session_id"]) {
      const value = clientInfo[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }

  return DEFAULT_CODEX_SESSION_ID;
}

/** Read the package version for MCP serverInfo; never fails the boot. */
function resolvePackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Boot the role runtime and build the MCP server WITHOUT serving it. The
 * returned server is ready for serve() (the entry point) or handleLine()
 * (embedded/tests).
 *
 * `output` defaults to process.stdout. The stdio entry passes the protocol
 * writer captured by installProtocolStdoutGuard() instead, because a library
 * logging to process.stdout would otherwise corrupt the protocol stream.
 */
export async function startCodexMcpServer(
  options: { output?: NodeJS.WritableStream } = {},
): Promise<CodexMcpServer> {
  const workingDir = process.cwd();
  configureLogDirectory(workingDir);

  const dirs = resolveRoleboxDirectories({ workingDir, platformId: "codex" });

  const { resolvedRoles, discovered, resolved, skipped } = await initializeRoleboxRuntime({
    directories: dirs,
    roleFunctionsMap,
  });

  syncSkillSymlinks(resolvedRoles, dirs.globalSkillsDir);

  const tools = buildCanonicalTools({
    resolvedRoles,
    directory: workingDir,
    capabilities: codexCapabilities(),
    extraTools: { load_role_skill: createLoadRoleSkillTool(resolvedRoles) },
  });

  // The context factory closes over the server so it can read the clientInfo
  // recorded by the initialize handshake. `signal` is the per-request signal
  // the server aborts when notifications/cancelled names that request, and
  // messageID is unique per call.
  let server: CodexMcpServer | undefined;
  const contextFactory = (
    _info: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
  ): CanonicalToolContext => ({
    sessionID: resolveCodexSessionId(server?.clientInfo),
    messageID: randomUUID(),
    agent: "",
    directory: workingDir,
    worktree: workingDir,
    abort: signal,
    metadata() {
      // stdio MCP has no per-call metadata seam — documented no-op.
    },
    async ask() {
      // stdio MCP has no permission callback — documented no-op.
    },
  });

  server = createCodexMcpServer({
    tools,
    serverVersion: resolvePackageVersion(),
    output: options.output,
    contextFactory,
    onError(message: string): void {
      log.warn(message);
      process.stderr.write("[rolebox codex] " + message + "\n");
    },
  });

  log.info("Codex MCP server ready", {
    discovered,
    resolved,
    skipped,
    tools: Object.keys(tools).length,
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
  });

  return server;
}

/** Boot the server and serve it until stdin ends. */
export async function main(): Promise<void> {
  // Install before booting anything that might log: fd 1 is the protocol
  // channel on this transport, so stdout is diverted to stderr and the server
  // gets the captured writer for its own responses. That writer also carries
  // asynchronous stdout failures (EPIPE), so the server stops writing instead
  // of crashing. Never restored — the process serves until stdin closes.
  const guard = installProtocolStdoutGuard();
  const server = await startCodexMcpServer({ output: guard.stream });
  await server.serve();
}

/** Whether this module was launched as the process entry (not imported). */
function isDirectEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) {
  void main().catch((err: unknown) => {
    // A boot failure must be visible: report it on stderr and exit non-zero
    // instead of vanishing silently.
    process.stderr.write("[rolebox codex] fatal: " + formatError(err).message + "\n");
    process.exitCode = 1;
  });
}

/** Default export for parity with the other harness entries. */
export default { startCodexMcpServer, main };
