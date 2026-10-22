import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorDshRuntime, resolveDshRuntime } from "../../src/benchmark/hosts/dsh.ts";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "../../src/benchmark/types.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";
import { graphStoreRoot } from "../../src/graph/store/schema.ts";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const available = doctorDshRuntime().available;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function execute(mode: string, options: { model?: string; config?: Record<string, unknown>; allowedEnv?: string[]; sourceDigest?: string } = {}): Promise<BenchmarkWorkerResult> {
  const root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-dsh-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const rolesDirectory = join(root, "roles");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(rolesDirectory, "fixture"), { recursive: true });
  await mkdir(join(rolesDirectory, "fixture", "skills", "fixture-note"), { recursive: true });
  await writeFile(join(rolesDirectory, "fixture", "skills", "fixture-note", "SKILL.md"),
    "---\nname: fixture-note\ndescription: A benchmark instruction fixture.\n---\nNATIVE_SKILL_LOADED\n");
  await writeFile(join(rolesDirectory, "fixture", "role.yaml"), [
    "name: Fixture", "description: Isolated benchmark fixture", "prompt: Follow the isolated benchmark role.",
    `model: example-provider/${options.model ?? "scripted"}`, "",
    "skills: [fixture-note]",
    "subagents:", "  - name: Worker", "    description: Isolated fixture worker",
    "    prompt: Complete the assigned graph fixture.", "    model: example-provider/scripted", "",
  ].join("\n"));
  const request: BenchmarkWorkerRequest = {
    protocolVersion: 1, workspace, rolesDirectory, roleId: "fixture", provider: "example-provider", model: "scripted",
    host: { plugins: [{ module: join(fixtures, "scripted-dsh-provider.mjs"), sourceDigest: options.sourceDigest, config: {
      runtimeAnchor: resolveDshRuntime().anchor, mode, ...options.config,
    } }], env: options.allowedEnv ?? [] },
    prompt: "Complete the task.", timeoutMs: mode.includes("timeout") ? 100 : 5_000,
  };
  const requestPath = join(root, "request.json");
  const resultPath = join(root, "result.json");
  await writeFile(requestPath, JSON.stringify(request));
  const process = Bun.spawn([Bun.which("bun")!, resolve("src/benchmark/hosts/dsh-worker.ts"), requestPath, resultPath], {
    cwd: workspace,
    env: { PATH: globalThis.process.env.PATH, HOME: root, ROLEBOX_DATA_DIR: join(root, "data"),
      ROLEBOX_CONFIG_DIR: join(root, "config"), ROLEBOX_ENGINE_RECOVERY: "off", ROLEBOX_LOG_LEVEL: "fatal" },
    stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(process.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([process.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { process.kill(); reject(new Error("Worker fixture exceeded its outer deadline.")); }, 15_000);
    })]);
    expect(await stderr).not.toContain("Unhandled");
    if (mode.startsWith("child-")) expect(JSON.parse(await readFile(join(workspace, "child-stopped.json"), "utf8"))).toEqual({ stopped: true });
    if (mode === "graph") {
      const graphs = queryGraphs(graphStoreRoot(join(root, "data"), workspace));
      expect(graphs.blocked).toBeUndefined();
      expect(graphs.graphs).toHaveLength(1);
      expect(graphs.graphs[0]?.phase).toBe("complete");
      expect(graphs.graphs[0]?.current?.attempts).toHaveLength(2);
    }
    return JSON.parse(await readFile(resultPath, "utf8")) as BenchmarkWorkerResult;
  } finally { clearTimeout(timer); }
}

describe("dsh benchmark runtime resolution", () => {
  it("reports missing runtimes without importing their plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "rolebox-no-dsh-"));
    temporaryRoots.push(root);
    const report = doctorDshRuntime(root);
    expect(report.available).toBe(false);
    expect(report.diagnostic).not.toContain(root);
  });

  it("checks release coherence and activation declarations without executing package code", async () => {
    const root = await mkdtemp(join(tmpdir(), "rolebox-static-dsh-"));
    temporaryRoots.push(root);
    const packageInfo = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(packageInfo.devDependencies).filter(([name]) => name.startsWith("@deepseek-ai/"))) {
      const directory = join(root, "node_modules", name);
      await mkdir(join(directory, "lib", "types"), { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, main: "lib/index.js" }));
      await writeFile(join(directory, "lib", "index.js"), 'throw new Error("Doctor must never import a plugin");');
    }
    const subagentTypes = join(root, "node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts");
    await writeFile(subagentTypes, "declare class SubagentService { start(): void }");
    expect(doctorDshRuntime(root)).toMatchObject({ available: false, diagnostic: expect.stringContaining("activation API") });
    await writeFile(subagentTypes, "declare class SubagentService { startActivation(): void }");
    expect(doctorDshRuntime(root).available).toBe(true);
    expect(doctorDshRuntime(root, true).available).toBe(true);
    await writeFile(join(root, "node_modules/@deepseek-ai/dsh-tool-fs/package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-tool-fs", version: "0.0.1", main: "lib/index.js" }));
    expect(doctorDshRuntime(root, true)).toMatchObject({ available: false, diagnostic: expect.stringContaining("Workspace tools") });
    expect(doctorDshRuntime(root).available).toBe(true);
    await writeFile(join(root, "node_modules/@deepseek-ai/dsh-llm/package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-llm", version: "0.0.1", main: "lib/index.js" }));
    expect(doctorDshRuntime(root)).toMatchObject({ available: false, diagnostic: expect.stringContaining("release versions") });
  });
});

describe.skipIf(!available)("dsh benchmark with a real host and scripted provider (requires installed dsh runtime)", () => {
  it("activates the primary role and observes its actual route, prompt, usage and terminal event", async () => {
    const result = await execute("success");
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.output).toBe("fixture complete");
    expect(result.activation).toMatchObject({ roleId: "fixture", provider: "example-provider", model: "scripted" });
    expect(result.activation?.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: null, source: "host" });
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("keeps absent token accounting unknown", async () => {
    const result = await execute("missing-usage");
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" });
  }, 20_000);

  it("includes descendant requests in usage and disposes their handles", async () => {
    const result = await execute("child-success");
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, costUsd: null, source: "host" });
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("waits for a real two-node graph and the parent's completion followup", async () => {
    const result = await execute("graph");
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.output).toBe("fixture complete");
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(50);
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("loads a role's named skill through the real native skill tool", async () => {
    const result = await execute("skill");
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.output).toBe("NATIVE_SKILL_LOADED");
    expect(result.usage.inputTokens).toBe(20);
  }, 20_000);

  it("does not report success when a real native loop ends in an error", async () => {
    const result = await execute("loop");
    expect(result.status, result.diagnostic).toBe("infra_error");
    expect(result.diagnostic).toContain("native dsh loop");
    expect(result.diagnostic).toContain("error");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("rejects a conflicting role model before making a model request", async () => {
    const result = await execute("success", { model: "different-model" });
    expect(result.status).toBe("invalid");
    expect(result.activation).toBeUndefined();
    expect(result.diagnostic).toContain("conflicts");
  }, 20_000);

  it("does not confuse idle after a failed request with completion", async () => {
    const result = await execute("failure");
    expect(result.status).toBe("infra_error");
    expect(result.diagnostic).toContain("error");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("records the model's output limit as a task failure", async () => {
    const result = await execute("max-tokens");
    expect(result.status, result.diagnostic).toBe("task_failure");
    expect(result.output).toBe("fixture complete");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("cancels and drains the real agent on timeout", async () => {
    const result = await execute("timeout");
    expect(result.status).toBe("task_timeout");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("cancels active descendants and drains their owned handles", async () => {
    const result = await execute("child-timeout");
    expect(result.status).toBe("task_timeout");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("rejects environment references outside the explicit allowlist", async () => {
    const result = await execute("success", { config: { response: { $env: "BENCHMARK_FIXTURE_SECRET" } } });
    expect(result.status).toBe("invalid");
    expect(result.diagnostic).toContain("host.env");
  }, 20_000);

  it("rejects a changed plugin entry before activating a role or calling a model", async () => {
    const result = await execute("success", { sourceDigest: "0".repeat(64) });
    expect(result.status).toBe("invalid");
    expect(result.diagnostic).toContain("source snapshot");
    expect(result.activation).toBeUndefined();
    expect(result.output).toBe("");
    expect(result.usage.source).toBe("unavailable");
    expect(result.terminationConfirmed).toBe(true);
  }, 20_000);

  it("loads an unchanged plugin entry with a matching source digest", async () => {
    const source = await readFile(join(fixtures, "scripted-dsh-provider.mjs"), "utf8");
    const result = await execute("success", { sourceDigest: createHash("sha256").update(source).digest("hex") });
    expect(result.status, result.diagnostic).toBe("completed");
    expect(result.output).toBe("fixture complete");
  }, 20_000);
});
