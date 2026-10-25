import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env, PATH: [join(directory, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter) };
let failed = false;
for (const host of ["pi", "dsh"]) {
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), join(directory, "scripts", "graph-smoke", `${host}.ts`),
  ], { cwd: directory, env: environment, stdio: "inherit", timeout: 300_000 });
  if (result.error) throw result.error;
  const passed = result.status === 0;
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${host} real SDK acceptance\n`);
  if (!passed) failed = true;
}
process.exitCode = failed ? 1 : 0;
