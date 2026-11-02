import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { LlmAdapter, ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { installDshGraphWorkerBoundary, type DshGraphWorkerRegistry } from "../../../../src/platform/adapters/dsh/graph-worker.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Request = Parameters<LlmAdapter["stream"]>[0];

function toolCall(name: string, argumentsText = "{}"): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "block-end", index: 0, block: {
      type: "tool-call", id: ToolCallId(`call-${name}`), name, arguments: argumentsText,
    } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function malformed(name: string, argumentsText: string): StreamChunk {
  return { type: "finish", reason: { kind: "error", failure: {
    code: "MALFORMED_RESPONSE",
    message: `Tool call "${name}": Expected ',' or '}' after property value in JSON at position 11000 (line 1 column 11001)\n\nReceived arguments:\n${argumentsText}`,
  } } };
}

async function fixture(script: (request: Request, index: number) => readonly StreamChunk[], worker = true) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime, AgentLoop]) {
    await ctx.plugin(plugin as never, {} as never);
  }
  const requests: Request[] = [];
  class ScriptedAdapter extends LlmAdapter {
    async *stream(request: Request): AsyncIterable<StreamChunk> {
      requests.push(request);
      yield* script(request, requests.length - 1);
    }
  }
  ctx.llm.registerAdapter(["example-provider"], new ScriptedAdapter());
  let edits = 0;
  const submissions: unknown[] = [];
  ctx.tools.register({
    name: "edit_fixture", description: "Apply the assigned edit", parameters: {},
    output: { schema: {}, render: () => [{ type: "text", text: "Edit applied" }] },
    async execute() { edits++; return "Edit applied"; },
  });
  ctx.tools.register({
    name: "graph_submit_outcome", description: "Submit the completed outcome", parameters: {},
    output: { schema: {}, render: () => [{ type: "text", text: '{"decision":"accepted"}' }] },
    async execute(args, execution) {
      submissions.push(args);
      execution.concludeTurn();
      return { decision: "accepted" };
    },
  });
  const boundary = installDshGraphWorkerBoundary(
    { workerPrincipalOf: () => undefined },
    ctx.tools as unknown as DshGraphWorkerRegistry,
    (event, listener) => ctx.on(event as never, listener as never),
  );
  cleanups.push(() => boundary.dispose());
  const create = () => ctx.agents.create({
    sessionId: SessionId("outcome-repair-worker"),
    agentOptions: { provider: "example-provider", model: "example-model" },
  });
  const handle = worker ? await boundary.start("outcome-repair-attempt", create) : await create();
  cleanups.push(() => handle.dispose());
  handle.agent.followup({
    id: "assigned-task" as never, role: "user", source: { kind: "user" },
    content: [{ type: "text", text: "Apply the assigned edit, then submit its outcome." }],
  });
  await handle.agent.whenIdle();
  return { ctx, agent: handle.agent, requests, submissions, edits: () => edits };
}

describe("DSH outcome argument repair through the installed agent loop", () => {
  it("repairs only the failed submission in the same worker turn after lengthy work", async () => {
    const report = "Completed work details. ".repeat(600) + "Retain the final findings.";
    const draft = '{"graph_id":"repair-graph","node_id":"work","outcome_id":"done",' +
      '"credential":"fixture-credential","data":{"report":"' + report + ' Unescaped "quote"."}}';
    expect(() => JSON.parse(draft)).toThrow();
    const accepted = { graph_id: "repair-graph", node_id: "work", outcome_id: "done",
      credential: "fixture-credential", data: { report } };
    const f = await fixture((_request, index) => {
      if (index === 0) return toolCall("edit_fixture");
      if (index === 1) return [malformed("graph_submit_outcome", draft)];
      return toolCall("graph_submit_outcome", JSON.stringify(accepted));
    });

    expect(f.requests).toHaveLength(3);
    const repair = f.requests[2]!.messages.filter(message => message.role === "user").at(-1)!;
    const repairText = JSON.stringify(repair.content);
    expect(repairText).toContain("Repair only the graph_submit_outcome JSON arguments");
    expect(repairText).toContain("Retain the final findings.");
    expect(repairText).not.toContain("fixture-credential");
    expect(f.edits()).toBe(1);
    expect(f.submissions).toEqual([accepted]);
    expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent);
    const events = f.agent.session.snapshotEvents();
    expect(events.filter(event => event.type === "turn/start")).toHaveLength(1);
    expect(events.filter(event => event.type === "turn/end").map(event => event.data.reason.kind)).toEqual(["completed"]);
    expect(events.filter(event => event.type === "assistant/attempt")).toHaveLength(1);
  });

  it("bounds malformed-submission repair attempts without executing the task again", async () => {
    const f = await fixture((_request, index) => index === 0
      ? toolCall("edit_fixture")
      : [malformed("graph_submit_outcome", '{"data":"unfinished')]);
    expect(f.requests).toHaveLength(4);
    expect(f.edits()).toBe(1);
    expect(f.submissions).toEqual([]);
    expect(f.agent.session.snapshotEvents().filter(event => event.type === "turn/end")
      .map(event => event.data.reason.kind)).toEqual(["error"]);
  });

  it.each([
    { tool: "edit_fixture", worker: true },
    { tool: "graph_submit_outcome", worker: false },
  ])("does not retry $tool format errors for worker=$worker", async ({ tool, worker }) => {
    const f = await fixture(() => [malformed(tool, '{"data":"unfinished')], worker);
    expect(f.requests).toHaveLength(1);
    expect(f.edits()).toBe(0);
    expect(f.submissions).toEqual([]);
    expect(f.agent.session.snapshotEvents().filter(event => event.type === "turn/end")
      .map(event => event.data.reason.kind)).toEqual(["error"]);
  });
});
