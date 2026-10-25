import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run package acceptance with npm run test:package");
const scratch = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "rolebox-package-test-"));
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", CI: "1", ROLEBOX_NO_WELCOME: "1" };
environment.ROLEBOX_CONFIG_DIR = join(scratch, "config");
environment.ROLEBOX_DATA_DIR = join(scratch, "data");
environment.ROLEBOX_LOG_DIR = join(scratch, "logs");

// Nested npm reads the original allow-scripts policy from its configuration file.
for (const key of Object.keys(environment)) if (/^npm_config_allow_scripts$/i.test(key)) delete environment[key];

function command(program: string, args: string[], cwd: string, timeout = 120_000): string {
  const result = spawnSync(program, args, {
    cwd, env: environment, encoding: "utf8", timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.error) throw new Error(`${args[0] ?? program} failed: ${result.error.message}\n${diagnostic}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status}): ${diagnostic}`);
  return result.stdout;
}

let verificationError: unknown;
try {
  const packedProject = join(scratch, "source");
  const consumer = join(scratch, "consumer");
  await mkdir(packedProject);
  await mkdir(consumer);
  for (const path of ["package.json", "README.md", "LICENSE", "dist", "dsh", "examples", "functions", "scripts/npm-readme.ts"]) {
    await cp(join(repository, path), join(packedProject, path), { recursive: true });
  }
  await symlink(join(repository, "node_modules"), join(packedProject, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const gitDirectory = command("git", ["rev-parse", "--absolute-git-dir"], repository).trim();
  await symlink(gitDirectory, join(packedProject, ".git"), process.platform === "win32" ? "junction" : "dir");
  const packed = command(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch], packedProject);
  const manifest = JSON.parse(packed.slice(packed.indexOf("[\n"), packed.lastIndexOf("]") + 1)) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const archive = join(scratch, manifest[0]!.filename);
  assert(manifest[0]!.files.some(file => file.path === "dist/cli/main.js"));
  assert(!manifest[0]!.files.some(file => /(?:bun\.lock|bunfig|patch-opentui)/.test(file.path)));
  const bin = await readFile(join(packedProject, "dist/cli/main.js"), "utf8");
  assert(bin.startsWith("#!/usr/bin/env node\n"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const development = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).devDependencies as Record<string, string>;
  const peers = ["@opencode-ai/plugin", "@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js", "@earendil-works/pi-coding-agent"].map(name => `${name}@${development[name]}`);
  command(process.execPath, [npmCli, "install", "--omit=optional", "--no-audit", "--no-fund", "--prefer-offline", "--foreground-scripts", "--loglevel=verbose", archive, ...peers], consumer, 300_000);
  const probe = join(consumer, "probe.mjs");
  await writeFile(probe, `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { spawn } from "node:child_process";
    import { createInterface } from "node:readline";
    import { startCodexMcpServer } from "rolebox/codex";
    const require = createRequire(import.meta.url);
    assert.equal(typeof startCodexMcpServer, "function");
    const manifest = require("rolebox/package.json");
    assert.equal(manifest.engines.node, ">=26.4.0");
    await import("rolebox");
    await import("rolebox/server");
    await import("rolebox/pi");
    await import("rolebox/dsh");
    console.log("packed ESM entries: PASS");
    const child = spawn(process.execPath, ["node_modules/rolebox/dist/cli/main.js", "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const waiting = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      const message = JSON.parse(line);
      if (waiting.has(message.id)) { waiting.get(message.id).resolve(message); waiting.delete(message.id); }
    });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic += String(chunk); });
    const exited = new Promise(resolve => child.once("close", code => {
      for (const item of waiting.values()) item.reject(new Error("Packed MCP exited: " + diagnostic));
      resolve(code);
    }));
    const deadline = setTimeout(() => {
      for (const item of waiting.values()) item.reject(new Error("Packed MCP response timed out"));
      child.kill("SIGKILL");
    }, 15_000);
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
    try {
      const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-test", version: "1" } });
      assert(initialized.result.capabilities.tools);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
      const listed = await request(2, "tools/list");
      assert(listed.result.tools.length >= 10);
      assert.deepEqual((await request(3, "ping")).result, {});
    } finally {
      child.stdin.end();
      assert.equal(await exited, 0);
      clearTimeout(deadline);
      lines.close();
    }
    console.log("packed Node MCP handshake, tool discovery and shutdown: PASS");
  `);
  process.stdout.write(command(process.execPath, [probe], consumer));
  const installedCli = join(consumer, "node_modules/rolebox/dist/cli/main.js");
  assert.match(command(process.execPath, [installedCli, "--help"], consumer), /rolebox/i);
  const typeProbe = join(consumer, "probe.ts");
  await writeFile(typeProbe, 'import tui from "rolebox/tui"; import { startCodexMcpServer } from "rolebox/codex"; import opencode from "rolebox"; import server from "rolebox/server"; import pi from "rolebox/pi"; import dsh from "rolebox/dsh"; const id: string | undefined = tui.id; void [id, startCodexMcpServer, opencode, server, pi, dsh];');
  command(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", typeProbe], consumer);
  console.log("packed consumer declarations: PASS");
  const tuiProbe = join(consumer, "tui-probe.mjs");
  await writeFile(tuiProbe, 'import assert from "node:assert/strict"; import tui from "rolebox/tui"; assert.equal(tui.id, "rolebox-tui"); console.log("packed TUI import: PASS");');
  process.stdout.write(command(process.execPath, ["--experimental-ffi", tuiProbe], consumer));
  console.log("packed Node CLI and npm install lifecycle: PASS");
} catch (error) {
  verificationError = error;
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
    throw verificationError === undefined ? error : new AggregateError([verificationError, error], "Package acceptance and cleanup failed");
  });
}
