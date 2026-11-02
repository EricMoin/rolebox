import { describe, expect, it, vi } from "vitest";
import { installDshOutcomeSubmissionRepair } from "../../../../src/platform/adapters/dsh/outcome-submission-repair.ts";
import type { DshWorkerAgent } from "../../../../src/platform/adapters/dsh/graph-worker.ts";

const draft = '{"graph_id":"review","node_id":"work","outcome_id":"done","credential":"fixture-bearer","data":{"summary":"completed" "evidence":["report.md"]}}';
const malformed = (argumentsText = draft) => ({
  code: "MALFORMED_RESPONSE",
  message: `Tool call "graph_submit_outcome": Expected ',' or '}' after property value in JSON\n\nReceived arguments:\n${argumentsText}`,
});

function fixture() {
  let listener: (...args: unknown[]) => unknown = () => { throw new Error("listener was not installed"); };
  const append = vi.fn();
  const worker: DshWorkerAgent = { session: { id: "worker", append } };
  const next = vi.fn(async () => ({ kind: "delegated" }));
  const dispose = vi.fn();
  const installed = installDshOutcomeSubmissionRepair((event, callback) => {
    expect(event).toBe("agent/request-error");
    listener = callback;
    return dispose;
  }, agent => agent === worker);
  const call = (override: Record<string, unknown> = {}) => listener({
    agent: worker, turn: 1, step: 3, signal: new AbortController().signal,
    failure: malformed(), ...override,
  }, next);
  return { worker, append, next, call, installed, dispose };
}

describe("DSH graph outcome submission repair", () => {
  it("preserves the failed outcome draft in the worker's next request without executing it", async () => {
    const f = fixture();
    expect(await f.call()).toEqual({ kind: "retry" });
    expect(f.next).not.toHaveBeenCalled();
    expect(f.append).toHaveBeenCalledTimes(1);
    const [type, message, intent] = f.append.mock.calls[0]!;
    expect(type).toBe("user/message");
    expect(intent).toEqual({ surfaceOp: "append" });
    expect(message).toMatchObject({
      id: expect.any(String), role: "user",
      source: { kind: "rolebox", form: "notice" },
      content: [{ type: "text", text: expect.any(String) }],
    });
    const text = message.content[0].text as string;
    expect(text).toContain('"summary":"completed" "evidence":["report.md"]');
    expect(text).toContain("same session and graph attempt");
    expect(text).toContain("no tools from that response executed");
    expect(text).toContain("original attempt credential");
    expect(text).not.toContain("fixture-bearer");
    expect(text).toContain('"credential":"[use original attempt credential]"');
    f.installed?.();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "RATE_LIMIT", message: malformed().message },
    { code: "MALFORMED_RESPONSE", message: malformed().message.replace('"graph_submit_outcome"', '"bash"') },
    { code: "MALFORMED_RESPONSE", message: malformed().message.replace('"graph_submit_outcome"', '"graph_submit_outcome_extra"') },
    { code: "MALFORMED_RESPONSE", message: 'Tool call "graph_submit_outcome": invalid arguments' },
    malformed(""),
    undefined,
  ])("delegates failures outside the exact outcome JSON repair case: %j", async failure => {
    const f = fixture();
    expect(await f.call({ failure })).toEqual({ kind: "delegated" });
    expect(f.next).toHaveBeenCalledOnce();
    expect(f.append).not.toHaveBeenCalled();
  });

  it("leaves parent and unrelated agents to the host's own recovery policy", async () => {
    const f = fixture();
    const otherAppend = vi.fn();
    const other: DshWorkerAgent = { session: { id: "parent", append: otherAppend } };
    expect(await f.call({ agent: other })).toEqual({ kind: "delegated" });
    expect(await f.call({ agent: undefined })).toEqual({ kind: "delegated" });
    expect(f.append).not.toHaveBeenCalled();
    expect(otherAppend).not.toHaveBeenCalled();
  });

  it("delegates when the host cannot append correction context", async () => {
    const f = fixture();
    delete f.worker.session!.append;
    expect(await f.call()).toEqual({ kind: "delegated" });
    expect(f.append).not.toHaveBeenCalled();
  });

  it("does not admit correction context after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.call({ signal: controller.signal })).toEqual({ kind: "delegated" });
    expect(f.append).not.toHaveBeenCalled();
    expect(await f.call()).toEqual({ kind: "retry" });
    expect(await f.call()).toEqual({ kind: "retry" });
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "delegates invalid turn identity %s without changing the worker session", async turn => {
      const f = fixture();
      expect(await f.call({ turn })).toEqual({ kind: "delegated" });
      expect(f.append).not.toHaveBeenCalled();
    },
  );

  it("bounds repair across steps of one turn and permits repair in the next turn", async () => {
    const f = fixture();
    expect(await f.call({ step: 3 })).toEqual({ kind: "retry" });
    expect(await f.call({ step: 4 })).toEqual({ kind: "retry" });
    expect(await f.call({ step: 5 })).toEqual({ kind: "delegated" });
    expect(f.append).toHaveBeenCalledTimes(2);
    expect(await f.call({ turn: 2, step: 1 })).toEqual({ kind: "retry" });
    const messages = f.append.mock.calls.map(call => call[1]);
    expect(new Set(messages.map(message => message.id)).size).toBe(3);
    expect(messages[2].content[0].text).toContain("Submission repair 1/2");
  });

  it("bounds the draft without truncating a submission into a different payload", async () => {
    const f = fixture();
    const largeDraft = '{"data":"' + "x".repeat(128 * 1024 - 9);
    expect(largeDraft).toHaveLength(128 * 1024);
    expect(await f.call({ failure: malformed(largeDraft + "x") })).toEqual({ kind: "delegated" });
    expect(f.append).not.toHaveBeenCalled();
    expect(await f.call({ failure: malformed(largeDraft) })).toEqual({ kind: "retry" });
    expect(f.append.mock.calls[0]![1].content[0].text).toContain(largeDraft);
  });

  it("does not claim a retry when admitting the correction fails", async () => {
    const f = fixture();
    f.append.mockImplementation(() => { throw new Error("session append failed"); });
    await expect(f.call()).rejects.toThrow("session append failed");
    expect(f.next).not.toHaveBeenCalled();
  });

  it("redacts repeated and escaped credential values without discarding outcome evidence", async () => {
    const f = fixture();
    const argumentsText = '{"credential" : "fixture-\\"bearer", "data":{"credential":"nested-fixture","evidence":"report.md"}}';
    expect(await f.call({ failure: malformed(argumentsText) })).toEqual({ kind: "retry" });
    const text = f.append.mock.calls[0]![1].content[0].text as string;
    expect(text).not.toContain("fixture-");
    expect(text).not.toContain("nested-fixture");
    expect(text).toContain('"evidence":"report.md"');
  });

  it.each([
    String.raw`{"\u0063redential":"fixture-bearer","data":{"summary":"done"}}`,
    String.raw`{"creden\u0074ial" : "fixture-bearer","data":{"summary":"done"}}`,
    '{"data":{"summary":"done"},"credential":"fixture-bearer',
    '{"data":{"summary":"done"},"credential":"fixture-bearer\\',
  ])("redacts bearer values with escaped keys or unfinished strings: %s", async argumentsText => {
    const f = fixture();
    expect(await f.call({ failure: malformed(argumentsText) })).toEqual({ kind: "retry" });
    const text = f.append.mock.calls[0]![1].content[0].text as string;
    expect(text).not.toContain("fixture-bearer");
    expect(text).toContain('"summary":"done"');
    expect(text).toContain('"[use original attempt credential]"');
  });
});
