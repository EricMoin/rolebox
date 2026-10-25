import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${import.meta.resolve("tsx")}`].filter(Boolean).join(" ") };
const order = args.indexOf("--file-order");
if (order >= 0) {
  args.splice(order, 1);
  environment.ROLEBOX_TEST_FILE_ORDER = JSON.stringify(args.filter(arg => arg.endsWith(".test.ts")));
  args.push("--no-file-parallelism");
}
const child = spawn(process.execPath, [
  "--experimental-ffi", fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", ...args,
], { stdio: "inherit", env: environment });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
