import { copyFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

// Project root = scripts/.. (this script lives in scripts/)
const projectRoot = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd()

// Step 1: Bundle the browser client entry with Bun (JSX → JS).
//
// format "cjs" matters: the dsh web app's ModuleLoader materializes each
// client bundle as a CommonJS factory — `factory(require) → module.exports`
// (dsh-client-modules lib/client.js:100-103 uses the factory's RETURN VALUE
// as the module exports) — so the bundle body must reference the free
// `module` / `exports` / `require` identifiers the factory envelope provides.
// `react` / `react/jsx-runtime` and every `@deepseek-ai/*` package stay
// external: the dsh web app supplies them at runtime through the loader's
// require (the declared `dsh.client.inject` edges), exactly like the
// reference bundles (e.g. @deepseek-ai/dsh-client-ui-commands/lib/client.js).
//
// The automatic JSX runtime must be `react/jsx-runtime` (NOT the dev variant):
// the dsh web app's loader table registers `react/jsx-runtime`. Bun selects
// the runtime from NODE_ENV at process start (in-process mutation does not
// reach the compiler), so package.json's `build:dsh-web-client` script runs
// this under `NODE_ENV=production`.
const result = await Bun.build({
  entrypoints: ["src/platform/adapters/dsh/web-ui/client.ts"],
  outdir: "dist",
  naming: "dsh-web-client.js",
  target: "browser",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
console.log("build:dsh-web-client — bundle success")

// Step 2: Wrap the bundle in the canonical client-bundle envelope:
//
//     window.__ModuleLoader__.load({
//       id: "<loader entry name>",
//       factory: (require) => { var module = { exports: {} }; ... return module.exports; }
//     });
//
// Observed verbatim in @deepseek-ai/dsh-client-ui-commands/lib/client.js:1-3
// (id = the loader entry name; the entry the loader graph rows by). The
// envelope id MUST equal the loader entry's `name` for rolebox's
// `rolebox/dsh` row: dsh-client-modules' browser half keys the module table
// by the boot-graph row id (the entry name) and rejects a bundle whose
// factory registered under a different id (`lib/client.js:84`:
// "bundle <url> loaded without registering \"<id>\" via __ModuleLoader__.load").
// dsh's own roster rows use plain package names, so id == package name for
// them; rolebox's cordis plugin lives at the `./dsh` sub-path export, hence
// the `rolebox/dsh` entry name — and the envelope id must match it. The
// preamble (`var module` / `var exports` / the Symbol.toStringTag Module
// marker) and the trailing `return module.exports` mirror those bundles —
// the loader takes the factory's return value as the module's exports, so
// the envelope MUST end with the return statement.
const bundlePath = resolve(projectRoot, "dist/dsh-web-client.js")
const bundled = await Bun.file(bundlePath).text()
const wrapped = [
  `window.__ModuleLoader__.load({`,
  `\tid: "rolebox/dsh",`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  bundled,
  `\t\treturn module.exports;`,
  `\t}`,
  `});`,
  ``,
].join("\n")
await Bun.write(bundlePath, wrapped)
console.log(`build:dsh-web-client — dist/dsh-web-client.js wrapped (${wrapped.length} bytes)`)

// Step 3: Publish type declarations for the "./client" export's types
// condition. The main build's `tsc` (runs before this script in
// `scripts.build`) emits the entry + dock declarations under
// dist/platform/adapters/dsh/web-ui/ (rootDir = src); copy the entry to
// dist/dsh-web-client.d.ts and its dock sibling to dist/role-switch-dock.d.ts
// so the emitted `./role-switch-dock.tsx` import keeps resolving, and fix the
// sourceMappingURL reference (same rename dance build-tui.ts does).
const entryDts = resolve(projectRoot, "dist/platform/adapters/dsh/web-ui/client.d.ts")
const dockDts = resolve(projectRoot, "dist/platform/adapters/dsh/web-ui/role-switch-dock.d.ts")
const entryDtsMap = resolve(projectRoot, "dist/platform/adapters/dsh/web-ui/client.d.ts.map")
const targetDts = resolve(projectRoot, "dist/dsh-web-client.d.ts")
const targetDockDts = resolve(projectRoot, "dist/role-switch-dock.d.ts")
const targetDtsMap = resolve(projectRoot, "dist/dsh-web-client.d.ts.map")

if (existsSync(entryDts) && existsSync(dockDts)) {
  const fixed = await Bun.file(entryDts)
    .text()
    .then((text) => text.replace("client.d.ts.map", "dsh-web-client.d.ts.map"))
  await Bun.write(targetDts, fixed)
  copyFileSync(dockDts, targetDockDts)
  if (existsSync(entryDtsMap)) copyFileSync(entryDtsMap, targetDtsMap)
  console.log("build:dsh-web-client — dist/dsh-web-client.d.ts emitted")
} else {
  console.warn(
    "build:dsh-web-client — entry declarations not found; the './client' types condition dangles until the main tsc emit runs first",
  )
}

process.exit(0)
