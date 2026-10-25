import { transformAsync } from "@babel/core";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

const require = createRequire(import.meta.url);

export async function transformSolid(code: string, filename: string): Promise<string> {
  const result = await transformAsync(code, {
    filename, configFile: false, babelrc: false,
    plugins: [[require("babel-plugin-module-resolver"), {
      resolvePath(specifier: string) {
        if (specifier === "solid-js") return "solid-js/dist/solid.js";
        if (specifier === "solid-js/store") return "solid-js/store/dist/store.js";
        return specifier;
      },
    }]],
    presets: [
      [require("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
      [require("@babel/preset-typescript")],
    ],
  });
  if (!result?.code) throw new Error(`Solid transform produced no code: ${filename}`);
  return result.code;
}

export function solidBuildPlugin(): Plugin {
  return {
    name: "rolebox-solid",
    setup(build) {
      build.onResolve({ filter: /^solid-js(?:\/store)?$/ }, ({ path }) => ({
        path: path === "solid-js" ? "solid-js/dist/solid.js" : "solid-js/store/dist/store.js", external: true,
      }));
      build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => ({
        contents: await transformSolid(await readFile(path, "utf8"), path), loader: "js",
      }));
    },
  };
}
