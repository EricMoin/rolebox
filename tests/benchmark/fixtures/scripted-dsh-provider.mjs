import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const inject = ["llm", "agents"];

export async function apply(ctx, config) {
  const hostRequire = createRequire(config.runtimeAnchor);
  const { LlmAdapter } = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-llm")).href);
  class ScriptedAdapter extends LlmAdapter {
    async *stream(options) {
      if (config.mode === "loop" && options.sessionId?.startsWith("benchmark-") && !JSON.stringify(options.messages).includes('"name":"loop_start"')) {
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "block-end", index: 0, block: { type: "tool-call", id: randomUUID(), name: "loop_start", arguments: JSON.stringify({ prompt: "Complete each fixture loop round.", iterations: 2, mode: "fresh" }) } };
        yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      if (config.mode === "skill") {
        const history = JSON.stringify(options.messages);
        if (!history.includes('"name":"skill"')) {
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield { type: "block-end", index: 0, block: { type: "tool-call", id: randomUUID(), name: "skill", arguments: JSON.stringify({ name: "fixture-note" }) } };
          yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
          yield { type: "finish", reason: { kind: "tool-calls" } };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: history.includes("NATIVE_SKILL_LOADED") ? "NATIVE_SKILL_LOADED" : "Skill did not load" } };
        yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      if (config.mode === "graph") {
        const history = JSON.stringify(options.messages);
        const text = (options.messages ?? []).flatMap(message => typeof message.content === "string" ? [message.content] :
          (message.content ?? []).filter(block => block.type === "text").map(block => block.text)).join("\n");
        const graphId = text.match(/graph_id:\s+([^\s]+)/)?.[1];
        const nodeId = text.match(/node_id:\s+([^\s]+)/)?.[1];
        const credential = text.match(/credential:\s+([^\s]+)/)?.[1];
        let tool;
        let args;
        if (graphId && !history.includes('"name":"graph_submit_outcome"')) {
          tool = "graph_submit_outcome";
          args = { graph_id: graphId, node_id: nodeId, outcome_id: "done", credential,
            data: { marker: nodeId === "produce" ? "accepted-input" : "consumed-input" } };
        } else if (!graphId && !history.includes('"name":"graph_declare"')) {
          tool = "graph_declare";
          args = { declaration: { version: 3, name: "benchmark.graph", nodes: [
            { id: "produce", agent: "fixture--worker", prompt: "Produce a fixture result.", outcomes: [{ id: "done" }] },
            { id: "consume", agent: "fixture--worker", prompt: "Consume the producer result.", inputs: [{ from: "produce", outcome: "done" }], outcomes: [{ id: "done" }] },
          ], edges: [{ from: "produce", to: "consume", outcome: "done" }] } };
        }
        if (tool) {
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield { type: "block-end", index: 0, block: { type: "tool-call", id: randomUUID(), name: tool, arguments: JSON.stringify(args) } };
          yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
          yield { type: "finish", reason: { kind: "tool-calls" } };
          return;
        }
        if (!graphId && !text.includes("[GRAPH COMPLETE]")) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "Awaiting graph completion" } };
          yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
      }
      if (config.mode?.startsWith("child-") && options.sessionId?.startsWith("benchmark-")) {
        const child = await ctx.agents.create({ sessionId: `child-${randomUUID()}`,
          parentAgent: ctx.agents.get(options.sessionId), meta: { cwd: process.cwd(), parentSession: options.sessionId },
          agentOptions: { provider: "example-provider", model: "scripted" },
          setup: scope => { scope.tools.presentAs("native"); },
        });
        child.agent.followup({ role: "user", source: { kind: "user" }, id: randomUUID(), content: [{ type: "text", text: "Complete the child fixture." }] });
        try { await child.agent.whenIdle(); }
        finally {
          await child.dispose();
          await writeFile(join(process.cwd(), "child-stopped.json"), JSON.stringify({ stopped: !ctx.agents.get(child.agent.id) }));
        }
      }
      if (config.mode === "timeout" || config.mode === "child-timeout") {
        await new Promise((resolve, reject) => {
          if (options.signal?.aborted) return reject(options.signal.reason);
          options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      if (config.mode === "failure") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "FIXTURE_FAILURE", message: "Scripted request failure" } } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: config.response ?? "fixture complete" } };
      if (config.mode !== "missing-usage") yield { type: "usage", usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: config.mode === "max-tokens" ? "max-tokens" : "stop" } };
    }
  }
  ctx.llm.registerAdapter(["example-provider"], new ScriptedAdapter());
}
