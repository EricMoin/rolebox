import { spawnProcess } from "./node-process.ts";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env };
delete environment.ROLEBOX_BROWSE_LIVE;
delete environment.ROLEBOX_BROWSE_ENGINE;
const unitFiles = [
  "tests/browse/", "tests/e2e.test.ts", "tests/dsh-cordis-e2e.test.ts", "tests/dsh-plugin.test.ts",
  "tests/dsh-browse-registration.test.ts", "tests/platform/codex-mcp.test.ts",
  "tests/platform/dsh-browse-context.test.ts", "tests/platform/dsh-browse-policy.test.ts",
  "tests/platform/dsh-browse-presentation.test.ts", "tests/platform/pi-browse-grants.test.ts",
  "tests/tool-assembly-browse.test.ts", "tests/browse-use-gate.test.ts", "tests/hooks/system-transform.test.ts",
];
const results: Array<{ name: string; code: number }> = [];

async function run(name: string, args: string[], overrides: Record<string, string> = {}): Promise<number> {
  const child = spawnProcess([process.execPath, ...args], {
    cwd: directory, env: { ...environment, ...overrides }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  results.push({ name, code });
  return code;
}

if (await run("build", ["--import", "tsx", "scripts/build-all.ts"]) !== 0) process.exit(1);
await run("module and host regression", ["--import", "tsx", "scripts/test.ts", ...unitFiles]);
for (const engine of ["chromium", "firefox", "webkit"]) {
  await run(`${engine}: 23-tool acceptance`, ["--import", "tsx", "scripts/test.ts", "tests/browse/live-e2e.test.ts"], {
    ROLEBOX_BROWSE_LIVE: "1", ROLEBOX_BROWSE_ENGINE: engine,
  });
}
// Playwright's module mocks and native transports must not share a test process.
for (const file of ["playwright-live", "stdio-live", "host-live", "lifecycle-live"]) {
  await run(file, ["--import", "tsx", "scripts/test.ts", `tests/browse/${file}.test.ts`], { ROLEBOX_BROWSE_LIVE: "1" });
}
await run("production types", ["node_modules/typescript/bin/tsc", "--noEmit"]);
await run("script types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.scripts.json"]);
await run("TUI test types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.tui-tests.json"]);
await run("test types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.tests.json"]);
for (const result of results) process.stdout.write(`${result.code === 0 ? "PASS" : "FAIL"} ${result.name}\n`);
process.exitCode = results.some(result => result.code !== 0) ? 1 : 0;
