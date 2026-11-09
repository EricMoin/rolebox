import { execFileSync, spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

export const DESKTOP_LAUNCHER_CONFIG_ENV = "ROLEBOX_CODEX_DESKTOP_LAUNCHER_CONFIG";
export const DESKTOP_LAUNCHER_KIND = "rolebox-codex-desktop-launcher";

export interface CodexDesktopLauncherConfig {
  readonly codexPath: string;
  readonly nodePath: string;
  readonly desktopExecutable: string;
  readonly socketPath: string;
  readonly logPath: string;
  readonly startupTimeoutMs: number;
  readonly maxMessageBytes: number;
}

export interface PreparedCodexDesktopLauncher extends CodexDesktopLauncherConfig {
  readonly kind: typeof DESKTOP_LAUNCHER_KIND;
  readonly relayEntry: string;
}

export type DesktopLauncherErrorCode = "invalid_config" | "invalid_prepared_config" | "unsupported_launcher_path" |
  "runtime_unavailable" | "build_required" | "output_exists" | "invalid_output" | "output_directory_not_private" |
  "missing_launcher_config" | "execve_unavailable" | "socket_already_exists" | "socket_directory_not_private" |
  "relay_startup_timeout" | "relay_startup_failed";

export class DesktopLauncherError extends Error {
  readonly code: DesktopLauncherErrorCode;
  constructor(code: DesktopLauncherErrorCode) { super(code); this.code = code; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseCodexDesktopLauncherConfig(value: unknown): CodexDesktopLauncherConfig {
  const data = record(value);
  const paths = ["codexPath", "nodePath", "desktopExecutable", "socketPath", "logPath"] as const;
  if (!data || paths.some(key => typeof data[key] !== "string" || !isAbsolute(data[key]) || data[key].includes("\0"))) {
    throw new DesktopLauncherError("invalid_config");
  }
  const startupTimeoutMs = data.startupTimeoutMs ?? 15_000;
  const maxMessageBytes = data.maxMessageBytes ?? 100 * 1024 * 1024;
  if (!Number.isInteger(startupTimeoutMs) || (startupTimeoutMs as number) < 100 || (startupTimeoutMs as number) > 60_000 ||
    !Number.isInteger(maxMessageBytes) || (maxMessageBytes as number) < 1024 || (maxMessageBytes as number) > 100 * 1024 * 1024) {
    throw new DesktopLauncherError("invalid_config");
  }
  return { codexPath: data.codexPath as string, nodePath: data.nodePath as string,
    desktopExecutable: data.desktopExecutable as string, socketPath: data.socketPath as string,
    logPath: data.logPath as string, startupTimeoutMs: startupTimeoutMs as number, maxMessageBytes: maxMessageBytes as number };
}

export function readPreparedCodexDesktopLauncher(path: string): PreparedCodexDesktopLauncher {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error();
    const data = record(JSON.parse(readFileSync(path, "utf8")));
    const config = parseCodexDesktopLauncherConfig(data);
    if (data?.kind !== DESKTOP_LAUNCHER_KIND || typeof data.relayEntry !== "string" || !isAbsolute(data.relayEntry)) throw new Error();
    return { ...config, kind: DESKTOP_LAUNCHER_KIND, relayEntry: data.relayEntry };
  } catch { throw new DesktopLauncherError("invalid_prepared_config"); }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function requireFile(path: string, code: "runtime_unavailable" | "build_required", executable = false): void {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error();
    if (executable) accessSync(path, constants.X_OK);
  } catch { throw new DesktopLauncherError(code); }
}

function privateDirectory(path: string, code: "output_directory_not_private" | "socket_directory_not_private"): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = statSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error();
  } catch { throw new DesktopLauncherError(code); }
}

export function prepareCodexDesktopLauncher(config: CodexDesktopLauncherConfig, output: string,
  entries = {
    launcherEntry: fileURLToPath(new URL("./launcher-process.js", import.meta.url)),
    relayEntry: fileURLToPath(new URL("./relay-process.js", import.meta.url)),
  }): void {
  if (process.platform === "win32" || !isAbsolute(output)) throw new DesktopLauncherError("unsupported_launcher_path");
  for (const path of [config.codexPath, config.nodePath, config.desktopExecutable]) requireFile(path, "runtime_unavailable", true);
  for (const entry of Object.values(entries)) requireFile(entry, "build_required");
  const destination = resolve(output);
  const configPath = `${destination}.json`;
  if ([destination, configPath].some(existsSync)) throw new DesktopLauncherError("output_exists");
  if ([config.codexPath, config.nodePath, config.desktopExecutable].some(path => realpathSync(path) === destination)) {
    throw new DesktopLauncherError("invalid_output");
  }
  privateDirectory(dirname(destination), "output_directory_not_private");
  const prepared: PreparedCodexDesktopLauncher = { ...config, kind: DESKTOP_LAUNCHER_KIND, relayEntry: entries.relayEntry };
  writeFileSync(configPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    writeFileSync(destination, ["#!/bin/sh", "# rolebox Codex desktop launcher",
      `export ${DESKTOP_LAUNCHER_CONFIG_ENV}=${shellQuote(configPath)}`,
      `exec ${shellQuote(config.nodePath)} ${shellQuote(entries.launcherEntry)} "$@"`, ""].join("\n"), { mode: 0o700, flag: "wx" });
  } catch (error) { unlinkSync(configPath); throw error; }
}

export function desktopLauncherEvent(config: CodexDesktopLauncherConfig, event: string,
  fields: Readonly<Record<string, string | number | boolean>> = {}): void {
  try {
    mkdirSync(dirname(config.logPath), { recursive: true, mode: 0o700 });
    appendFileSync(config.logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  } catch { /* Diagnostics cannot replace the host's startup result. */ }
}

const VALUE_OPTIONS = new Set(["-c", "--config", "--enable", "--disable", "--profile", "-p",
  "--startup-client-info", "--cloud-skills-snapshot", "--code-mode-host", "--ws-auth", "--ws-token-file",
  "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds"]);

/** Converts only the desktop's direct, long-lived stdio app-server invocation. */
export function desktopSharedArguments(args: readonly string[], socketPath: string,
  context: { readonly desktopParent: boolean; readonly originator?: string }): string[] | undefined {
  if (!context.desktopParent || context.originator !== "Codex Desktop") return;
  if (args.some(arg => ["--help", "-h", "--version", "-V", "--print-startup-config"].includes(arg))) return;
  let command = -1;
  const removed = new Set<number>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (VALUE_OPTIONS.has(arg)) { if (++index >= args.length) return; continue; }
    if (arg.startsWith("--") && arg.includes("=") && VALUE_OPTIONS.has(arg.slice(0, arg.indexOf("=")))) continue;
    if (arg.startsWith("-c") && arg !== "-c") continue;
    if (arg === "--listen" || arg.startsWith("--listen=")) {
      if (command < 0) return;
      const inline = arg.startsWith("--listen=");
      const value = inline ? arg.slice("--listen=".length) : args[index + 1];
      if (value !== "stdio://") return;
      removed.add(index);
      if (!inline) removed.add(++index);
      continue;
    }
    if (arg === "--stdio") { removed.add(index); continue; }
    if (arg === "--") return;
    if (arg.startsWith("-")) continue;
    if (command < 0 && arg === "app-server") command = index;
    else return;
  }
  if (command < 0) return;
  return [...args.filter((_, index) => !removed.has(index)), "--listen", `unix://${socketPath}`];
}

function desktopParentCheck(config: CodexDesktopLauncherConfig): "matched" | "different_executable" | "unresolved" {
  try {
    const executable = process.platform === "linux" ? readlinkSync(`/proc/${process.ppid}/exe`) :
      execFileSync("/bin/ps", ["-ww", "-p", String(process.ppid), "-o", "comm="], { encoding: "utf8" }).trim();
    if (!isAbsolute(executable)) return "unresolved";
    return realpathSync(executable) === realpathSync(config.desktopExecutable) ? "matched" : "different_executable";
  } catch { return "unresolved"; }
}

function nativeEnvironment(config: CodexDesktopLauncherConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_CLI_PATH: config.codexPath, CODEX_APP_RUNTIME_CLI_PATH: config.codexPath };
  delete env[DESKTOP_LAUNCHER_CONFIG_ENV];
  return env;
}

export async function runCodexDesktopLauncher(args: readonly string[]): Promise<void> {
  const path = process.env[DESKTOP_LAUNCHER_CONFIG_ENV];
  if (!path) throw new DesktopLauncherError("missing_launcher_config");
  const config = readPreparedCodexDesktopLauncher(path);
  if (process.platform === "win32" || typeof process.execve !== "function") throw new DesktopLauncherError("execve_unavailable");
  const parentCheck = desktopParentCheck(config);
  const desktopParent = parentCheck === "matched";
  const shared = desktopSharedArguments(args, config.socketPath, {
    desktopParent, originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  });
  const env = nativeEnvironment(config);
  if (!shared) {
    desktopLauncherEvent(config, "native_passthrough", { desktopParent, parentCheck,
      desktopOriginator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop",
      startupInspection: args.includes("--print-startup-config") });
    process.execve(config.codexPath, [config.codexPath, ...args], env);
    return;
  }
  if (existsSync(config.socketPath)) throw new DesktopLauncherError("socket_already_exists");
  privateDirectory(dirname(config.socketPath), "socket_directory_not_private");
  desktopLauncherEvent(config, "desktop_shared_start", { pid: process.pid, desktopParent,
    desktopPipeProvided: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH), desktopNodeProvided: Boolean(process.env.CODEX_MCP_NODE_PATH) });
  const relay = spawn(config.nodePath, [config.relayEntry, path, String(process.pid)], {
    env: Object.fromEntries(["PATH", "TMPDIR", "TMP", "TEMP"].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const ready = relay.stdio[3] as Readable;
      const timer = setTimeout(() => reject(new DesktopLauncherError("relay_startup_timeout")), Math.min(config.startupTimeoutMs, 5000));
      const fail = () => { clearTimeout(timer); reject(new DesktopLauncherError("relay_startup_failed")); };
      relay.once("error", fail); relay.once("exit", fail);
      ready.once("data", data => {
        clearTimeout(timer); relay.off("error", fail); relay.off("exit", fail);
        if (String(data) === "ready\n") resolveReady(); else reject(new DesktopLauncherError("relay_startup_failed"));
      });
    });
    desktopLauncherEvent(config, "native_cli_exec", { pid: process.pid, relayPid: relay.pid! });
    // The relay keeps the desktop's stdio. The original CLI becomes the desktop's direct child.
    process.execve("/bin/sh", ["sh", "-c", 'exec "$@" </dev/null >/dev/null', "rolebox-desktop-host", config.codexPath, ...shared],
      { ...env, ROLEBOX_CODEX_PARENT_SOCKET: config.socketPath });
  } catch (error) {
    relay.kill("SIGTERM");
    throw error;
  }
}
