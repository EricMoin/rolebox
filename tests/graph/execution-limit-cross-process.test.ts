import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store/graph-store.ts";

it("serializes different nodes at the run ceiling and replays the winner after process exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-limit-"));
  const worker = new URL("./helpers/execution-limit-worker.ts", import.meta.url).pathname;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const store = GraphStore.openFile(directory);
    store.runs.mintRun({ graphId: "bounded", runId: "run", planRevision: "plan", startedAt: 0 });
    store.close();
    const barrier = join(directory, "go");
    const spawn = (attempt: string, wait?: string) => {
      const child = Bun.spawn([process.execPath, worker, directory, attempt, ...(wait ? [wait] : [])], { stdout: "pipe", stderr: "pipe" });
      children.push(child);
      return child;
    };
    const first = spawn("work#1", barrier);
    const second = spawn("review#1", barrier);
    const deadline = Date.now() + 5000;
    while (!existsSync(`${barrier}.work#1`) || !existsSync(`${barrier}.review#1`)) {
      if (Date.now() > deadline) throw new Error("workers did not reach barrier");
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
}, 15000);
