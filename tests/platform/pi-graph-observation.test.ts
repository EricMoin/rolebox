import { afterEach, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiGraphObservation } from "../../src/platform/adapters/pi/graph-observation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-graph-events-")); roots.push(root);
  const directory = join(root, ".rolebox", "pi-sessions"); mkdirSync(directory, { recursive: true });
  const file = join(directory, "worker.jsonl");
  return { file, read: () => readPiGraphObservation(root, "worker"), append: (event: unknown) => appendFileSync(file, JSON.stringify(event) + "\n") };
}
const ended = (stopReason: string, willRetry = false) => ({ type: "agent_end", willRetry, messages: [{ role: "assistant", stopReason }] });

it("reads a late terminal event after recovery and invalidates it when another run starts", () => {
  const f = fixture();
  expect(f.read().kind).toBe("unknown");
  f.append({ type: "agent_start" });
  f.append({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
  expect(f.read().kind).toBe("unknown");
  f.append(ended("stop"));
  expect(f.read()).toEqual({ kind: "completed" });
  f.append({ type: "agent_start" });
  expect(f.read().kind).toBe("unknown");
});

it("distinguishes failure, pending tool work and automatic retry from success", () => {
  const f = fixture();
  for (const reason of ["error", "aborted", "length"]) { f.append(ended(reason)); expect(f.read().kind).toBe("failed"); }
  for (const reason of ["toolUse", "pending", "deferred", "future"]) { f.append(ended(reason)); expect(f.read().kind).toBe("unknown"); }
  f.append(ended("stop", true)); expect(f.read().kind).toBe("unknown");
  f.append({ type: "agent_end", messages: [{ role: "toolResult", stopReason: "stop" }] });
  expect(f.read().kind).toBe("unknown");
});

it("does not trust an incomplete or corrupt transcript", () => {
  const f = fixture();
  f.append(ended("stop")); appendFileSync(f.file, '{"type":');
  expect(f.read().kind).toBe("unknown");
  writeFileSync(f.file, "invalid\n"); f.append(ended("stop"));
  expect(f.read().kind).toBe("unknown");
});

it("keeps observing a launched worker when the task announcement precedes its native terminal fact", async () => {
  const { PiOutcomeDelivery } = await import("../../src/platform/adapters/pi/outcome-dispatch.ts");
  let observation: import("../../src/graph/host/outcome-host.ts").HostExecutionObservation = { kind: "running" };
  let announce: ((id: string, status: string) => void) | undefined;
  const settlements: string[] = [];
  const delivery = new PiOutcomeDelivery({
    directory: "/workspace", observeWorker: () => observation,
    manager: {
      launch: async () => ({ id: "task", sessionId: "native-worker", parentSessionId: "parent", depth: 1,
        status: "running", agent: "worker", prompt: "Work", startedAt: new Date(),
        progress: { toolCalls: 0, lastUpdate: new Date() } }),
      onTaskTerminated: (_id, callback) => { announce = callback; },
    },
    onStartFailed() {}, onSettled: result => { settlements.push(result.kind); },
  });
  try {
    delivery.deliver({ graphId: "late-end", planRevision: "revision", nodeId: "work", attemptId: "work#1",
      agent: "worker", prompt: "Work", credential: "fixture-credential" },
      { graphId: "late-end", effectId: "dispatch:work#1", attemptId: "work#1" }, { sessionId: "parent" });
    await new Promise(resolve => setTimeout(resolve, 0));
    announce!("task", "error");
    expect(settlements).toEqual([]);
    observation = { kind: "failed", reason: "native process exited" };
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(settlements).toEqual(["failed"]);
    announce!("task", "error");
    expect(settlements).toEqual(["failed"]);
  } finally { delivery.close(); }
});
