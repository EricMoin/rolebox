import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SUBTASK 3 — Recheck→rename window suite (DEPENDS ON SUBTASK 1's probe).
//
// Subtask 1 outcome (tests/hashline/adversarial-fs-seam-probe.test.ts):
//   PROBE RESULT: YES — mock.module("node:fs/promises", ...) with a factory
//   spreading createRequire(import.meta.url)("node:fs/promises") and overriding
//   `rename` deterministically intercepts the rename performed by a REAL
//   createHashlineEditTool().execute() call (verified on bun 1.3.14, darwin).
//
// Gap under test: the documented limitation at docs/limitations.md:33 and
// atomic-write.ts:129-134 — "a file changed between this check and the
// subsequent rename is not detected... NOT a strict cross-process CAS". The
// tool's only revalidation is the best-effort pre-write recheck
// (verifyFileUnchanged, atomic-write.ts:136-157) invoked from hashline-edit.ts
// :395-410. The existing test-only seam `beforeWrite` (hashline-edit.ts:28-33,
// invoked at :387) fires BEFORE that recheck, while path locks are held — it
// does NOT cover the recheck→rename window (hashline-edit.ts:395-410 → :412-420
// → atomic-write.ts:60 `rename`).
//
// The rename hook below fires strictly AFTER verifyFileUnchanged returned, so
// any external mutation it performs lands inside the uncovered window and is
// invisible to the CAS.
//
// Classification: DOCUMENTED-LIMITATION test — it asserts the DOCUMENTED
// behavior (silent clobber) and must PASS; the silently-lost content is logged
// as evidence. A separate assertion pins the internal-consistency invariant
// (returned version == fresh hashline_read of the final on-disk content) which
// must hold even when the tool's own write won the race.
// ─────────────────────────────────────────────────────────────────────────────

interface WindowState {
  renameIntercepted: boolean;
  renameCalls: number;
  renameTarget: string | null;
  /** Content the injected "external writer" clobbers the rename target with. */
  injectedContent: string;
}

const windowState: WindowState = {
  renameIntercepted: false,
  renameCalls: 0,
  renameTarget: null,
  injectedContent: "",
};

// Hoisted by bun above the static imports of this file (same mechanism as the
// subtask-1 probe): the consumer chain src/hashline/index.ts → hashline-edit.ts
// → atomic-write.ts binds its node:fs/promises named imports to this mock.
const require = createRequire(import.meta.url);

mock.module("node:fs/promises", () => {
  // CJS require bypasses bun's ESM mock registry (verified empirically in
  // subtask 1), so `real` is the GENUINE node:fs/promises — real passthroughs
  // for every export we do not touch, with `rename` overridden below.
  const real = require("node:fs/promises") as typeof import("node:fs/promises");
  const realRename = real.rename;
  const realWriteFile = real.writeFile;
  return {
    ...real,
    rename: async (from: string, to: string) => {
      windowState.renameIntercepted = true;
      windowState.renameCalls += 1;
      windowState.renameTarget = to;
      // Inject an external mutation into the recheck→rename window: the
      // "external writer" clobbers the rename TARGET after verifyFileUnchanged
      // has already re-read it (so the CAS cannot see this write), then drops a
      // marker so the hook's execution is observable. The atomic rename then
      // overwrites the target, silently losing the injected content.
      try {
        await realWriteFile(to, windowState.injectedContent, "utf-8");
        await realWriteFile(`${to}.window-marker`, "WINDOW HOOK RAN\n", "utf-8");
      } catch {
        // Target may not exist yet (to-be-created file); the marker and
        // renameIntercepted already record that the hook ran.
      }
      return realRename(from, to);
    },
  };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-recheck-rename-window-"));
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

describe("adversarial recheck→rename window (subtask 3)", () => {
  it.skipIf(process.platform === "win32")(
    "external write injected between the pre-write recheck and the rename is silently clobbered — behavior as documented (BEHAVIOR-AS-DOCUMENTED)",
    async () => {
      const fp = join(tmpDir, "recheck-rename-window.txt");
      await writeFile(fp, "line one\nline two\n", "utf-8");
      const version = await readVersion(fp);

      // The content the simulated external writer lands in the window. Must be
      // distinguishable from the edit's content so the final state can prove
      // which write won.
      const externalContent = "EXTERNAL-WRITER line alpha\nEXTERNAL-WRITER line beta\n";
      windowState.injectedContent = externalContent;

      const out = String(
        await createHashlineEditTool().execute({
          files: [
            { filePath: fp, version, edits: [{ op: "append" as const, lines: "line three" }] },
          ],
        }),
      );

      // 1. The tool reports SUCCESS — the injected external write was NOT
      //    detected (no conflict, no Error:). Documented behavior.
      expect(out).not.toContain("Error:");
      const m = out.match(/^version: (\S+)$/m);
      if (!m) throw new Error(`no top-level version in edit output for ${fp}:\n${out}`);
      const returnedVersion = m[1];

      // 2. The injection hook did run in the window (rename intercepted after
      //    the recheck) — evidence the adversarial capability was exercised.
      expect(windowState.renameIntercepted).toBe(true);
      expect(windowState.renameCalls).toBeGreaterThan(0);
      expect(windowState.renameTarget).not.toBeNull();
      const marker = await readFile(`${windowState.renameTarget}.window-marker`, "utf-8");
      expect(marker).toContain("WINDOW HOOK RAN");

      // 3. DOCUMENTED BEHAVIOR (docs/limitations.md:33, atomic-write.ts:129-134):
      //    the external write landed after the pre-write recheck, so the CAS
      //    could not see it — the atomic rename silently clobbered it. The
      //    tool's own write won and the external content is gone from the final
      //    state, with no conflict reported.
      const finalContent = await readFile(fp, "utf-8");
      expect(finalContent).toBe("line one\nline two\nline three\n");
      expect(finalContent).not.toContain("EXTERNAL-WRITER");
      console.log(
        `recheck→rename window: BEHAVIOR-AS-DOCUMENTED (silent clobber demonstrated), rename intercepted ${windowState.renameCalls} time(s), target=${windowState.renameTarget}`,
      );
      console.log(
        "silently-lost content (external write injected between the pre-write recheck and the rename):",
      );
      console.log(JSON.stringify(externalContent));
      console.log(
        `evidence: final on-disk content is the edit's content; injected external content is ABSENT (clobbered by atomic rename)`,
      );

      // 4. Internal consistency: the tool's own write won, so the version it
      //    returned must equal a fresh hashline_read of the final on-disk
      //    content (the D1 read/edit version contract must still hold).
      const freshVersion = await readVersion(fp);
      expect(returnedVersion).toBe(freshVersion);
      console.log(
        `internal consistency: returned version ${returnedVersion} == fresh hashline_read version ${freshVersion}`,
      );
    },
  );
});
