import { fileURLToPath } from "node:url";
import { spawnProcess } from "./node-process.ts";

const root = new URL("../", import.meta.url);
for (const script of [
  "scripts/clean-dist.ts", "node_modules/typescript/bin/tsc", "scripts/mark-bin-executable.ts",
  "scripts/build-entry-aliases.ts", "scripts/build-tui.ts", "scripts/build-dsh-web-client.ts",
]) {
  const child = spawnProcess([process.execPath, script], { cwd: fileURLToPath(root), stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
