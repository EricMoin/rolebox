import { expect, it } from "bun:test";
import { observeDshExecutionEvents, readDshExecutionEvents, readDshLastTurnDeclaration } from "../../src/platform/adapters/dsh/graph-observation.ts";
import type { DshTurnDeclarationReading } from "../../src/platform/adapters/dsh/graph-observation.ts";
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

// ── Last-turn declaration reading — DEFECT 2 ─────────────────────────────────

const text = (value: string) => ({ type: "text", text: value });
const assistant = (content: unknown[]) => event("assistant/message", { turn: 1, step: 1, message: { content }, stream: [] });
const began = event("turn/start", { turn: 1 });
const block = (body: string) => "```json\n" + body + "\n```";
const other = event("subagent/descriptor", { version: 2, mode: "one-shot", label: "graph/dispatch:other#2" });
const readTurn = (events: readonly DshSessionEventLike[]) => readDshLastTurnDeclaration(events, "graph/dispatch:work#1");
const reasonOf = (reading: DshTurnDeclarationReading) => reading.kind === "declared" ? "" : reading.reason;
const absentReason = (reading: DshTurnDeclarationReading) => {
  expect(reading.kind).toBe("absent");
  return reasonOf(reading);
};

it("reads the one declaration block from the final completed turn of the owned descriptor", () => {
  const events = [descriptor, began, assistant([text("Finished the work.")]),
    assistant([text(block('{"outcome_id": "done", "data": {"files": ["a.ts"]}, "evidence_refs": ["a.ts"]}'))]), ended("completed")];
  expect(readTurn(events)).toEqual({
    kind: "declared",
    declaration: {
      outcomeId: "done",
      data: { files: ["a.ts"] },
      evidenceRefs: ["a.ts"],
      derivation: { eventIndex: 3, turnIndex: 4 },
    },
  });
  // A declaration without data/evidence_refs carries neither key.
  expect(readTurn([descriptor, began, assistant([text(block('{"outcome_id": "done"}'))]), ended("completed")]))
    .toEqual({ kind: "declared", declaration: { outcomeId: "done", derivation: { eventIndex: 2, turnIndex: 3 } } });
});

it("joins text blocks and messages with one newline and ignores reasoning/tool/unknown blocks", () => {
  const reasoning = { type: "reasoning", text: block('{"outcome_id": "reasoning-must-not-count"}') };
  const tool = { type: "tool-call", id: "call-1", name: "graph_worker_exec", arguments: "{}" };
  const events = [descriptor, began,
    assistant([reasoning, tool, text("The report follows"), text(block('{"outcome_id": "done", "data": null}'))]),
    ended("completed")];
  expect(readTurn(events)).toEqual({
    kind: "declared",
    declaration: { outcomeId: "done", data: null, derivation: { eventIndex: 2, turnIndex: 3 } },
  });
  // The join is what puts the fence on its own line: text fused to the opening
  // fence is not a fence line, so there is no candidate.
  const fused = [descriptor, began, assistant([text('note```json\n{"outcome_id": "done"}\n```')]), ended("completed")];
  expect(absentReason(readTurn(fused))).toContain("No fenced declaration block");
  // Blocks split across two assistant messages join on a line boundary too.
  const acrossMessages = [descriptor, began, assistant([text("trailing text")]),
    assistant([text(block('{"outcome_id": "done"}'))]), ended("completed")];
  expect(readTurn(acrossMessages).kind).toBe("declared");
  // An unterminated fence yields no candidate and is never repaired.
  expect(absentReason(readTurn([descriptor, began, assistant([text("```json\n{\"outcome_id\": \"done\"}")]), ended("completed")])))
    .toContain("No fenced declaration block");
});

it("is absent without an owned descriptor, without a final completed turn, or without a block", () => {
  const declared = block('{"outcome_id": "done"}');
  expect(absentReason(readTurn([]))).toContain("No one-shot dsh graph execution descriptor");
  expect(absentReason(readTurn([began, assistant([text(declared)]), ended("completed")])))
    .toContain("No one-shot dsh graph execution descriptor");
  expect(absentReason(readTurn([event("subagent/descriptor", { version: 2, mode: "continuable", label: "graph/dispatch:work#1" }), ended("completed")])))
    .toContain("No one-shot dsh graph execution descriptor");
  expect(absentReason(readTurn([event("subagent/descriptor", { version: 2, mode: "one-shot", label: "graph/dispatch:other#2" }), ended("completed")])))
    .toContain("No one-shot dsh graph execution descriptor");
  // `blocked`/`interrupted` are the remaining kinds of the installed TurnEndReasonMap (dsh-session types.d.ts:165-201).
  for (const kind of ["aborted", "error", "max-tokens", "refusal", "blocked", "interrupted", "unknown"]) {
    const events = [descriptor, began, assistant([text(declared)]), ended(kind)];
    expect(absentReason(readTurn(events))).toContain(kind);
  }
  expect(absentReason(readTurn([descriptor, began]))).toContain("No terminal turn");
  expect(absentReason(readTurn([descriptor, ended("completed")]))).toContain("No terminal turn");
  expect(absentReason(readTurn([descriptor, began, assistant([text("no block here")]), ended("completed")])))
    .toContain("No fenced declaration block");
});

it("uses the last turn pair inside the owned window", () => {
  const before = [began, assistant([text(block('{"outcome_id": "before-descriptor"}'))]), ended("completed"),
    descriptor, began, assistant([text(block('{"outcome_id": "after-descriptor"}'))]), ended("completed")];
  expect(readTurn(before)).toEqual({
    kind: "declared",
    declaration: { outcomeId: "after-descriptor", derivation: { eventIndex: 5, turnIndex: 6 } },
  });
  const turns = [descriptor, began, assistant([text(block('{"outcome_id": "first-turn"}'))]), ended("completed"),
    began, assistant([text(block('{"outcome_id": "last-turn"}'))]), ended("completed")];
  expect(readTurn(turns)).toEqual({
    kind: "declared",
    declaration: { outcomeId: "last-turn", derivation: { eventIndex: 5, turnIndex: 6 } },
  });
});

it("lets a later descriptor reset the owned window for both readers", () => {
  const work = [descriptor, began, assistant([text(block('{"outcome_id": "done"}'))]), ended("completed")];
  expect(absentReason(readTurn([...work, other]))).toContain("No one-shot dsh graph execution descriptor");
  expect(observe([...work, other]).kind).toBe("unknown");
  expect(readTurn([other, ...work])).toEqual({
    kind: "declared",
    declaration: { outcomeId: "done", derivation: { eventIndex: 3, turnIndex: 4 } },
  });
  expect(observe([other, ...work])).toEqual({ kind: "completed" });
});

it("is ambiguous for two blocks, naming the count and the assistant/message event indexes", () => {
  const events = [descriptor, began, assistant([text(block('{"outcome_id": "done"}'))]),
    assistant([text(block('{"outcome_id": "failed"}'))]), ended("completed")];
  const reading = readTurn(events);
  expect(reading.kind).toBe("ambiguous");
  expect(reasonOf(reading)).toContain("2");
  expect(reasonOf(reading)).toContain("2, 3");
});

it("is malformed for unknown keys, a bad outcome_id or bad evidence_refs — never repaired", () => {
  const cases: Array<[string, string]> = [
    ['{"outcome_id": "done", "unknown": true}', "unknown key"],
    ['{"outcome_id": ""}', "outcome_id"],
    ['{"data": {"x": 1}}', "outcome_id"],
    ['{"outcome_id": 7}', "outcome_id"],
    ['{"outcome_id": "done", "evidence_refs": "a.ts"}', "evidence_refs"],
    ['{"outcome_id": "done", "evidence_refs": ["a.ts", ""]}', "evidence_refs"],
    ['{"outcome_id": "done", "evidence_refs": [1]}', "evidence_refs"],
    ['["done"]', "not a JSON object"],
    ["not json", "not valid JSON"],
  ];
  for (const [body, violation] of cases) {
    const reading = readTurn([descriptor, began, assistant([text(block(body))]), ended("completed")]);
    expect(reading.kind).toBe("malformed");
    expect(reasonOf(reading)).toContain(violation);
  }
});

it("is total: missing or hostile event data never throws and degrades safely", () => {
  const hostile: DshSessionEventLike[] = [
    undefined as unknown as DshSessionEventLike,
    { type: "subagent/descriptor", time: 1 } as DshSessionEventLike,
    event("subagent/descriptor", null),
    event("subagent/descriptor", { version: 2, mode: "one-shot" }),
    event("subagent/descriptor", { version: 2, mode: "one-shot", label: "graph/dispatch:work#1" }),
    event("turn/start", "not a record"),
    event("assistant/message", { message: { content: "not an array" } }),
    event("assistant/message", { message: null }),
    event("assistant/message", null),
    event("assistant/message", { message: { content: [null, 7, { type: "text" }, { type: "text", text: 3 }, { type: "reasoning", text: "x" }] } }),
    event("turn/end", { reason: "not a record" }),
    event("turn/end", null),
  ];
  const inputs: Array<readonly DshSessionEventLike[]> = [
    [],
    [null] as unknown as readonly DshSessionEventLike[],
    hostile,
    undefined as unknown as readonly DshSessionEventLike[],
    null as unknown as readonly DshSessionEventLike[],
  ];
  for (const events of inputs) {
    expect(() => readTurn(events)).not.toThrow();
    expect(readTurn(events).kind).toBe("absent");
    expect(() => observe(events)).not.toThrow();
  }
});

// ── Totality against THROWING PROPERTY ACCESSORS ─────────────────────────────
//
// The hostile block above feeds hostile DATA SHAPES, which never read through a
// live accessor — that is why it passes without guarding the reads. These cases
// feed hostile LIVE OBJECTS: values whose shape passes the record guard and
// whose property ACCESS then throws — a `Proxy` with a throwing `get` trap, an
// array whose index accessors throw, a block whose `text` getter throws.
//
// HOW EACH CASE GOES RED: with the property guard removed, `readProperty` (and
// the element/slice reads built on it) lets the accessor's own error out, so the
// reader throws and the `not.toThrow()` assertion below fails. The reasons are
// asserted too, so a case cannot pass by degrading through some OTHER absent
// path than the documented one.

/** An array of `length` events whose every index from `prefix` on throws on read. */
function throwingIndexes(length: number, prefix: readonly DshSessionEventLike[] = []): DshSessionEventLike[] {
  const events = new Array<unknown>(length);
  prefix.forEach((value, index) => { events[index] = value; });
  for (let index = prefix.length; index < length; index++) {
    Object.defineProperty(events, index, {
      configurable: true,
      enumerable: true,
      get() { throw new Error("hostile index accessor"); },
    });
  }
  return events as DshSessionEventLike[];
}

/** A `Proxy` whose `get` trap throws for ANY property of `target`. */
function throwingGet<T extends object>(target: T): T {
  return new Proxy(target, { get(): never { throw new Error("hostile get trap"); } });
}

/** The observation kinds the local `observe` wrapper reports for a case. */
type ObservedKind = ReturnType<typeof observe>["kind"];

/**
 * One hostile LIVE OBJECT case: the events, the reason the reader must answer
 * with, and the observation the SAME events must leave behind (the throwing
 * accessor is not always in a part the observation reads).
 */
const ACCESSOR_CASES: Array<[string, readonly DshSessionEventLike[], string, ObservedKind]> = [
  // A proxied EVENT: `isRecord` passes and the `type` read throws.
  ["a proxy event", [throwingGet({ ...descriptor })],
    "No one-shot dsh graph execution descriptor", "unknown"],
  // A proxied SESSION: `Array.isArray` passes and the `length` read throws.
  ["a proxy session", throwingGet([descriptor, began, assistant([text(block('{"outcome_id": "done"}'))]), ended("completed")]),
    "No one-shot dsh graph execution descriptor", "unknown"],
  // Every index accessor of the session throws.
  ["throwing index accessors", throwingIndexes(4),
    "No one-shot dsh graph execution descriptor", "unknown"],
  // A READABLE descriptor followed by throwing indexes: ownership is proven, so
  // the owned window is built by `slice`, which re-reads those indexes.
  ["throwing indexes after the owned descriptor", throwingIndexes(4, [descriptor]),
    "No terminal turn", "unknown"],
  // A readable message whose content block throws on its `text` read: the block
  // is skipped, and the OBSERVATION still reports the end it did read.
  ["a throwing block accessor",
    [descriptor, began, event("assistant/message", { message: { content: [
      { type: "text", get text(): string { throw new Error("hostile text accessor"); } },
    ] } }), ended("completed")],
    "No fenced declaration block", "completed"],
];

for (const [name, events, reason, observation] of ACCESSOR_CASES) {
  it(`is total against throwing property accessors — ${name}`, () => {
    expect(() => readTurn(events), name).not.toThrow();
    const reading = readTurn(events);
    expect(reading.kind, name).toBe("absent");
    expect(reasonOf(reading), name).toContain(reason);
    expect(() => observe(events), name).not.toThrow();
    expect(observe(events).kind, name).toBe(observation);
  });
}
