import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { solidBuildPlugin } from "./solid-transform.ts";

const projectRoot = resolve(import.meta.dirname, "..");
await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/tui/index.tsx"], outfile: "dist/tui.js", bundle: true,
  platform: "node", target: "node26", format: "esm", packages: "external",
  plugins: [solidBuildPlugin()],
});

const tsc = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.tui.json"], {
  cwd: projectRoot, encoding: "utf8",
});
if (tsc.error) throw tsc.error;
if (tsc.status !== 0) {
  process.stderr.write(tsc.stderr + tsc.stdout);
  process.exit(tsc.status ?? 1);
}

const entry = resolve(projectRoot, "dist/tui/index.d.ts");
if (!existsSync(entry)) throw new Error("TUI declaration output is missing");
writeFileSync(resolve(projectRoot, "dist/tui.d.ts"), readFileSync(entry, "utf8").replace("index.d.ts.map", "tui.d.ts.map"));
const map = `${entry}.map`;
if (existsSync(map)) copyFileSync(map, resolve(projectRoot, "dist/tui.d.ts.map"));
console.log("build:tui — bundle and declarations emitted");
