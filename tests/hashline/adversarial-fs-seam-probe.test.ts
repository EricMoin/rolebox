import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SUBTASK 1 — Feasibility probe: can an in-process technique deterministically
// intercept the `rename` call made by src/hashline/atomic-write.ts:60 through a
// real createHashlineEditTool().execute() run, i.e. inject an external file
// mutation BETWEEN verifyFileUnchanged (atomic-write.ts:136-157, invoked from
// hashline-edit.ts:395-410) and the atomic rename?
//
// Why this matters: the existing test-only seam createHashlineEditTool
// ({beforeWrite}) (hashline-edit.ts:28-33, invoked at :387) fires BEFORE the
// pre-write recheck while path locks are held — it does NOT cover the
// recheck→rename window. This probe determines whether bun:test's
// mock.module("node:fs/promises", ...) can cover that window.
//
// Technique under test: mock.module is hoisted by bun above the static imports
// of this file, so when atomic-write.ts evaluates its
// `import { writeFile, rename, ... } from "node:fs/promises"` (atomic-write.ts:1),
// the bindings resolve to the mock. The factory cannot receive the original
// module (bun 1.3.14 passes nothing), and importing the real module inside the
// factory via ESM (`import("node:fs")` .promises, or the bare `fs/promises`
// specifier) deadlocks: bun resolves both to the mocked registry entry. The
// working technique is to fetch the GENUINE module via CJS —
// `createRequire(import.meta.url)("node:fs/promises")` — which bypasses the
// ESM mock registry entirely (verified empirically) — spread it, and override
// only `rename`.
//
// Probe ground truth (the ONLY thing asserted):
//   - The edit tool call must succeed through whatever rename path was active
//     (mocked or real) — if the mock broke the tool, that is a failed probe.
//   - If the mock intercepted, the injected marker is observable (a marker file
//     written by the hook, plus the hook's recorded rename target), and the
//     external clobber written into the recheck→rename window is silently lost
//     (overwritten by the atomic rename) — the adversarial capability proof.
//   - If interception did not work, the probe records "seam not available" and
//     PASSES — a negative result is a valid outcome, not a failure.
//
// Verdict line for downstream subtasks (parsed by acceptance criteria):
//   console.log("PROBE RESULT: YES|NO")
// ─────────────────────────────────────────────────────────────────────────────

interface ProbeState {
  renameIntercepted: boolean;
  renameCalls: number;
  renameTarget: string | null;
}

const probeState: ProbeState = {
  renameIntercepted: false,
  renameCalls: 0,
  renameTarget: null,
};

// Hoisted by bun above the static imports of this file (verified empirically on
// bun 1.3.14: the consumer chain src/hashline/index.ts → hashline-edit.ts →
// atomic-write.ts binds its node:fs/promises named imports to this mock).
const require = createRequire(import.meta.url);

mock.module("node:fs/promises", () => {
  // CJS require is NOT shadowed by bun's mock.module (which only affects ESM
  // import resolution), so this yields the GENUINE node:fs/promises exports —
  // real passthroughs for every export we don't touch (realpath, stat,
  // readFile, unlink, mkdtemp, rm, ...), with `rename` overridden below.
  const real = require("node:fs/promises") as typeof import("node:fs/promises");
  const realRename = real.rename;
  const realWriteFile = real.writeFile;
  return {
    ...real,
    rename: async (from: string, to: string) => {
      probeState.renameIntercepted = true;
      probeState.renameCalls += 1;
      probeState.renameTarget = to;
      // Inject an external mutation into the recheck→rename window:
      //  1. clobber the rename target with adversarial content (an external
      //     writer racing in AFTER verifyFileUnchanged re-read the file);
      //  2. drop a marker file so the hook's execution is observable regardless
      //     of which content ultimately wins the race.
      try {
        await realWriteFile(to, "PROBE-EXTERNAL-CLOBBER\n", "utf-8");
        await realWriteFile(`${to}.probe-marker`, "PROBE HOOK RAN\n", "utf-8");
      } catch {
        // Target may not exist yet (to-be-created file); the marker write
        // alone is sufficient evidence, and renameIntercepted already records.
      }
      return realRename(from, to);
    },
  };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-fs-seam-probe-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function readVersion(filePath: string): Promise<string> {
  const out = String(await createHashlineReadTool().execute({ filePath }));
  const m = out.match(/^version: (\S+)$/m);
  if (!m) throw new Error(`no version in hashline_read output for ${filePath}:\n${out}`);
  return m[1];
}

describe("adversarial fs seam probe (subtask 1)", () => {
  it.skipIf(process.platform === "win32")(
    "rename interception through createHashlineEditTool — PROBE RESULT: YES|NO",
    async () => {
      // (a) Attempt interception against a REAL tool.execute() call on a
      // temp-dir file.
      const fp = join(tmpDir, "seam-probe.txt");
      await writeFile(fp, "line one\nline two\n", "utf-8");
      const version = await readVersion(fp);

      const result = String(
        await createHashlineEditTool().execute({
          files: [
            { filePath: fp, version, edits: [{ op: "append" as const, lines: "line three" }] },
          ],
        }),
      );

      // ── Ground truth assertions (valid in BOTH outcomes) ──
      // The tool call must complete through whatever rename path was active.
      // If the mock broke the tool (e.g. rename never delegated), the probe
      // itself has failed and must fail the suite.
      expect(result).not.toContain("Error:");
      const finalContent = await readFile(fp, "utf-8");
      expect(finalContent).toBe("line one\nline two\nline three\n");

      if (probeState.renameIntercepted) {
        // The mock's rename hook ran: an external mutation WAS injected into
        // the recheck→rename window.
        expect(probeState.renameCalls).toBeGreaterThan(0);
        expect(probeState.renameTarget).not.toBeNull();

        // Observable marker written by the injected hook.
        const marker = await readFile(`${probeState.renameTarget}.probe-marker`, "utf-8");
        expect(marker).toContain("PROBE HOOK RAN");

        // Adversarial capability proof: the external clobber landed in the
        // window AFTER verifyFileUnchanged re-read the file, yet the atomic
        // rename silently overwrote it — the edit's content won and the
        // injected write is GONE from the final state. The CAS could not see
        // it; the write was lost without any conflict report.
        expect(finalContent).not.toContain("PROBE-EXTERNAL-CLOBBER");
        console.log(
          `seam available: rename intercepted ${probeState.renameCalls} time(s), target=${probeState.renameTarget}`,
        );
        console.log(
          "technique: mock.module(\"node:fs/promises\", ...) with factory spreading createRequire(import.meta.url)(\"node:fs/promises\") and overriding rename",
        );
        console.log("PROBE RESULT: YES");
      } else {
        // (b) Interception unavailable — negative result is a valid outcome.
        console.log(
          "seam not available: mock.module(\"node:fs/promises\") did not intercept atomic-write's rename through createHashlineEditTool",
        );
        console.log("PROBE RESULT: NO");
      }
    },
  );
});
