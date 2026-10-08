import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../../src/graph/store/graph-store.ts";

/**
 * How long the two workers get to announce themselves at the barrier.
 *
 * The failure this replaces was NOT slowness: the worker's script path was built
 * with `new URL(...).pathname` (fixed below), which on Windows is
 * "/D:/a/rolebox/…/execution-limit-worker.ts" — a path no runtime can load, so
 * the child died in milliseconds without writing its announcement and the old
 * 5 s budget ran out ("workers did not reach barrier", reported after 5067 ms by
 * the Windows lane the brief quotes; the whole test takes ~109 ms on macOS, and
 * the two announcements cost ~21 ms of it here).
 *
 * The budget is still raised, as a PLATFORM ALLOWANCE rather than a retry: each
 * worker starts a fresh runtime and loads the store's module graph before it can
 * announce itself, and a Windows runner's cold process start is nothing like
 * this host's. The sibling cross-process files already allow a child 20–30 s for
 * the same reason (`CHILD_DEADLINE_MS`), so this follows their convention. The
 * wait happens ONCE — and a worker that exits before announcing is reported
 * immediately with its own exit code and stderr, which is what would have made
 * the broken path a one-line diagnosis on the next Windows run instead of
 * another budget expiry.
 */
const BARRIER_BUDGET_MS = 30_000;

it("serializes different nodes at the run ceiling and replays the winner after process exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-limit-"));
  // fileURLToPath, never `new URL(...).pathname`: on Windows the pathname of a
  // file URL is "/D:/a/rolebox/…/execution-limit-worker.ts", which is not the
  // worker's path (the leading separator makes it root-relative on the current
  // drive), so the child runtime could not find the script at all. Every other
  // cross-process worker in this directory is named this way.
  const worker = fileURLToPath(new URL("./helpers/execution-limit-worker.ts", import.meta.url));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const store = GraphStore.openFile(directory);
    store.runs.mintRun({ graphId: "bounded", runId: "run", planRevision: "plan", startedAt: 0 });
    store.close();
    const barrier = join(directory, "go");
    const spawn = (attempt: string, wait?: string) => {
      // `env` is explicit: a bare `Bun.spawn` under `bun test --isolate` gets
      // the start-time OS environ, not this process's `process.env` — the
      // preload's ROLEBOX_LOG_DIR (tests/helpers/log-dir-preload.ts) included,
      // so the child would resolve and append to the workspace's `.rolebox/logs`.
      const child = Bun.spawn([process.execPath, worker, directory, attempt, ...(wait ? [wait] : [])], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      children.push(child);
      return child;
    };
    const first = spawn("work#1", barrier);
    const second = spawn("review#1", barrier);
    const deadline = Date.now() + BARRIER_BUDGET_MS;
    while (!existsSync(`${barrier}.work#1`) || !existsSync(`${barrier}.review#1`)) {
      for (const [label, child] of [["work#1", first], ["review#1", second]] as const) {
        if (child.exitCode !== null) {
          const stderr = (await new Response(child.stderr).text()).trim();
          throw new Error(
            `the ${label} worker exited with code ${child.exitCode} before reaching the barrier` +
            (stderr === "" ? "" : `: ${stderr}`),
          );
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`workers did not reach barrier within ${BARRIER_BUDGET_MS}ms`);
      }
      await Bun.sleep(5);
    }
    writeFileSync(barrier, "go");
    const reports = await Promise.all([first, second].map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output) as { kind: string; attempts: string[] };
    }));
    expect(reports.map((r) => r.kind).sort()).toEqual(["exhausted", "reserved"]);
    const winner = reports.find((r) => r.kind === "reserved")!.attempts[0]!;
    const replay = spawn(winner);
    const replayed = JSON.parse(await new Response(replay.stdout).text());
    expect(await replay.exited).toBe(0);
    expect(replayed).toEqual({ kind: "replayed", attempts: [winner] });
    const denied = spawn("work#2");
    expect(JSON.parse(await new Response(denied.stdout).text()).kind).toBe("exhausted");
    expect(await denied.exited).toBe(0);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}, BARRIER_BUDGET_MS + 30_000);
