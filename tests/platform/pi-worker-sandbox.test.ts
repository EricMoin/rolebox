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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcessSessionAdapter } from "../../src/platform/adapters/pi/process-session.ts";
import { childSessionFile } from "../../src/platform/adapters/pi/child-session.ts";

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
    const binary = join(root, "fake-pi");
    writeFileSync(binary, '#!/bin/sh\n{ printf "argv0=%s\\n" "$0"; env | grep "^ROLEBOX_GRAPH_WORKER_"; } > "$PI_SPAWN_RECORD"\nexit 0\n');
    chmodSync(binary, 0o755);
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
      expect(output).toContain(`argv0=${binary}`);
      expect(output).not.toContain("sandbox-exec");
      expect(output).toContain("ROLEBOX_GRAPH_WORKER_ENDPOINT=http://127.0.0.1:9/worker");
      expect(output).toContain("ROLEBOX_GRAPH_WORKER_TOKEN=attempt-token");
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
