/**
 * Codex MCP server entry point — the process Codex spawns.
 *
 * Codex is extended by a local plugin bundle whose .mcp.json starts this
 * module on stdio (`command: node`, `args: [dist/entries/codex.js]`). It boots
 * the same role runtime every other harness uses — resolve directories, load
 * and resolve roles, sync skill symlinks, assemble the canonical tool set —
 * then serves those tools over newline-delimited JSON-RPC until stdin closes.
 *
 * Native agent files map public roles; private children are graph execution
 * targets. MCP metadata attributes each call to its Codex thread. A lazy
 * app-server adapter supplies session browsing and sandboxed graph workers;
 * workers submit through trusted dynamic-tool callbacks into this process.
 *
 * Run directly with `node dist/entries/codex.js`.
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
import { getDataDir } from "../cli/paths.ts";
import { graphStoreRoot } from "../graph/store/schema.ts";
import {
  createCodexMcpServer,
  type CodexMcpServer,
} from "../platform/adapters/codex/server.ts";
import { installProtocolStdoutGuard } from "../platform/adapters/codex/stdout-guard.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "../platform/factory.ts";
import { createCodexRuntime } from "../platform/adapters/codex/runtime.ts";
import { syncCodexAgents } from "../platform/adapters/codex/agents.ts";
import type { CodexSessionOptions } from "../platform/adapters/codex/session.ts";
import { resolveComputerUseGate } from "../loader/computer-use-gate.ts";
import { resolveBrowseUseGate } from "../loader/browse-use-gate.ts";
import { buildComputerContext } from "../computer/context.ts";
import { buildBrowseContext } from "../browse/context.ts";
import type { CanonicalToolContext } from "../platform/types.ts";
import { roleFunctionsMap } from "../resolver/registry.ts";
import { syncSkillSymlinks } from "../sync/skill-symlinks.ts";
import { configureLogDirectory, createSubLogger, formatError } from "../logger.ts";

/** Legacy session attribution override for clients without per-call thread metadata. */
export const CODEX_SESSION_ID_ENV = "ROLEBOX_SESSION_ID";

/** Session id used when neither the env override nor the handshake supplies one. */
export const DEFAULT_CODEX_SESSION_ID = "codex";

const log = createSubLogger("codex");

/**
 * Prefer Codex's per-call thread identity. Legacy clients use the environment,
 * then the handshake; the entry isolates the fallback per MCP connection.
 */
export function resolveCodexSessionId(
  clientInfo: Record<string, unknown> | undefined,
  meta?: Record<string, unknown>,
): string {
  if (typeof meta?.threadId === "string" && meta.threadId.trim()) return meta.threadId.trim();
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
 * The MCP `instructions` string: the workflow blocks for the tool families this
 * server actually registered. Each builder returns `""` when none of its names
 * is present, so a host whose gate kept a family out ships no instructions for
 * it — the tool list and the instructions cannot disagree.
 */
export function buildCodexInstructions(tools: Record<string, unknown>): string {
  const names = Object.keys(tools);
  return [
    buildComputerContext({ tools: names }),
    buildBrowseContext({ tools: names }),
    ...("graph_declare" in tools ? [
      "## Codex rolebox execution\n" +
      "Public roles are native agents named rolebox--<role-id>; private children are canonical graph targets available only to their owning role. " +
      "graph_declare starts Codex workers whose native tools run in a sandboxed exec-server; model requests stay in app-server. Only accepted graph_submit_outcome submissions settle explicit outcomes. " +
      ("graph_wait" in tools
        ? "After graph_declare, inspect parent_notification.available. If true, the shared host can notify this parent after its current turn ends: " +
          "tell the user work is running in the background and end the turn; do not poll graph_status or call graph_wait. " +
          "A committed graph completion or attention notification will continue this session through a new turn. " +
          "If parent_notification.available is false, use graph_wait with the graph_id as a fallback instead of repeatedly polling graph_status. " +
          "It returns when the selected run completes, stops, or needs attention, with the committed snapshot and accepted output. " +
          "On timeout, call graph_wait again with the returned graph_id and run_id. Continue dependent work only after status=complete; handle attention, stopped, or cancelled results explicitly. " +
          "Cancellation only ends the wait; use graph_control for lifecycle changes. "
        : "Use graph_status to collect results and graph_control for lifecycle changes. ") +
      "An external UI-owned chat can only be woken through its own shared app-server; do not assume this capability without parent_notification.available=true. " +
      "Graph workers use native Codex task tools and role-scoped resource loaders; recursive agents and graph control remain unavailable. " +
      "Execution and session forks require Codex's host-supplied thread and sandbox metadata; never supply or invent these as tool arguments.",
    ] : []),
  ].filter(Boolean).join("\n\n");
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
  options: {
    output?: NodeJS.WritableStream;
    /** False disables computer tools; absence leaves them available by default. */
    computerUse?: boolean;
    /**
     * The browse family's host option: true always registers it, false always
     * disables it, absence AUTO-detects the optional Playwright driver.
     */
    browseUse?: boolean;
    rpcFactory?: CodexSessionOptions["rpcFactory"];
    directory?: string;
  } = {},
): Promise<CodexMcpServer> {
  const workingDir = options.directory ?? process.cwd();
  configureLogDirectory(workingDir);

  const dirs = resolveRoleboxDirectories({ workingDir, platformId: "codex" });

  const { resolvedRoles, discovered, resolved, skipped } = await initializeRoleboxRuntime({
    directories: dirs,
    roleFunctionsMap,
  });

  syncSkillSymlinks(resolvedRoles, dirs.globalSkillsDir);
  const native = syncCodexAgents(resolvedRoles, {
    codexHome: dirs.configDir,
    ...(dirs.roleboxDir === join(workingDir, "rolebox") ? { projectDir: workingDir } : {}),
  });
  for (const warning of native.warnings) log.warn(warning);

  // Global availability gates remain independent of the acting role's policy.
  const computerUseGate = resolveComputerUseGate({
    hostOverride: options.computerUse,
    workspaceDir: workingDir,
  });
  const browseUseGate = resolveBrowseUseGate({
    hostOverride: options.browseUse,
    workspaceDir: workingDir,
  });

  const runtime = createCodexRuntime({
    roles: resolvedRoles,
    directory: workingDir,
    storeRoot: graphStoreRoot(getDataDir(), workingDir),
    codexHome: dirs.configDir,
    rpcFactory: options.rpcFactory,
    computerUse: computerUseGate.enabled,
    browseUse: browseUseGate.enabled,
  });
  const tools = runtime.tools;

  // The context factory closes over the server so it can read the clientInfo
  // recorded by the initialize handshake. `signal` is the per-request signal
  // the server aborts when notifications/cancelled names that request, and
  // messageID is unique per call.
  let server: CodexMcpServer | undefined;
  const connectionId = randomUUID();
  const contextFactory = async (
    info: { name: string; args: Record<string, unknown>; meta?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<CanonicalToolContext> => {
    const supplied = resolveCodexSessionId(server?.clientInfo, info.meta);
    const sessionID = supplied === DEFAULT_CODEX_SESSION_ID ? `${supplied}:${connectionId}` : supplied;
    runtime.sessions.rememberInvocation(sessionID, info.meta);
    const agent = typeof info.meta?.threadId === "string" && resolvedRoles.length > 0
      ? await runtime.sessions.resolveAgent(sessionID) : "";
    return {
      sessionID,
      messageID: randomUUID(),
      agent,
      directory: workingDir,
      worktree: workingDir,
      abort: signal,
      metadata() {},
      async ask() {
        // Host MCP approvals remain outside this stdio tool context.
      },
    };
  };

  server = createCodexMcpServer({
    tools,
    sandboxState: true,
    onClose: () => runtime.close(),
    instructions: buildCodexInstructions(tools),
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
    computerUse: computerUseGate.enabled,
    computerUseReason: computerUseGate.reason,
    browseUse: browseUseGate.enabled,
    browseUseReason: browseUseGate.reason,
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
  const interrupt = () => { server.close(); process.stdin.destroy(); process.exitCode = 130; };
  const terminate = () => { server.close(); process.stdin.destroy(); process.exitCode = 143; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try { await server.serve(); }
  finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    server.close();
  }
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
