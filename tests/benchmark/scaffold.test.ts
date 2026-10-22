import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldBenchmark } from "../../src/benchmark/scaffold.ts";
import { loadBenchmarkSuite } from "../../src/benchmark/spec.ts";

let directory: string;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rolebox-benchmark-scaffold-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("benchmark scaffolding", () => {
  it("preserves the default response template and refuses to overwrite a suite", async () => {
    const suite = join(directory, "response-quality");
    expect(await scaffoldBenchmark(suite)).toBe(suite);
    const loaded = await loadBenchmarkSuite(suite);
    expect(loaded.cases.map(value => value.id)).toEqual(["literal", "arithmetic", "format"]);
    expect(loaded.cases.every(value => value.workspace === undefined)).toBe(true);
    expect(loaded.suite.target.provider).toBe("example-provider");
    const original = await readFile(join(suite, "cases.jsonl"), "utf8");
    await expect(scaffoldBenchmark(suite, "code-fix")).rejects.toThrow();
    expect(await readFile(join(suite, "cases.jsonl"), "utf8")).toBe(original);
    expect((await readdir(suite)).sort()).toEqual(["README.md", "cases.jsonl", "role", "suite.yaml"]);
  });

  it("creates a validated code repair case with external checks that detect the real bug", async () => {
    const suite = await scaffoldBenchmark(join(directory, "code-quality"), "code-fix");
    const loaded = await loadBenchmarkSuite(suite);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]!.workspace).toEqual({ fixture: "./fixtures/sum", checks: "./checks/sum" });
    expect(loaded.cases[0]!.assertions).toEqual([
      { kind: "file_exists", path: "src/sum.mjs" },
      { kind: "command", argv: ["bun", "{checks}/check.mjs", "{workspace}"], timeoutMs: 10_000, expectedExitCode: 0 },
    ]);
    expect(await readdir(join(suite, "fixtures", "sum"))).toEqual(["src"]);
    expect(await readFile(join(suite, "role", "role.yaml"), "utf8")).toContain("Change the actual files");
    const fixture = join(suite, "fixtures", "sum");
    const check = join(suite, "checks", "sum", "check.mjs");
    const failing = Bun.spawn([process.execPath, check, fixture], { stdout: "pipe", stderr: "pipe" });
    expect(await failing.exited).not.toBe(0);
    expect(await new Response(failing.stderr).text()).toContain("empty");

    const repaired = join(directory, "repaired");
    await cp(fixture, repaired, { recursive: true });
    await writeFile(join(repaired, "src", "sum.mjs"), "export function sum() { return 0; }\n");
    const wrong = Bun.spawn([process.execPath, check, repaired], { stdout: "pipe", stderr: "pipe" });
    expect(await wrong.exited).not.toBe(0);
    expect(await new Response(wrong.stderr).text()).toContain("AssertionError");
    await writeFile(join(repaired, "src", "sum.mjs"), "export function sum(values) { return values.reduce((total, value) => total + value, 0); }\n");
    const passing = Bun.spawn([process.execPath, check, repaired], { stdout: "pipe", stderr: "pipe" });
    expect(await passing.exited).toBe(0);
    expect(await new Response(passing.stdout).text()).toContain("All sum checks passed");
    expect(await readFile(join(fixture, "src", "sum.mjs"), "utf8")).not.toContain(", 0)");
  });
});
