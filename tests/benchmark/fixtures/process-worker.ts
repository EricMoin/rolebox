import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "../../../src/benchmark/types.ts";

const [requestPath, resultPath] = process.argv.slice(2) as [string, string];
const request = JSON.parse(await readFile(requestPath, "utf8")) as BenchmarkWorkerRequest;
const result: BenchmarkWorkerResult = {
  protocolVersion: 1, status: "completed", output: "fixture output", durationMs: 1,
  terminationConfirmed: true,
  runtime: { dshVersion: "0.2.1-test", roleboxVersion: "2.0.0" },
  activation: { roleId: request.roleId, provider: request.provider, model: request.model, promptDigest: "a".repeat(64) },
  usage: { inputTokens: 2, outputTokens: 3, costUsd: null, source: "host" },
};
const write = (value: unknown) => writeFile(resultPath, JSON.stringify(value));

switch (request.prompt) {
  case "normal":
    process.stdout.write("This output is not the result protocol.\n");
    process.stderr.write("Private fixture log must not become a diagnostic.\n");
    await write(result);
    break;
  case "environment": {
    const isolatedNames = ["HOME", "DSH_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR", "TMPDIR", "TEMP", "TMP"];
    result.output = JSON.stringify({
      allowed: process.env.BENCHMARK_TEST_ALLOWED === "synthetic-test-value",
      unexpected: process.env.BENCHMARK_TEST_UNLISTED !== undefined,
      injectedOptions: process.env.NODE_OPTIONS !== undefined,
      homeIsOverridden: process.env.HOME !== "ignored-home-override",
      hotReload: process.env.ROLEBOX_HOT_RELOAD,
      recovery: process.env.ROLEBOX_ENGINE_RECOVERY,
      directories: Object.fromEntries(isolatedNames.map(name => [name, process.env[name]])),
      root: dirname(requestPath), requestMode: (await stat(requestPath)).mode & 0o777,
      rootMode: (await stat(dirname(requestPath))).mode & 0o777,
    });
    await write(result);
    break;
  }
  case "malformed": await write({ ...result, usage: { inputTokens: -1 } }); break;
  case "wrong-version": await write({ ...result, protocolVersion: 2 }); break;
  case "wrong-activation": await write({ ...result, activation: { ...result.activation, model: "wrong-model" } }); break;
  case "missing-activation": await write({ ...result, activation: undefined }); break;
  case "malformed-json": await writeFile(resultPath, "{"); break;
  case "oversized": await write({ ...result, output: "x".repeat(9 * 1024 * 1024) }); break;
  case "long-output": await write({ ...result, output: "x".repeat(4_194_305) }); break;
  case "long-diagnostic": await write({ ...result, diagnostic: "x".repeat(65_537) }); break;
  case "long-runtime": await write({ ...result, runtime: { ...result.runtime, dshVersion: "x".repeat(129) } }); break;
  case "missing": break;
  case "nonzero": await write(result); process.exit(7); break;
  case "unconfirmed": await write({ ...result, terminationConfirmed: false }); break;
  case "bad-runtime": await write({ ...result, runtime: { dshVersion: 7, roleboxVersion: "2.0.0" } }); break;
  case "task-failure": await write({ ...result, status: "task_failure" }); break;
  case "task-timeout": await write({ ...result, status: "task_timeout" }); break;
  case "leak-output": await write({ ...result, output: `answer ${process.env.BENCHMARK_TEST_ALLOWED}` }); break;
  case "leak-diagnostic": await write({ ...result, diagnostic: `provider rejected ${process.env.BENCHMARK_TEST_ALLOWED}` }); break;
  case "leak-runtime": await write({ ...result, runtime: { ...result.runtime, dshVersion: process.env.BENCHMARK_TEST_ALLOWED } }); break;
  case "hang":
  case "cancel": {
    process.on("SIGTERM", () => {});
    await writeFile(join(request.workspace, "started.json"), JSON.stringify({ pid: process.pid, root: dirname(requestPath) }));
    setInterval(() => {}, 1_000);
    break;
  }
  case "descendant": {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./process-descendant.ts", import.meta.url))], { stdio: "ignore" });
    await writeFile(join(request.workspace, "descendant.json"), JSON.stringify({ pid: child.pid }));
    await write(result);
    process.exit(0);
  }
  default: process.exit(3);
}
