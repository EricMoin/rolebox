/**
 * Cross-process hashline_edit worker fixture (subtask 2 — adversarial
 * cross-process race suite).
 *
 * Runs as a REAL separate OS process (spawned by the parent test via
 * `Bun.spawn(["bun", <this file>, ...])`) so that the in-process per-path FIFO
 * mutex (src/hashline/path-lock.ts:18-88) is NOT shared with any sibling
 * worker — exactly the cross-process scenario the lock documents as
 * unsupported (docs/limitations.md:30).
 *
 * The worker performs read → edit on a target file passed via argv, using the
 * same public tool constructors the test suite uses
 * (`createHashlineEditTool` from src/hashline/index.ts). It supports a
 * deterministic hold point for deterministic interleaving: its `beforeWrite`
 * hook (invoked while all path locks are held, after edit computation, before
 * the pre-write recheck — src/hashline/hashline-edit.ts:363-387) writes a
 * "held" marker file and busy-waits for a "release" marker file within a
 * bounded deadline. No wall-clock sleeps are used for coordination anywhere —
 * only marker-file barriers with bounded deadlines.
 *
 * Args (all required unless noted):
 *   --target <abs path>      file to edit
 *   --version <v>            base version observed by the parent
 *   --op <append|replace>    edit operation (default replace)
 *   --pos <anchor>           LINE#HASH anchor (required when op=replace)
 *   --line <content>         replacement / appended content
 *   --marker <id>            worker instance id, used in marker file names
 *   --marker-dir <dir>       directory for marker + result files
 *   --mode <hold|free>       hold = block at beforeWrite until released
 *   --gate <id>              optional: wait for gate-<id>.marker before executing
 *   --deadline-ms <n>        bounded hold deadline (default 30000)
 *
 * Result contract: writes JSON {ok, result, round} to <marker-dir>/result-<marker>.json
 * and also prints the same JSON to stdout. Exits 0.
 */

import { writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHashlineEditTool } from "../../../src/hashline/index.ts";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const target = arg("target");
const version = arg("version");
const op = arg("op") ?? "replace";
const pos = arg("pos");
const line = arg("line");
const markerId = arg("marker") ?? "worker";
const markerDir = arg("marker-dir");
const mode = arg("mode") ?? "free";
const gateId = arg("gate");
const deadlineMs = Number(arg("deadline-ms") ?? "30000");
const round = arg("round") ?? "";

if (!target || version === undefined || line === undefined || !markerDir) {
  process.stdout.write(
    `cross-process-worker: missing required arg (target=${target}, version=${version}, line=${line}, marker-dir=${markerDir})\n`,
  );
  process.exit(2);
}

// Re-bind after the required-arg check so TS narrows to string for all later
// uses (module-scope narrowing does not flow into main()).
const TARGET: string = target;
const VERSION: string = version;
const LINE: string = line;
const MARKER_DIR: string = markerDir;

const heldMarker = join(MARKER_DIR, `held-${markerId}.marker`);
const releaseMarker = join(MARKER_DIR, `release-${markerId}.marker`);
const resultFile = join(MARKER_DIR, `result-${markerId}.json`);

/** Busy-wait for a marker file to appear, bounded by a deadline. */
async function waitForMarker(markerPath: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await access(markerPath);
      return true;
    } catch {
      // not yet — keep waiting
    }
    // Yield to the event loop; no wall-clock sleep.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

async function main(): Promise<void> {
  if (gateId !== undefined) {
    // Optional start barrier so racing workers begin ~simultaneously.
    await waitForMarker(join(MARKER_DIR, `gate-${gateId}.marker`), deadlineMs);
  }

  const edits = op === "append" ? [{ op: "append" as const, lines: LINE }] : [{ pos: pos!, lines: LINE }];

  const tool = createHashlineEditTool({
    beforeWrite: async () => {
      if (mode === "hold") {
        // Deterministic hold point: signal "inside critical section", then
        // block until the parent releases us (bounded).
        await writeFile(heldMarker, "1", "utf-8");
        await waitForMarker(releaseMarker, deadlineMs);
      }
    },
  });

  const result = await tool.execute({ files: [{ filePath: TARGET, version: VERSION, edits }] });
  const text = String(result);
  const payload = { ok: !text.includes("Error:"), result: text, round };
  const json = `${JSON.stringify(payload)}\n`;

  // Deliver via result file (primary) and stdout (diagnostic).
  try {
    await mkdir(MARKER_DIR, { recursive: true });
    await writeFile(resultFile, json, "utf-8");
  } catch {
    // Result-file delivery is best-effort; stdout still carries the payload.
  }
  await new Promise<void>((resolve) => process.stdout.write(json, () => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  const json = `${JSON.stringify({ ok: false, result: String(err), round })}\n`;
  process.stdout.write(json, () => process.exit(1));
});
