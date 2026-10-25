import { defineConfig } from "vitest/config";
import { transformSolid } from "./scripts/solid-transform.ts";
import { transform } from "esbuild";
import { FileOrderSequencer } from "./scripts/test-sequencer.ts";

export default defineConfig({
  plugins: [{
    name: "rolebox-solid-tests", enforce: "pre",
    async transform(code, id) {
      if (/[/\\]src[/\\]tui[/\\].*\.tsx(?:\?|$)/.test(id)) {
        return { code: await transformSolid(code, id.split("?")[0]!), map: null };
      }
      if (/\.ts\?/.test(id)) return transform(code, { loader: "ts", format: "esm", target: "es2022" });
    },
  }],
  resolve: { alias: [{ find: /^solid-js$/, replacement: "solid-js/dist/solid.js" }, { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" }] },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks", isolate: true, maxWorkers: 4,
    execArgv: ["--experimental-ffi", "--import", "tsx"],
    sequence: { sequencer: FileOrderSequencer },
    setupFiles: ["./tests/helpers/node-setup.ts"],
    testTimeout: 45_000, hookTimeout: 30_000,
  },
});
