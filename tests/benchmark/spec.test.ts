import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { loadBenchmarkSuite } from "../../src/benchmark/spec.ts";
import type { BenchmarkCase } from "../../src/benchmark/types.ts";

let directory: string;
let source: Record<string, any>;
const exampleCase: BenchmarkCase = { id: "one", prompt: "Say hello", assertions: [{ kind: "equals", value: "hello" }] };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rolebox-benchmark-spec-"));
  await mkdir(join(directory, "role"));
  await writeFile(join(directory, "role", "role.yaml"), "name: Example\ndescription: Example role\n");
  source = { schemaVersion: 1, id: "example", target: { host: "dsh", role: "role", provider: "example-provider", model: "model-name" } };
  await writeFile(join(directory, "cases.jsonl"), JSON.stringify(exampleCase) + "\n");
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function save(): Promise<void> {
  await writeFile(join(directory, "suite.yaml"), dump(source));
}

describe("benchmark suite validation", () => {
  it("loads a directory or YAML path and supplies explicit execution defaults", async () => {
    await save();
    const loaded = await loadBenchmarkSuite(directory);
    expect(loaded.roleDirectory).toBe(join(directory, "role"));
    expect(loaded.cases).toEqual([exampleCase]);
    expect(loaded.suite.run).toEqual({ repetitions: 1, concurrency: 1, timeoutMs: 120_000 });
    expect(loaded.suite.host).toEqual({ plugins: [], env: [] });
    expect((await loadBenchmarkSuite(join(directory, "suite.yaml"))).digest).toBe(loaded.digest);
  });

  it("rejects unsupported versions, fields and execution limits", async () => {
    for (const changed of [
      { schemaVersion: 2 }, { unknown: true }, { run: { concurrency: 0 } },
      { run: { timeoutMs: 99 } }, { run: { repetitions: 1.5 } },
      { target: { ...source.target, host: "other" } },
      { host: { plugins: [], unexpected: true } },
    ]) {
      const original = source;
      source = { ...source, ...changed };
      await save();
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("invalid or unsupported fields");
      source = original;
    }
  });

  it("requires a real role file and a nonempty JSONL dataset", async () => {
    await save();
    await writeFile(join(directory, "cases.jsonl"), "\n \n");
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("at least one case");
    await rm(join(directory, "role", "role.yaml"));
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("Target role.yaml could not be read");
  });

  it("rejects duplicate case IDs and locates malformed JSON without printing it", async () => {
    await save();
    await writeFile(join(directory, "cases.jsonl"), `${JSON.stringify(exampleCase)}\n${JSON.stringify(exampleCase)}\n`);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("Case line 2 has a duplicate ID");
    await writeFile(join(directory, "cases.jsonl"), `${JSON.stringify(exampleCase)}\nnot-json-sensitive-fixture`);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("Case line 2 is not valid JSON");
  });

  it("rejects vacuous, unsupported or oversized assertions and prompts", async () => {
    await save();
    for (const changed of [
      { assertions: [] },
      { assertions: [{ kind: "contains", value: "" }] },
      { assertions: [{ kind: "matches", value: "hello" }] },
      { assertions: [{ kind: "equals", value: "a".repeat(16_385) }] },
      { prompt: " " },
      { prompt: "a".repeat(131_073) },
    ]) {
      await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, ...changed }));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("Case line 1");
    }
  });

  it("accepts an exact empty-output assertion", async () => {
    await save();
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, assertions: [{ kind: "equals", value: "" }] }));
    expect((await loadBenchmarkSuite(directory)).cases[0]!.assertions[0]).toEqual({ kind: "equals", value: "" });
  });

  it("resolves module locations and keeps credential references unresolved", async () => {
    await mkdir(join(directory, "host"));
    await writeFile(join(directory, "plugin.ts"), "export default {};");
    source.host = { moduleRoot: "host", env: ["EXAMPLE_API_KEY"], plugins: [{ module: "./plugin.ts", config: { apiKey: { $env: "EXAMPLE_API_KEY" }, nested: [{ headers: { Authorization: { $env: "EXAMPLE_API_KEY" } } }] } }] };
    await save();
    const loaded = await loadBenchmarkSuite(directory);
    expect(loaded.suite.host.moduleRoot).toBe(join(directory, "host"));
    expect(loaded.suite.host.plugins[0]!.module).toBe(join(directory, "plugin.ts"));
    expect(loaded.suite.host.plugins[0]!.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.suite.host.plugins[0]!.config.apiKey).toEqual({ $env: "EXAMPLE_API_KEY" });
    await writeFile(join(directory, "plugin.ts"), "export default { changed: true };");
    const changed = await loadBenchmarkSuite(directory);
    expect(changed.suite.host.plugins[0]!.sourceDigest).not.toBe(loaded.suite.host.plugins[0]!.sourceDigest);
    expect(changed.digest).not.toBe(loaded.digest);
  });

  it("refuses inline credentials, undeclared environment references, and credentials in URLs", async () => {
    for (const config of [
      { api_key: "secret-fixture" }, { apiToken: "secret-fixture" }, { nested: { password: "secret-fixture" } },
      { headers: { authorization: "secret-fixture" } },
      { token: { $env: "EXAMPLE_API_KEY" } },
      { apiKey: { $env: "EXAMPLE_API_KEY", fallback: "secret-fixture" } },
      { endpoint: "https://example.com/?api_key=secret-fixture" },
      { endpoint: "https://user:secret-fixture@example.com/" },
    ]) {
      source.host = { plugins: [{ module: "example-plugin", config }] };
      await save();
      try { await loadBenchmarkSuite(directory); throw new Error("Accepted invalid config"); }
      catch (error) {
        expect(String(error)).not.toContain("secret-fixture");
        expect(String(error)).not.toContain("Accepted invalid config");
      }
    }
  });

  it("rejects environment overrides of isolation and runtime loading", async () => {
    for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME", "DSH_HOME", "ROLEBOX_LOG_FILE", "NODE_OPTIONS", "NODE_PATH", "BUN_INSTALL", "DYLD_INSERT_LIBRARIES"]) {
      source.host = { env: [name] };
      await save();
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("isolation variables");
    }
    source.host = { env: ["EXAMPLE_API_KEY", "EXAMPLE_API_KEY"] };
    await save();
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("duplicate names");
  });

  it("rejects recursive YAML aliases instead of recursing forever", async () => {
    await save();
    await writeFile(join(directory, "suite.yaml"), dump(source) + "host:\n  plugins:\n    - module: example-plugin\n      config: &config\n        nested: *config\n");
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("cyclic aliases");
  });

  it("hashes semantic settings and cases independently of YAML formatting and source location", async () => {
    source.host = { plugins: [{ module: "example-plugin", config: { second: 2, first: 1 } }], env: ["EXAMPLE_B", "EXAMPLE_A"] };
    await save();
    const initial = await loadBenchmarkSuite(directory);
    source.host = { env: ["EXAMPLE_A", "EXAMPLE_B"], plugins: [{ config: { first: 1, second: 2 }, module: "example-plugin" }] };
    await save();
    expect((await loadBenchmarkSuite(directory)).digest).toBe(initial.digest);
    await mkdir(join(directory, "copied"));
    source.target.role = "../role";
    source.dataset = "../cases.jsonl";
    await writeFile(join(directory, "copied", "suite.yaml"), dump(source));
    expect((await loadBenchmarkSuite(join(directory, "copied"))).digest).toBe(initial.digest);
    source.run = { repetitions: 2 };
    await save();
    source.target.role = "role";
    source.dataset = "cases.jsonl";
    await save();
    expect((await loadBenchmarkSuite(directory)).digest).not.toBe(initial.digest);
  });

  it("freezes workspace fixtures and checks, supplies command defaults and fingerprints source edits", async () => {
    await mkdir(join(directory, "fixture"));
    await mkdir(join(directory, "checks"));
    await writeFile(join(directory, "fixture", "sum.ts"), "export const sum = () => 0;\n");
    await writeFile(join(directory, "checks", "test.ts"), "throw new Error('test fixture');\n");
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({
      ...exampleCase, workspace: { fixture: "./fixture", checks: "./checks" },
      assertions: [{ kind: "file_exists", path: "sum.ts" }, { kind: "command", argv: ["node", "{checks}/test.ts", "{workspace}"] }],
    }));
    await save();
    const initial = await loadBenchmarkSuite(directory);
    expect(initial.cases[0]!.workspace).toEqual({ fixture: "./fixture", checks: "./checks" });
    expect(initial.cases[0]!.assertions[1]).toEqual({ kind: "command", argv: ["node", "{checks}/test.ts", "{workspace}"], timeoutMs: 10_000, expectedExitCode: 0 });
    expect(initial.workspaces?.one?.fixture.files[0]!.content).toBe(Buffer.from("export const sum = () => 0;\n").toString("base64"));
    expect(initial.workspaces?.one?.checks?.files[0]!.path).toBe("test.ts");
    await writeFile(join(directory, "fixture", "sum.ts"), "export const sum = () => 1;\n");
    const edited = await loadBenchmarkSuite(directory);
    expect(edited.digest).not.toBe(initial.digest);
    expect(edited.workspaces?.one?.fixture.digest).not.toBe(initial.workspaces?.one?.fixture.digest);
    await writeFile(join(directory, "checks", "test.ts"), "throw new Error('changed fixture');\n");
    expect((await loadBenchmarkSuite(directory)).digest).not.toBe(edited.digest);
    const beforeMode = await loadBenchmarkSuite(directory);
    await chmod(join(directory, "fixture", "sum.ts"), 0o700);
    const afterMode = await loadBenchmarkSuite(directory);
    if (process.platform === "win32") expect(afterMode.digest).toBe(beforeMode.digest);
    else expect(afterMode.digest).not.toBe(beforeMode.digest);
  });

  it("hashes workspace contents independently of fixture and checks directory names", async () => {
    for (const name of ["fixture-a", "fixture-b", "checks-a", "checks-b"]) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "file.txt"), "same content");
    }
    await save();
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture-a", checks: "checks-a" } }));
    const initial = await loadBenchmarkSuite(directory);
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture-b", checks: "checks-b" } }));
    expect((await loadBenchmarkSuite(directory)).digest).toBe(initial.digest);
  });

  it("counts repeated fixture and checks references against the aggregate suite budget", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    await writeFile(join(directory, "fixture", "file"), Buffer.alloc(1_048_576));
    async function cases(count: number, checks: boolean): Promise<void> {
      const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
        ...exampleCase, id: `case-${index}`, workspace: { fixture: "fixture", ...(checks ? { checks: "fixture" } : {}) },
      }));
      await writeFile(join(directory, "cases.jsonl"), lines.join("\n"));
    }
    await cases(64, false);
    expect((await loadBenchmarkSuite(directory)).cases).toHaveLength(64);
    await cases(65, false);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("64 MiB suite budget");
    await cases(32, true);
    expect((await loadBenchmarkSuite(directory)).cases).toHaveLength(32);
    await cases(33, true);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("64 MiB suite budget");
  });

  it("bounds the aggregate file count even for repeatedly referenced empty files", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    for (let index = 0; index < 100; index++) await writeFile(join(directory, "fixture", `file-${index}`), "");
    async function cases(count: number, checks: boolean): Promise<void> {
      await writeFile(join(directory, "cases.jsonl"), Array.from({ length: count }, (_, index) => JSON.stringify({
        ...exampleCase, id: `case-${index}`, workspace: { fixture: "fixture", ...(checks ? { checks: "fixture" } : {}) },
      })).join("\n"));
    }
    await cases(500, false);
    expect((await loadBenchmarkSuite(directory)).cases).toHaveLength(500);
    await cases(501, false);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("50000-file suite budget");
    await cases(250, true);
    expect((await loadBenchmarkSuite(directory)).cases).toHaveLength(250);
    await cases(251, true);
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("50000-file suite budget");
  });

  it("rejects escaping workspace paths, symlink ancestors and unsupported workspace fields", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    await mkdir(join(directory, "fixture", "nested"));
    await symlink(join(directory, "fixture"), join(directory, "linked"));
    for (const workspace of [
      { fixture: "../outside" }, { fixture: "/absolute" }, { fixture: "a/../fixture" },
      { fixture: "linked/nested" }, { fixture: "linked" }, { fixture: "fixture", unknown: true },
      { fixture: "fixture", checks: "../outside" }, { fixture: "missing" },
    ]) {
      await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace }));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow();
    }
  });

  it("requires workspace inputs and explicit checks for new assertions", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    for (const assertions of [
      [{ kind: "file_exists", path: "output.txt" }],
      [{ kind: "file_equals", path: "output.txt", value: "expected" }],
      [{ kind: "file_contains", path: "output.txt", value: "expected" }],
      [{ kind: "command", argv: ["node", "test"] }],
    ]) {
      await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, assertions }));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("requires a workspace");
    }
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture" }, assertions: [{ kind: "command", argv: ["node", "{checks}/test.ts"] }] }));
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("requires workspace.checks");
  });

  it("reserves the top-level runtime namespace in fixtures, checks and file assertions", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    await mkdir(join(directory, "checks"));
    await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture", checks: "checks" } }));
    for (const location of ["fixture", "checks"]) {
      await mkdir(join(directory, location, ".rolebox"));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("reserved .rolebox runtime state");
      await rm(join(directory, location, ".rolebox"), { recursive: true });
    }
    for (const path of [".rolebox", ".rolebox/state/active.json", ".Rolebox/state.json"]) {
      await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture" }, assertions: [{ kind: "file_exists", path }] }));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("invalid or unsupported fields");
    }
  });

  it("strictly validates file and command assertions without accepting shell configuration", async () => {
    await save();
    await mkdir(join(directory, "fixture"));
    for (const assertion of [
      { kind: "file_exists", path: "../outside" }, { kind: "file_exists", path: "file", value: "extra" },
      { kind: "file_contains", path: "file", value: "" }, { kind: "file_equals", path: "file", value: "\ud800" },
      { kind: "command", argv: [] }, { kind: "command", argv: [""] }, { kind: "command", argv: [" "] },
      { kind: "command", argv: Array.from({ length: 65 }, () => "arg") },
      { kind: "command", argv: ["node", "a\0b"] }, { kind: "command", argv: ["node", "\ud800"] },
      { kind: "command", argv: ["node"], timeoutMs: 99 }, { kind: "command", argv: ["node"], timeoutMs: 60_001 },
      { kind: "command", argv: ["node"], expectedExitCode: -1 }, { kind: "command", argv: ["node"], expectedExitCode: 256 },
      { kind: "command", argv: ["node"], shell: true }, { kind: "command", command: "npm test" },
    ]) {
      await writeFile(join(directory, "cases.jsonl"), JSON.stringify({ ...exampleCase, workspace: { fixture: "fixture" }, assertions: [assertion] }));
      await expect(loadBenchmarkSuite(directory)).rejects.toThrow("invalid or unsupported fields");
    }
  });

  it("rejects invalid UTF-8 rather than silently changing input contents", async () => {
    await save();
    await writeFile(join(directory, "cases.jsonl"), Buffer.from([0xff]));
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("valid UTF-8");
    await writeFile(join(directory, "suite.yaml"), Buffer.from([0xff]));
    await expect(loadBenchmarkSuite(directory)).rejects.toThrow("valid UTF-8");
  });
});
