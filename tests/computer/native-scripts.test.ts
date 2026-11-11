import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { computerScriptsPlugin, writeComputerScripts } from "../../scripts/computer-scripts.ts";
import * as darwinScripts from "../../src/computer/drivers/darwin/native-scripts.ts";
import * as linuxScripts from "../../src/computer/drivers/linux/native-scripts.ts";
import * as win32Scripts from "../../src/computer/drivers/win32/native-scripts.ts";

const platforms = [
  { name: "darwin", scripts: darwinScripts },
  { name: "linux", scripts: linuxScripts },
  { name: "win32", scripts: win32Scripts },
] as const;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputDirectory(): URL {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-native-scripts-"));
  directories.push(directory);
  const packageUrl = pathToFileURL(join(directory, "package.json"));
  writeFileSync(packageUrl, '{"type":"module"}');
  return new URL("./", packageUrl);
}

function copyCrLfFile(source: URL, target: URL): void {
  writeFileSync(target, readFileSync(source, "utf8").replace(/\r?\n/g, "\r\n"));
}

function copyCrLfDirectory(source: URL, target: URL): void {
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source, { withFileTypes: true })) {
    if (file.isDirectory()) copyCrLfDirectory(new URL(`${file.name}/`, source), new URL(`${file.name}/`, target));
    else copyCrLfFile(new URL(file.name, source), new URL(file.name, target));
  }
}

function expectStandaloneModule(module: URL, expected: Readonly<Record<string, string>>): void {
  const result = spawnSync(process.execPath, [
    "--input-type=module", "--eval",
    `process.stdout.write(JSON.stringify(await import(${JSON.stringify(module.href)})));`,
  ], {
    cwd: fileURLToPath(new URL("./", module)), env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ...expected });
}

describe.each(platforms)("$name native computer script builds", ({ name, scripts }) => {
  it("loads its own CRLF script tree without the other platform packages", () => {
    const directory = outputDirectory();
    const source = new URL(`../../src/computer/drivers/${name}/native-scripts.ts`, import.meta.url);
    const module = new URL(`${name}/native-scripts.ts`, directory);
    mkdirSync(new URL("./", module));
    copyCrLfFile(new URL("../native-script.ts", source), new URL("native-script.ts", directory));
    copyCrLfFile(source, module);
    copyCrLfDirectory(new URL("scripts/", source), new URL("scripts/", module));
    expectStandaloneModule(module, scripts);
  });

  it("emits a standalone module without script sidecars or a stale loader source map", () => {
    const directory = outputDirectory();
    for (const platform of platforms) mkdirSync(new URL(`${platform.name}/`, directory));
    const module = new URL(`${name}/native-scripts.js`, directory);
    const sourceMap = new URL("native-scripts.js.map", module);
    writeFileSync(sourceMap, "stale loader map");
    writeComputerScripts(directory);
    expect(existsSync(sourceMap)).toBe(false);
    expectStandaloneModule(module, scripts);
  });

  it("inlines the same scripts when bundling source for the TUI", async () => {
    const directory = outputDirectory();
    const module = new URL("native-scripts.js", directory);
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`../../src/computer/drivers/${name}/native-scripts.ts`, import.meta.url))],
      bundle: true, platform: "node", format: "esm", write: false,
      plugins: [computerScriptsPlugin()],
    });
    writeFileSync(module, result.outputFiles[0]!.text);
    expectStandaloneModule(module, scripts);
  });
});
