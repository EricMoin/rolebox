import { build } from "esbuild"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// Project root = scripts/.. (this script lives in scripts/)
const projectRoot = import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd()

// The host supplies React and its client packages to the CommonJS factory.
await build({
  bundle: true,
  jsx: "automatic",
  jsxImportSource: "react",
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: ["src/platform/adapters/dsh/web/ui/client.ts"],
  outdir: "dist",
  entryNames: "dsh-web-client",
  platform: "browser",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
})

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
// envelope id MUST equal rolebox's boot-graph row id: dsh-client-modules
// derives that id from the nearest owning package manifest's `name` because
// the bundle patch names the host half with the path-like
// `../dist/entries/dsh.js` (dsh/cordis.patch.yml) — package-subpath names
// such as `rolebox/dsh` are not scanned as client packages at all. The
// browser half keys the module table by that row id and rejects a bundle
// whose factory registered under a different one:
// "bundle <url> loaded without registering \"<id>\" via __ModuleLoader__.load".
// rolebox's package name is `rolebox`, so id == package name, exactly like
// dsh's own roster rows. The
// preamble (`var module` / `var exports` / the Symbol.toStringTag Module
// marker) and the trailing `return module.exports` mirror those bundles —
// the loader takes the factory's return value as the module's exports, so
// the envelope MUST end with the return statement.
const bundlePath = resolve(projectRoot, "dist/dsh-web-client.js")
const bundled = readFileSync(bundlePath, "utf8")
const wrapped = [
  `window.__ModuleLoader__.load({`,
  `\tid: "rolebox",`,
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
writeFileSync(bundlePath, wrapped)
console.log(`build:dsh-web-client — dist/dsh-web-client.js wrapped (${wrapped.length} bytes)`)

// Keep declaration imports relative to their emitted component tree.
const entryDts = resolve(projectRoot, "dist/platform/adapters/dsh/web/ui/client.d.ts")
const targetDts = resolve(projectRoot, "dist/dsh-web-client.d.ts")

if (existsSync(entryDts)) {
  writeFileSync(targetDts, 'export * from "./platform/adapters/dsh/web/ui/client.js";\n')
  console.log("build:dsh-web-client — dist/dsh-web-client.d.ts emitted")
} else {
  console.warn(
    "build:dsh-web-client — entry declarations not found; the './client' types condition dangles until the main tsc emit runs first",
  )
}

process.exit(0)
