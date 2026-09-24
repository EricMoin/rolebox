import { expect, it } from "bun:test";
import { observeDshExecutionEvents, readDshExecutionEvents } from "../../src/platform/adapters/dsh/graph-observation.ts";
import type { DshSessionEventLike, DshSessionStoreLike } from "../../src/platform/adapters/dsh/session.ts";

const event = (type: string, data: unknown): DshSessionEventLike => ({ type, data, time: 1 });
const descriptor = event("subagent/descriptor", { version: 2, mode: "one-shot", label: "graph/dispatch:work#1" });
const ended = (kind: string) => event("turn/end", { reason: { kind } });
const observe = (events: readonly DshSessionEventLike[]) => observeDshExecutionEvents(events, "graph/dispatch:work#1");

it("requires a terminal turn after the exact one-shot execution descriptor", () => {
  expect(observe([descriptor, ended("completed")])).toEqual({ kind: "completed" });
  for (const kind of ["aborted", "error", "max-tokens", "refusal"]) expect(observe([descriptor, ended(kind)]).kind).toBe("failed");
  for (const events of [[], [ended("completed")], [ended("completed"), descriptor],
    [descriptor, ended("completed"), event("turn/start", {})], [descriptor, ended("unknown")],
    [event("subagent/descriptor", { version: 2, mode: "continuable", label: "graph/dispatch:work#1" }), ended("completed")],
    [event("subagent/descriptor", { version: 2, mode: "one-shot", label: "other" }), ended("completed")]]) {
    expect(observe(events).kind).toBe("unknown");
  }
});

it("uses a read-only cold session handle and closes it on success and read failure", async () => {
  const sessions = { get: () => undefined } as unknown as DshSessionStoreLike;
  const opened: string[] = [];
  let closes = 0;
  const persistence = { open: async (_id: string, access: string) => {
    opened.push(access);
    return { read: async () => ({ events: [descriptor, ended("completed")] }), close: async () => { closes++; } };
  } };
  expect(observe((await readDshExecutionEvents(sessions, persistence, "worker"))!).kind).toBe("completed");
  expect(opened).toEqual(["read"]); expect(closes).toBe(1);
  await expect(readDshExecutionEvents(sessions, { open: async () => ({ read: async () => { throw new Error("unavailable"); }, close: async () => { closes++; } }) }, "worker")).rejects.toThrow("unavailable");
  expect(closes).toBe(2);
  expect(await readDshExecutionEvents(sessions, undefined, "worker")).toBeUndefined();
});
