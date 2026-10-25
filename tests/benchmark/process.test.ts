import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmarkWorker } from "../../src/benchmark/process.ts";
import type { BenchmarkWorkerRequest } from "../../src/benchmark/types.ts";

const workerPath = fileURLToPath(new URL("./fixtures/process-worker.ts", import.meta.url));
let workspace: string;
let savedEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "benchmark-process-test-"));
  savedEnvironment = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  rmSync(workspace, { recursive: true, force: true });
});

function request(prompt = "normal"): BenchmarkWorkerRequest {
  return { protocolVersion: 1, workspace, rolesDirectory: workspace,
    roleId: "fixture-role", provider: "fixture-provider", model: "fixture-model",
    host: { plugins: [], env: [] }, prompt, timeoutMs: 1_000 };
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForFile(name: string): Promise<Record<string, unknown>> {
  const path = join(workspace, name);
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Fixture did not start before the test deadline.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

describe.skipIf(process.platform === "win32")("benchmark process worker", () => {
  it("accepts a verified result independently of stdout and stderr", async () => {
    const result = await runBenchmarkWorker(request(), { workerPath });
    expect(result.status).toBe("completed");
    expect(result.output).toBe("fixture output");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, costUsd: null, source: "host" });
    expect(result.terminationConfirmed).toBe(true);
    expect(result.diagnostic).toBeUndefined();
    expect(result.runtime).toEqual({ dshVersion: "0.2.1-test", roleboxVersion: "2.0.0" });
  });

  it.each(["malformed", "wrong-version", "wrong-activation", "missing-activation", "malformed-json", "missing", "oversized", "bad-runtime", "long-output", "long-diagnostic", "long-runtime"])("rejects the %s result", async mode => {
    const result = await runBenchmarkWorker(request(mode), { workerPath });
    expect(result.status).toBe("infra_error");
    expect(result.output).toBe("");
    expect(result.terminationConfirmed).toBe(true);
  });

  it("rejects success from a worker that exits unsuccessfully", async () => {
    const result = await runBenchmarkWorker(request("nonzero"), { workerPath });
    expect(result.status).toBe("infra_error");
    expect(result.output).toBe("");
    expect(result.terminationConfirmed).toBe(true);
  });

  it("does not score completion without host teardown confirmation", async () => {
    const result = await runBenchmarkWorker(request("unconfirmed"), { workerPath });
    expect(result.status).toBe("infra_error");
    expect(result.terminationConfirmed).toBe(false);
  });

  it("preserves a worker-confirmed task timeout", async () => {
    const result = await runBenchmarkWorker(request("task-timeout"), { workerPath });
    expect(result.status).toBe("task_timeout");
    expect(result.terminationConfirmed).toBe(true);
  });

  it("preserves a worker-confirmed task failure", async () => {
    const result = await runBenchmarkWorker(request("task-failure"), { workerPath });
    expect(result.status).toBe("task_failure");
    expect(result.terminationConfirmed).toBe(true);
  });

  it.each(["leak-output", "leak-diagnostic", "leak-runtime"])("redacts explicitly forwarded values from %s and invalidates scoring", async mode => {
    const secret = "synthetic-test-value";
    process.env.BENCHMARK_TEST_ALLOWED = secret;
    const input = request(mode);
    input.host.env = ["BENCHMARK_TEST_ALLOWED"];
    const result = await runBenchmarkWorker(input, { workerPath });
    expect(result.status).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, costUsd: null, source: "host" });
    expect(result.diagnostic).toContain("redacted");
  });

  it("redirects storage and only inherits explicitly allowed credentials", async () => {
    process.env.BENCHMARK_TEST_ALLOWED = "synthetic-test-value";
    process.env.BENCHMARK_TEST_UNLISTED = "synthetic-unlisted-value";
    process.env.NODE_OPTIONS = "--no-warnings";
    process.env.HOME = "ignored-home-override";
    process.env.ROLEBOX_HOT_RELOAD = "true";
    const input = request("environment");
    input.host.env = ["BENCHMARK_TEST_ALLOWED", "HOME", "ROLEBOX_HOT_RELOAD"];
    const result = await runBenchmarkWorker(input, { workerPath });
    expect(result.status).toBe("completed");
    const output = JSON.parse(result.output);
    expect(output.allowed).toBe(true);
    expect(output.unexpected).toBe(false);
    expect(output.injectedOptions).toBe(false);
    expect(output.homeIsOverridden).toBe(true);
    expect(output.hotReload).toBe("false");
    expect(output.recovery).toBe("off");
    expect(output.requestMode).toBe(0o600);
    expect(output.rootMode).toBe(0o700);
    for (const directory of Object.values(output.directories) as string[]) {
      const path = relative(output.root, directory);
      expect(isAbsolute(path)).toBe(false);
      expect(path.startsWith("..")).toBe(false);
    }
    expect(relative(workspace, output.root).startsWith("..")).toBe(true);
    expect(existsSync(output.root)).toBe(false);
  });

  it("returns cancellation without spawning for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBenchmarkWorker(request("cancel"), { signal: controller.signal, workerPath });
    expect(result.status).toBe("cancelled");
    expect(result.terminationConfirmed).toBe(true);
    expect(existsSync(join(workspace, "started.json"))).toBe(false);
  });

  it("does not lose cancellation during asynchronous startup", async () => {
    const controller = new AbortController();
    const running = runBenchmarkWorker(request("cancel"), { signal: controller.signal, workerPath });
    controller.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.terminationConfirmed).toBe(true);
    expect(existsSync(join(workspace, "started.json"))).toBe(false);
  });

  it("escalates cancellation to SIGKILL and removes the private control directory", async () => {
    const controller = new AbortController();
    const running = runBenchmarkWorker(request("cancel"), { signal: controller.signal, workerPath });
    const started = await waitForFile("started.json");
    controller.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.terminationConfirmed).toBe(true);
    expect(processExists(started.pid as number)).toBe(false);
    expect(existsSync(started.root as string)).toBe(false);
  });

  it("retains the control directory when process-group termination cannot be confirmed", async () => {
    const controller = new AbortController();
    const running = runBenchmarkWorker(request("cancel"), { signal: controller.signal, workerPath });
    const started = await waitForFile("started.json");
    const pid = started.pid as number;
    const root = started.root as string;
    const kill = process.kill;
    process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
      if (target === -pid && signal !== 0) throw Object.assign(new Error("Fixture permission denial"), { code: "EPERM" });
      return kill(target, signal);
    }) as typeof process.kill;
    try {
      controller.abort();
      const result = await running;
      expect(result.status).toBe("cancelled");
      expect(result.terminationConfirmed).toBe(false);
      expect(processExists(pid)).toBe(true);
      expect(existsSync(root)).toBe(true);
    } finally {
      process.kill = kill;
      kill(-pid, "SIGKILL");
      const deadline = Date.now() + 2_000;
      while (processExists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an outer deadline as infrastructure failure and confirms forced termination", async () => {
    const input = request("hang");
    input.timeoutMs = 1;
    const result = await runBenchmarkWorker(input, { workerPath });
    const started = JSON.parse(readFileSync(join(workspace, "started.json"), "utf8"));
    expect(result.status).toBe("infra_error");
    expect(result.diagnostic).toContain("outer deadline");
    expect(result.terminationConfirmed).toBe(true);
    expect(processExists(started.pid)).toBe(false);
    expect(existsSync(started.root)).toBe(false);
  }, 20_000);

  it("cleans up descendants and invalidates a worker that exits before them", async () => {
    const result = await runBenchmarkWorker(request("descendant"), { workerPath });
    const descendant = JSON.parse(readFileSync(join(workspace, "descendant.json"), "utf8"));
    expect(result.status).toBe("infra_error");
    expect(result.terminationConfirmed).toBe(true);
    expect(processExists(descendant.pid)).toBe(false);
  });

  it("turns a failed spawn into a bounded infrastructure result", async () => {
    const input = request();
    input.workspace = join(workspace, "does-not-exist");
    const result = await runBenchmarkWorker(input, { workerPath });
    expect(result.status).toBe("infra_error");
    expect(result.terminationConfirmed).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_647])("rejects an invalid deadline of %s", async timeoutMs => {
    const result = await runBenchmarkWorker({ ...request(), timeoutMs }, { workerPath });
    expect(result.status).toBe("invalid");
    expect(result.terminationConfirmed).toBe(true);
  });
});
