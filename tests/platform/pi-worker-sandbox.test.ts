/**
 * The Pi graph worker boundary — the DOCUMENTED BEHAVIOUR CHANGE.
 *
 * rolebox no longer applies an OS profile of its own to a graph-worker pi child.
 * This spawn path has no host sandbox service to resolve the session's policy, so
 * rolebox stops wrapping the child and spawns the resolved pi binary directly:
 * the child's boundary is whatever the host session gives that process (see
 * docs/graph-outcome-protocol.md, "Worker execution boundary").
 *
 * The test spawns a recording stand-in for the pi CLI through the adapter's real
 * spawn path (`PI_BIN_PATH`), so it pins what the child actually receives: the
 * worker delivery grant, and no rolebox profile.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcessSessionAdapter } from "../../src/platform/adapters/pi/process-session.ts";
import { childSessionFile } from "../../src/platform/adapters/pi/child-session.ts";
import { getSystem } from "../../src/platform/system/index.ts";
import { buildGraphWorkerRolePrompt } from "../../src/prompt/graph-worker.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { MemoryConfig } from "../../src/memory/types.ts";
import type { PiWorkerToolConfig } from "../../src/platform/adapters/pi/worker-tools.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-worker-pi-"));
  roots.push(root);
  mkdirSync(join(root, ".rolebox", "pi-sessions"), { recursive: true });
  return { root };
}

async function spawnRecord(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`no spawn record was written at ${path}`);
}

describe("Pi graph worker boundary", () => {
  it("spawns the resolved pi binary itself, with the worker grant and no rolebox OS profile", async () => {
    const { root } = fixture();
    const record = join(root, "spawn-record.txt");
    // Publish the record by rename. A plain redirect creates the record file
    // BEFORE the "env | grep" subprocess writes into it, and spawnRecord() returns
    // as soon as the file exists, so the poller could read the argv0 line alone.
    // The rename is atomic within the directory: the record is absent or complete,
    // and the trailing marker makes a regression a plain completeness failure.
    //
    // The stand-in is an executable of THIS system, so the fixture exercises the
    // mechanism the adapter's spawn really has: a `#!` script with the executable
    // bit on the POSIX family, a batch file the OS runs through cmd.exe on
    // Windows. Both record the same four facts.
    const system = getSystem();
    const binary = join(root, system.id === "win32" ? "fake-pi.cmd" : "fake-pi");
    if (system.id === "win32") {
      writeFileSync(binary, [
        "@echo off",
        'set "ARGV0=%~f0"',
        ":scan",
        'if "%~1"=="" goto record',
        'if "%~1"=="--append-system-prompt" type "%~2" > "%PI_SPAWN_RECORD%.prompt"',
        "shift",
        "goto scan",
        ":record",
        "(",
        "echo argv0=%ARGV0%",
        "set ROLEBOX_GRAPH_WORKER_",
        "echo record-complete",
        ') > "%PI_SPAWN_RECORD%.tmp"',
        'move /y "%PI_SPAWN_RECORD%.tmp" "%PI_SPAWN_RECORD%" >nul',
        "",
      ].join("\r\n"));
    } else {
      writeFileSync(binary, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "--append-system-prompt" ]; then cat "$2" > "$PI_SPAWN_RECORD.prompt"; fi\nshift\ndone\n{ printf "argv0=%s\\n" "$0"; env | grep "^ROLEBOX_GRAPH_WORKER_"; printf "record-complete\\n"; } > "$PI_SPAWN_RECORD.tmp"\nmv "$PI_SPAWN_RECORD.tmp" "$PI_SPAWN_RECORD"\nexit 0\n');
      chmodSync(binary, 0o755);
    }
    const previousBinary = process.env.PI_BIN_PATH;
    const previousRecord = process.env.PI_SPAWN_RECORD;
    process.env.PI_BIN_PATH = binary;
    process.env.PI_SPAWN_RECORD = record;
    // The adapter resolves its child session file against process.cwd(); run the
    // spawn from the fixture root so nothing is written into the checkout.
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const adapter = new PiProcessSessionAdapter();
      adapter.registerAgentConfig("worker", {
        model: "example/model", tools: [], systemPrompt: "Ordinary agent context",
        graphWorkerSystemPrompt: buildGraphWorkerRolePrompt({
          id: "worker", config: { name: "Worker", description: "Worker", prompt: "Worker assignment", auto_activate: ["active"] },
          prompt: "Unused rendered context", subagents: [], skills: [], references: [],
          functions: ["active", "inactive"].map(name => ({
            name, description: name, content: `${name} function instructions`,
            filePath: `${name}.md`, source: "role-local" as const,
          })),
        }),
      });
      adapter.setGraphWorkerChannel(() => ({ endpoint: "http://127.0.0.1:9/worker", token: "attempt-token",
        routeFile: join(root, "route.json") }));
      const info = await adapter.create({ directory: root, agent: "worker" });
      if (!info) throw new Error("the adapter did not create a session");
      await adapter.runGraphWorker(() => adapter.prompt(info.id, { parts: [{ type: "text", text: "Task: fixture" }] }));
      const output = await spawnRecord(record);
      // The child's argv[0] is the resolved fixture binary itself. Compared as
      // the file it names: cmd may quote %0, and Windows may report a short
      // (8.3) or differently-cased spelling of the same path.
      const argv0 = (output.split(/\r?\n/).find(line => line.startsWith("argv0=")) ?? "").slice("argv0=".length);
      expect(realpathSync(argv0.replace(/^"|"$/g, ""))).toBe(realpathSync(binary));
      expect(output).not.toContain("sandbox-exec");
      expect(output).toContain("ROLEBOX_GRAPH_WORKER_ENDPOINT=http://127.0.0.1:9/worker");
      expect(output).toContain("ROLEBOX_GRAPH_WORKER_TOKEN=attempt-token");
      expect(output).toContain("record-complete");
      const prompt = readFileSync(record + ".prompt", "utf8");
      expect(prompt).toContain("Worker assignment");
      expect(prompt).toContain("active function instructions");
      expect(prompt).not.toContain("inactive function instructions");
      expect(prompt).not.toContain("Ordinary agent context");

      const ordinary = await adapter.create({ directory: root, agent: "worker" });
      if (!ordinary) throw new Error("the adapter did not create an ordinary session");
      process.env.PI_SPAWN_RECORD = join(root, "ordinary-record.txt");
      await adapter.prompt(ordinary.id, { parts: [{ type: "text", text: "Ordinary task" }] });
      await spawnRecord(process.env.PI_SPAWN_RECORD);
      expect(readFileSync(process.env.PI_SPAWN_RECORD + ".prompt", "utf8")).toBe("Ordinary agent context");

      const store = await MemoryStore.create(root);
      try {
        for (const [scope, roleId, title] of [
          ["role", "memory-worker", "Worker remembered decision"],
          ["workspace", "shared", "Workspace remembered decision"],
          ["role", "other-worker", "Other worker private decision"],
        ]) {
          store.write({ scope, role_id: roleId, title, content: title, category: "fact", relevance: "high", tags: [], session_id: null, source_sessions: [] });
        }
      } finally {
        store.close();
      }
      const cases: Array<{ name: string; tools: string[]; config?: MemoryConfig; presentation?: PiWorkerToolConfig["presentation"] }> = [
        { name: "ungranted", tools: [] },
        { name: "read", tools: ["memory_recall", "memory_read"] },
        { name: "write", tools: ["memory_write"] },
        { name: "disabled", tools: ["memory_recall"], config: { inject: false } },
        { name: "discover", tools: ["memory_recall"], presentation: { mode: "discover" } },
      ];
      for (const item of cases) {
        adapter.registerAgentConfig("memory-worker", {
          model: "example/model", tools: [], systemPrompt: "Worker context", memory: item.config,
        });
        adapter.setGraphWorkerToolConfig(() => ({
          baseline: ["bash", "graph_submit_outcome"], grants: item.tools, presentation: item.presentation,
          proxies: ["memory_recall", "memory_read", "memory_write", "memory_update"].map(name => ({ name, description: name, inputSchema: {} })),
        }));
        const worker = await adapter.create({ directory: root, agent: "memory-worker" });
        if (!worker) throw new Error("the adapter did not create a memory worker");
        process.env.PI_SPAWN_RECORD = join(root, `memory-${item.name}.txt`);
        await adapter.runGraphWorker(() => adapter.prompt(worker.id, {
          agent: "memory-worker", parts: [{ type: "text", text: "Memory task" }],
        }));
        await spawnRecord(process.env.PI_SPAWN_RECORD);
        const workerPrompt = readFileSync(process.env.PI_SPAWN_RECORD + ".prompt", "utf8");
        expect(workerPrompt).not.toContain("Other worker private decision");
        expect(workerPrompt).not.toContain("memory_update");
        if (item.name === "ungranted") {
          expect(workerPrompt).not.toContain("## Memory workflow");
          expect(workerPrompt).not.toContain("## Available memory");
        } else {
          expect(workerPrompt).toContain("## Memory workflow");
          if (item.name === "read" || item.name === "discover") {
            expect(workerPrompt).toContain("Worker remembered decision");
            expect(workerPrompt).toContain("Workspace remembered decision");
          } else {
            expect(workerPrompt).not.toContain("## Available memory");
          }
          if (item.name === "write") expect(workerPrompt).not.toContain("memory_recall");
          if (item.name === "discover") {
            expect(workerPrompt).toContain("graph_worker_tools");
            expect(workerPrompt).not.toContain('action="call"');
          }
        }
      }

      const computerCases = [
        { name: "ungranted", grants: [], proxies: ["computer_screenshot"] },
        { name: "unregistered", grants: ["computer_screenshot"], proxies: [] },
        { name: "denied", grants: ["computer_screenshot"], proxies: ["computer_screenshot"], policy: { computer_screenshot: false } },
        { name: "observe", grants: ["computer_screenshot"], proxies: ["computer_screenshot", "computer_click"] },
        { name: "discover", grants: ["computer_screenshot", "computer_permissions"], proxies: ["computer_screenshot", "computer_permissions"], presentation: { mode: "discover" as const } },
      ];
      for (const item of computerCases) {
        adapter.registerAgentConfig("computer-worker", {
          model: "example/model", tools: [], systemPrompt: "Computer worker context",
          toolPolicy: item.policy ?? { "computer_*": true },
        });
        adapter.setGraphWorkerToolConfig(() => ({
          baseline: ["bash", "graph_submit_outcome"], grants: item.grants, presentation: item.presentation,
          proxies: item.proxies.map(name => ({ name, description: name, inputSchema: {} })),
        }));
        const worker = await adapter.create({ directory: root, agent: "computer-worker" });
        if (!worker) throw new Error("the adapter did not create a computer worker");
        process.env.PI_SPAWN_RECORD = join(root, `computer-${item.name}.txt`);
        await adapter.runGraphWorker(() => adapter.prompt(worker.id, {
          agent: "computer-worker", parts: [{ type: "text", text: "Desktop task" }],
        }));
        await spawnRecord(process.env.PI_SPAWN_RECORD);
        const workerPrompt = readFileSync(process.env.PI_SPAWN_RECORD + ".prompt", "utf8");
        if (item.name === "observe" || item.name === "discover") {
          expect(workerPrompt).toContain("## Computer use workflow");
          expect(workerPrompt).not.toContain("computer_click");
          if (item.name === "discover") {
            expect(workerPrompt).toContain("computer_permissions(request=true)");
            expect(workerPrompt).toContain("native tool only after describe");
            expect(workerPrompt).not.toContain('action="call"');
          }
        } else {
          expect(workerPrompt).not.toContain("## Computer use workflow");
        }
      }
    } finally {
      process.chdir(previousCwd);
      if (previousBinary === undefined) delete process.env.PI_BIN_PATH; else process.env.PI_BIN_PATH = previousBinary;
      if (previousRecord === undefined) delete process.env.PI_SPAWN_RECORD; else process.env.PI_SPAWN_RECORD = previousRecord;
    }
  }, 20_000);

  it("creates the native SDK session with the identity dispatch records and rejects replacement", async () => {
    const { root } = fixture();
    const path = await childSessionFile(root, "fixture-session");
    expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("fixture-session");
    expect(await childSessionFile(root, "fixture-session")).toBe(path);
    const header = JSON.parse(readFileSync(path, "utf8")); header.id = "replacement";
    writeFileSync(path, JSON.stringify(header) + "\n");
    expect(childSessionFile(root, "fixture-session")).rejects.toThrow("identity mismatch");
  });
});
