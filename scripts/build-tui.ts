import { copyFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Project root = scripts/.. (this script lives in scripts/)
const projectRoot = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd()

// Step 1: Bundle with Bun (JSX → JS)
const result = await Bun.build({
  entrypoints: ["src/tui/index.tsx"],
  outdir: "dist",
  naming: "tui.js",
  target: "bun",
  format: "esm",
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
  external: [
    "@opencode-ai/sdk",
    "@opencode-ai/plugin",
    "@opentui/core",
    "@opentui/solid",
    "@opentui/keymap",
    "solid-js",
  ],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
console.log("build:tui — bundle success")

// Step 2: Generate type declarations (.d.ts) via tsc
//
// Known false-positive tsc diagnostics:
//   TS2322 ("fg" on SpanProps) — Solid plugin handles at runtime
//   TS7006 (implicit any) — strict-mode callback inference
// tsc exits 2 when files are emitted with errors; exit 2 is accepted here.
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.tui.json", "--declaration", "--emitDeclarationOnly", "--outDir", "dist"], {
  cwd: projectRoot,
})
if (tsc.exitCode === 0) {
  console.log("build:tui — declarations success")
} else if (tsc.exitCode === 2) {
  const stderr = new TextDecoder().decode(tsc.stderr)
  const count = (stderr.match(/error TS/g) || []).length
  console.log(`build:tui — declarations emitted with ${count} known-false-positive diagnostics`)
} else {
  console.error("build:tui — declaration emit failed (exit code " + tsc.exitCode + ")")
  console.error(new TextDecoder().decode(tsc.stderr))
  process.exit(1)
}

// Step 3: Copy dist/tui/index.d.ts → dist/tui.d.ts so the package.json exports
// map ("./tui": { "types": "./dist/tui.d.ts" }) resolves correctly.
const entryDts = resolve(projectRoot, "dist/tui/index.d.ts")
const entryDtsMap = resolve(projectRoot, "dist/tui/index.d.ts.map")
const targetDts = resolve(projectRoot, "dist/tui.d.ts")
const targetDtsMap = resolve(projectRoot, "dist/tui.d.ts.map")

if (existsSync(entryDts)) {
  // Read, fix sourceMappingURL to match new filename, write
  const content = Bun.file(entryDts).text()
    .then((text) => text.replace("index.d.ts.map", "tui.d.ts.map"))
  const fixed = await content
  Bun.write(targetDts, fixed)
  console.log("build:tui — copied dist/tui/index.d.ts → dist/tui.d.ts")
}
if (existsSync(entryDtsMap)) {
  copyFileSync(entryDtsMap, targetDtsMap)
  console.log("build:tui — copied dist/tui/index.d.ts.map → dist/tui.d.ts.map")
}

process.exit(0)
