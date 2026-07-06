import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

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

if (result.success) {
  console.log("build:tui — success")
  process.exit(0)
} else {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
