import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, createMemorySink } from "../../src/log/index.ts";
import { buildMemoryContext } from "../../src/memory/context.ts";
import { MemoryStore, type MemoryListSummary } from "../../src/memory/store.ts";
import type { MemoryConfig } from "../../src/memory/types.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

const allTools = ["memory_recall", "memory_read", "memory_list", "memory_write", "memory_update"];
const summary: MemoryListSummary = {
  id: "known-memory",
  scope: "workspace",
  role_id: "shared",
  source_sessions: [],
  title: "Use the project formatter",
  category: "lesson",
  relevance: "high",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("buildMemoryContext", () => {
  it("returns no context or data when no memory capability is authorized", () => {
    const list = vi.fn(() => [summary]);
    for (const tools of [[], ["web_search"], ["memory_*"], ["memory_unknown"], ["session_list", "session_read"]]) {
      expect(buildMemoryContext({ roleId: "reviewer", tools, store: { list } })).toBe("");
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps the workflow available when the store is empty or absent", () => {
    const absent = buildMemoryContext({ roleId: "reviewer", tools: allTools });
    const empty = buildMemoryContext({ roleId: "reviewer", tools: allTools, store: { list: () => [] } });
    expect(empty).toBe(absent);
    expect(empty).toContain("## Memory workflow");
    expect(empty).toContain("Before planning");
    expect(empty).toContain("memory_read");
    expect(empty).toContain("instead of creating a duplicate");
    expect(empty).toContain("Verify old conclusions");
    expect(empty).toContain("credentials");
    expect(empty).toContain("do not claim the memory was saved");
    expect(empty).not.toContain("## Available memory");
  });

  it("never instructs any unavailable memory tool for every capability combination", () => {
    for (let mask = 1; mask < 1 << allTools.length; mask++) {
      const tools = allTools.filter((_, index) => mask & (1 << index));
      const context = buildMemoryContext({ roleId: "reviewer", tools, store: { list: () => [summary] } });
      const mentioned = new Set(context.match(/memory_(?:recall|read|list|write|update)/g));
      for (const tool of mentioned) expect(tools).toContain(tool);
      for (const tool of tools) expect(mentioned.has(tool)).toBe(true);
    }
  });

  it("does not retrieve or reveal summaries to a write-only worker", () => {
    const list = vi.fn(() => [summary]);
    const context = buildMemoryContext({ roleId: "writer", tools: ["memory_write"], store: { list } });
    expect(list).not.toHaveBeenCalled();
    expect(context).toContain("memory_write");
    expect(context).toContain("Avoid duplicating an entry whose ID is already known");
    expect(context).not.toContain(summary.id);
    expect(context).not.toContain("memory_recall");
    expect(context).not.toContain("memory_read");
    expect(context).not.toContain("memory_update");
  });

  it("supports browsing, reading by ID, and updating independently", () => {
    const browsing = buildMemoryContext({ roleId: "reviewer", tools: ["memory_list"] });
    expect(browsing).toContain("use memory_list to browse");
    const reading = buildMemoryContext({ roleId: "reviewer", tools: ["memory_read"] });
    expect(reading).toContain("When a relevant memory ID is known");
    expect(reading).not.toContain("Persist only");
    const updating = buildMemoryContext({ roleId: "reviewer", tools: ["memory_update"] });
    expect(updating).toContain("memory_update with a known ID");
    expect(updating).not.toContain("memory_write");
    expect(updating).not.toContain("before writing");
  });

  it("provides an explicit consolidation workflow with paged provenance and session evidence", () => {
    const context = buildMemoryContext({ roleId: "reviewer", tools: [...allTools, "session_list", "session_read"] });
    expect(context).toContain("Only when the user explicitly requests session consolidation");
    expect(context).toContain('memory_list(format="json", limit=100, offset=0)');
    expect(context).toContain("advancing offset by 100 until a page has fewer than 100 entries");
    expect(context).toContain("session_list to select sessions within the requested scope");
    expect(context).toContain("session_read to examine their evidence");
    expect(context).toContain("memory_write or memory_update");
    expect(context).toContain("passing the reviewed session IDs as source_sessions");
    expect(context).toContain("Source attribution does not prove a session was fully processed");
  });

  it("never enables consolidation without its session, reading, and persistence capabilities", () => {
    const cases = [
      allTools,
      [...allTools, "session_list"],
      [...allTools, "session_read"],
      ["memory_write", "session_list", "session_read"],
      ["memory_recall", "memory_read", "memory_list", "session_list", "session_read"],
    ];
    for (const tools of cases) {
      const context = buildMemoryContext({ roleId: "reviewer", tools });
      expect(context).not.toContain("session consolidation");
      expect(context).not.toContain("session_list");
      expect(context).not.toContain("session_read");
    }
  });

  it("clips consolidation instructions to granted tools across all memory capability combinations", () => {
    for (let mask = 1; mask < 1 << allTools.length; mask++) {
      const tools = [...allTools.filter((_, index) => mask & (1 << index)), "session_list", "session_read"];
      const context = buildMemoryContext({ roleId: "reviewer", tools });
      const mentioned = new Set(context.match(/(?:memory_(?:recall|read|list|write|update)|session_(?:list|read))/g));
      for (const tool of mentioned) expect(tools).toContain(tool);
    }
    const limited = buildMemoryContext({ roleId: "reviewer", tools: ["memory_list", "memory_update", "session_list", "session_read"] });
    expect(limited).toContain("Do not replace an existing body when its full content is unavailable");
    expect(limited).not.toContain("memory_write");
    expect(limited).not.toContain("memory_recall");
    expect(limited).not.toContain("memory_read");
  });

  it("passes the current role and default injection filters to the store", () => {
    const list = vi.fn(() => [summary]);
    const context = buildMemoryContext({ roleId: "reviewer", tools: ["memory_read"], store: { list } });
    expect(list).toHaveBeenCalledWith({ roleId: "reviewer", scope: "both", limit: 10, minRelevance: "medium" });
    expect(context).toContain("## Available memory");
    expect(context).toContain(`| ${summary.id} | lesson | high | ${summary.title} | ${summary.updated_at} |`);
    expect(context).not.toContain("memory_recall");
  });

  it("honors configured scope, limit, and relevance without changing workflow", () => {
    const list = vi.fn(() => [summary]);
    buildMemoryContext({
      roleId: "author",
      tools: ["memory_recall"],
      store: { list },
      config: { scope: "role", max_inject: 3, min_relevance: "high" },
    });
    expect(list).toHaveBeenCalledWith({ roleId: "author", scope: "role", limit: 3, minRelevance: "high" });
  });

  it("turns off only automatic summaries for inject=false or max_inject=0", () => {
    const configs: MemoryConfig[] = [{ inject: false }, { max_inject: 0 }];
    for (const config of configs) {
      const list = vi.fn(() => [summary]);
      const context = buildMemoryContext({ roleId: "reviewer", tools: allTools, config, store: { list } });
      expect(list).not.toHaveBeenCalled();
      expect(context).toContain("Before planning");
      expect(context).toContain("memory_write");
      expect(context).not.toContain(summary.id);
    }
  });

  it("routes deferred capabilities through their actual presentation", () => {
    const native = buildMemoryContext({ roleId: "reviewer", tools: ["memory_recall"] });
    expect(native).not.toContain("graph_worker_");
    const discover = buildMemoryContext({ roleId: "reviewer", tools: ["memory_recall"], presentation: "discover" });
    expect(discover).toContain('graph_worker_tools(action="describe"');
    expect(discover).not.toContain('graph_worker_tools(action="call"');
    expect(discover).toContain("native tool only after describe has exposed the schema");
    expect(discover).not.toContain("graph_worker_code");
    const discoveryCall = buildMemoryContext({ roleId: "reviewer", tools: ["memory_recall"], presentation: "discover", discoverInvocation: "call" });
    expect(discoveryCall).toContain('graph_worker_tools(action="describe"');
    expect(discoveryCall).toContain('graph_worker_tools(action="call"');
    expect(discoveryCall).toContain("not direct tool calls");
    const code = buildMemoryContext({ roleId: "reviewer", tools: ["memory_recall"], presentation: "code" });
    expect(code).toContain('graph_worker_tools(action="describe"');
    expect(code).toContain("graph_worker_code with await tools.call(name, args)");
    expect(code).toContain("not direct tool calls");
  });

  it("requires workspace scope when writing without an active role", () => {
    const context = buildMemoryContext({ roleId: "", tools: ["memory_write"] });
    expect(context).toContain('pass scope="workspace" when writing');
    expect(context).not.toContain("role for role-specific lessons");
  });

  it("escapes summary cells using the shared prompt renderer", () => {
    const context = buildMemoryContext({
      roleId: "reviewer",
      tools: ["memory_read"],
      store: { list: () => [{ ...summary, title: "Keep | separators\ninside the title" }] },
    });
    expect(context).toContain("Keep \\| separators inside the title");
  });

  it("preserves workflow and logs a store failure without aborting the prompt", () => {
    const state = beginLogTest();
    try {
      const memory = createMemorySink({ capacity: 10 });
      configureLogging({ sinks: [memory], level: "debug" });
      const context = buildMemoryContext({
        roleId: "reviewer",
        tools: allTools,
        store: { list: () => { throw new Error("database unavailable"); } },
      });
      expect(context).toContain("## Memory workflow");
      expect(context).not.toContain("## Available memory");
      expect(memory.last()?.code).toBe("sys-xform.memory-inject-failed");
      expect(memory.last()?.scope.agent).toBe("reviewer");
      expect(memory.last()?.fields.error).toBe("Error: database unavailable");
    } finally {
      endLogTest(state);
    }
  });

  it("injects only the current role and shared workspace memories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-memory-context-"));
    let store: MemoryStore | undefined;
    try {
      store = await MemoryStore.create(dir);
      for (const [roleId, scope, title] of [
        ["reviewer", "role", "Reviewer lesson"],
        ["author", "role", "Author private lesson"],
        ["shared", "workspace", "Shared project decision"],
      ]) {
        store.write({
          role_id: roleId!, scope: scope!, title: title!, category: "lesson", content: "Verified finding",
          relevance: "high", tags: [], session_id: null, source_sessions: [],
        });
      }
      const context = buildMemoryContext({ roleId: "reviewer", tools: ["memory_read"], store });
      expect(context).toContain("Reviewer lesson");
      expect(context).toContain("Shared project decision");
      expect(context).not.toContain("Author private lesson");
      const roleOnly = buildMemoryContext({ roleId: "reviewer", tools: ["memory_read"], store, config: { scope: "role" } });
      expect(roleOnly).toContain("Reviewer lesson");
      expect(roleOnly).not.toContain("Shared project decision");
      expect(roleOnly).not.toContain("Author private lesson");
      const withoutRole = buildMemoryContext({ roleId: "", tools: ["memory_read"], store });
      expect(withoutRole).toContain("Shared project decision");
      expect(withoutRole).not.toContain("Reviewer lesson");
      expect(withoutRole).not.toContain("Author private lesson");
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
