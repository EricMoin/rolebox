import { beforeEach as resetBeforeEach } from "vitest";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";


import { makeToolContext } from "./fixtures/tool-context.ts";


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

const require = createRequire(import.meta.url);

vi.doMock("node:fs/promises", () => {
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
const { createHashlineReadTool, createHashlineEditTool } = await import("../../src/hashline/index.ts");

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-fs-seam-probe-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function readVersion(filePath: string): Promise<string> {
  const out = String(await createHashlineReadTool().execute({ filePath }, makeToolContext(tmpDir)));
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
        }, makeToolContext(tmpDir)),
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
          "technique: vi.doMock(\"node:fs/promises\", ...) with factory spreading createRequire(import.meta.url)(\"node:fs/promises\") and overriding rename",
        );
        console.log("PROBE RESULT: YES");
      } else {
        // (b) Interception unavailable — negative result is a valid outcome.
        console.log(
          "seam not available: vi.doMock(\"node:fs/promises\") did not intercept atomic-write's rename through createHashlineEditTool",
        );
        console.log("PROBE RESULT: NO");
      }
    },
  );
});

resetBeforeEach(() => vi.resetModules());
