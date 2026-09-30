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
        "(",
        "echo argv0=%0",
        "set ROLEBOX_GRAPH_WORKER_",
        "echo record-complete",
        ') > "%PI_SPAWN_RECORD%.tmp"',
        'move /y "%PI_SPAWN_RECORD%.tmp" "%PI_SPAWN_RECORD%" >nul',
        "",
      ].join("\r\n"));
    } else {
      writeFileSync(binary, '#!/bin/sh\n{ printf "argv0=%s\\n" "$0"; env | grep "^ROLEBOX_GRAPH_WORKER_"; printf "record-complete\\n"; } > "$PI_SPAWN_RECORD.tmp"\nmv "$PI_SPAWN_RECORD.tmp" "$PI_SPAWN_RECORD"\nexit 0\n');
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
      adapter.setGraphWorkerChannel(() => ({ endpoint: "http://127.0.0.1:9/worker", token: "attempt-token",
        routeFile: join(root, "route.json") }));
      const info = await adapter.create({ directory: root });
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
