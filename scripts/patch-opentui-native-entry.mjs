#!/usr/bin/env node
/**
 * Patch installed @opentui native-platform packages so the "bun" export
 * condition resolves to a synchronous entry instead of a top-level-await
 * re-export. Runs automatically as part of `postinstall` (idempotent).
 *
 * Why this exists
 * ---------------
 * @opentui/core resolves its native library through the platform package
 * `@opentui/core-<platform>-<arch>`, whose `exports` map lists a "bun"
 * condition pointing at `index.bun.js`:
 *
 *     const module = await import("./libopentui.<ext>", { with: { type: "file" } })
 *     export default module.default
 *
 * Bun 1.3.x (up to at least 1.3.14) mis-evaluates this top-level-await
 * re-export when the module is loaded from a `bun test --isolate` child
 * process: `await import()` resolves while the awaited module's `export
 * default` binding is still in the temporal dead zone, so reading
 * `nativePackage.default` throws
 * `ReferenceError: Cannot access 'default' before initialization`.
 * The repo's core test leg runs with `--isolate`, so any test importing
 * `@opentui/core` (e.g. tests/monitor/live-state-e2e.test.ts) crashes.
 *
 * Every platform package also ships `index.js` — the "import" condition
 * entry — which resolves the same binary synchronously via
 * `fileURLToPath(new URL("./libopentui.<ext>", import.meta.url))` and is
 * behavior-identical. We copy that synchronous form over `index.bun.js` so
 * the "bun" condition no longer triggers the bug. The copy references each
 * package's own binary, so it is correct across platforms (dylib/so/dll).
 *
 * The script is a no-op when no TLA marker is found (upstream fix, or no
 * @opentui platform package installed) and is safe to re-run.
 */

import { readdirSync, readFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENTUI_DIR = join(ROOT, "node_modules", "@opentui");

const TLA_MARKER = "await import(";

function main() {
  if (!existsSync(OPENTUI_DIR)) {
    console.log("[patch-opentui] no node_modules/@opentui — nothing to patch");
    return 0;
  }

  const candidates = readdirSync(OPENTUI_DIR)
    .filter((name) => name.startsWith("core-"))
    .map((name) => join(OPENTUI_DIR, name));

  let patched = 0;
  let skipped = 0;

  for (const pkgDir of candidates) {
    const indexBunJs = join(pkgDir, "index.bun.js");
    const indexJs = join(pkgDir, "index.js");
    if (!existsSync(indexBunJs) || !existsSync(indexJs)) {
      skipped += 1;
      continue;
    }

    const bunEntry = readFileSync(indexBunJs, "utf8");
    if (!bunEntry.includes(TLA_MARKER)) {
      skipped += 1;
      continue; // already synchronous (or upstream changed the pattern)
    }

    // index.js is the package's own synchronous entry for the same binary.
    copyFileSync(indexJs, indexBunJs);
    patched += 1;
    console.log(
      `[patch-opentui] rewrote ${pkgDir.replace(ROOT + "/", "")}/index.bun.js ` +
        `to the synchronous form (top-level-await re-export breaks under ` +
        `"bun test --isolate": ReferenceError: Cannot access 'default' before initialization)`,
    );
  }

  if (patched === 0 && skipped === 0) {
    console.log("[patch-opentui] no @opentui/core-* platform packages found — nothing to patch");
  } else {
    console.log(`[patch-opentui] patched ${patched}, already-sync/skipped ${skipped}`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error("[patch-opentui] unexpected failure:", err);
  process.exitCode = 1;
}
