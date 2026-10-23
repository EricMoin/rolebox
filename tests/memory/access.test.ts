import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MemoryStore } from "../../src/memory/store.ts";
import {
  createMemoryListTool,
  createMemoryReadTool,
  createMemoryRecallTool,
  createMemoryUpdateTool,
  createMemoryWriteTool,
} from "../../src/memory/tools.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { CanonicalToolContext, ToolResult } from "../../src/platform/types.ts";

function text(result: ToolResult): string {
  return typeof result === "string" ? result : result.output;
}

function entry(overrides: Partial<MemoryEntry> = {}) {
  return {
    scope: "role", role_id: "role-a", category: "decision", title: "Cache strategy",
    content: "Cache validated results", tags: ["cache"], relevance: "medium",
    session_id: "original-session", source_sessions: ["original-session"],
    ...overrides,
  };
}

describe("memory access and provenance", () => {
  let directory: string;
  let store: MemoryStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "rolebox-memory-access-"));
    store = await MemoryStore.create(directory);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function context(agent?: string, sessionID = "current-session"): CanonicalToolContext {
    const caller: CanonicalToolContext = { directory, worktree: directory, agent: agent ?? "", sessionID, messageID: "message",
      abort: new AbortController().signal, metadata: () => {}, ask: async () => {} };
    if (agent === undefined) Reflect.deleteProperty(caller, "agent");
    return caller;
  }

  it("intersects scope with workspace/current-role visibility for listing and search", () => {
    const shared = store.write(entry({ scope: "workspace", role_id: "shared" }));
    const own = store.write(entry());
    store.write(entry({ role_id: "role-b" }));
    store.write(entry({ role_id: "" }));

    for (const scope of ["both", "workspace", "role"]) {
      const expected = scope === "workspace" ? [shared] : scope === "role" ? [own] : [shared, own];
      expect(store.list({ roleId: "role-a", scope }).map(row => row.id).sort()).toEqual(expected.sort());
      expect(store.search({ roleId: "role-a", scope, query: "Cache" }).map(row => row.id).sort()).toEqual(expected.sort());
    }
    expect(store.list({ roleId: "" }).map(row => row.id)).toEqual([shared]);
    expect(store.search({ roleId: "", query: "Cache" }).map(row => row.id)).toEqual([shared]);
    expect(store.list({ roleId: "", scope: "role" })).toEqual([]);
    expect(store.list()).toHaveLength(4);
    expect(store.search({ query: "Cache" })).toHaveLength(4);
  });

  it("denies cross-role ID reads and updates without mutating content or provenance", () => {
    const id = store.write(entry());
    expect(store.read(id, "role-b")).toBeNull();
    expect(store.read(id, "")).toBeNull();
    expect(store.update(id, { content: "Other conclusion", source_sessions: ["other"] }, "role-b")).toBe(false);
    expect(store.update(id, { content: "Other conclusion" }, "")).toBe(false);
    expect(store.update(id, { role_id: "role-b" }, "role-a")).toBe(false);
    expect(store.read(id)).toMatchObject(entry());
    expect(store.update(id, { content: "Supported refinement" }, "role-a")).toBe(true);
    expect(store.read(id, "role-a")?.content).toBe("Supported refinement");
    expect(store.update(id, { content: "Administrative revision" })).toBe(true);
  });

  it("keeps distinct conclusions with identical titles written in the same millisecond", () => {
    const now = spyOn(Date, "now").mockReturnValue(123456789);
    try {
      const first = store.write(entry({ content: "Use a short cache lifetime" }));
      const second = store.write(entry({ content: "Use a long cache lifetime" }));
      expect(first).not.toBe(second);
      expect(store.read(first)?.content).toBe("Use a short cache lifetime");
      expect(store.read(second)?.content).toBe("Use a long cache lifetime");
    } finally {
      now.mockRestore();
    }
  });

  it("opens synchronously with the same schema and observes subsequent asynchronous writes", async () => {
    const freshDirectory = join(directory, "fresh-workspace");
    const sync = MemoryStore.open(freshDirectory);
    try {
      const first = sync.write(entry());
      const asyncStore = await MemoryStore.create(freshDirectory);
      try {
        expect(asyncStore.read(first)?.title).toBe("Cache strategy");
        const second = asyncStore.write(entry({ title: "Another cache" }));
        expect(sync.list()).toHaveLength(2);
        expect(sync.search({ query: "Another" }).map(row => row.id)).toEqual([second]);
      } finally {
        asyncStore.close();
      }
    } finally {
      sync.close();
    }
  });

  it("enforces role visibility on recall and list tools, including unidentified callers", async () => {
    const shared = store.write(entry({ scope: "workspace", role_id: "shared" }));
    const own = store.write(entry());
    store.write(entry({ role_id: "role-b" }));
    const recall = createMemoryRecallTool();
    const list = createMemoryListTool();
    for (const agent of ["role-a", undefined]) {
      const expected = agent === undefined ? [shared] : [shared, own];
      const recalled = JSON.parse(text(await recall.execute(z.object(recall.args).parse({ query: "Cache", format: "json" }), context(agent))));
      const listed = JSON.parse(text(await list.execute(z.object(list.args).parse({ format: "json" }), context(agent))));
      expect(recalled.map((row: MemoryEntry) => row.id).sort()).toEqual(expected.sort());
      expect(listed.map((row: MemoryEntry) => row.id).sort()).toEqual(expected.sort());
    }
  });

  it("returns complete memory content by ID and refuses cross-role reads and updates", async () => {
    const content = "Detailed evidence. ".repeat(100) + "Final conclusion";
    const id = store.write(entry({ content }));
    const read = createMemoryReadTool();
    const update = createMemoryUpdateTool();
    expect(text(await read.execute({ id }, context("role-a")))).toContain(content);
    const record = JSON.parse(text(await read.execute({ id, format: "json" }, context("role-a"))));
    expect(record.content).toBe(content);
    expect(record.source_sessions).toEqual(["original-session"]);
    expect(store.read(id)?.access_count).toBe(2);
    for (const agent of ["role-b", undefined]) {
      expect(await read.execute({ id, format: "json" }, context(agent))).toBe("null");
      expect(await update.execute({ id, content: "Replacement" }, context(agent))).toContain("not found");
    }
    expect(store.read(id)?.content).toBe(content);
    expect(store.read(id)?.access_count).toBe(2);
  });

  it("permits shared-memory reads and revisions without a role", async () => {
    const id = store.write(entry({ scope: "workspace", role_id: "shared" }));
    const read = createMemoryReadTool();
    expect(await read.execute({ id }, context())).toContain("Cache validated results");
    expect(await createMemoryUpdateTool().execute({ id, content: "Validated revision" }, context())).toContain("updated.");
    expect(store.read(id)?.content).toBe("Validated revision");
  });

  it("lists IDs, scope and provenance as JSON and paginates summaries without memory bodies", async () => {
    const first = store.write(entry());
    const second = store.write(entry({ title: "Second decision" }));
    const list = createMemoryListTool();
    const rows = [];
    for (const offset of [0, 1]) {
      const result = await list.execute(z.object(list.args).parse({ format: "json", limit: 1, offset }), context("role-a"));
      rows.push(...JSON.parse(text(result)));
    }
    expect(rows.map(row => row.id).sort()).toEqual([first, second].sort());
    expect(rows[0]).toMatchObject({ scope: "role", role_id: "role-a", source_sessions: ["original-session"] });
    expect(rows[0].content).toBeUndefined();
    const markdown = await list.execute(z.object(list.args).parse({}), context("role-a"));
    expect(markdown).toContain(first);
    expect(markdown).toContain("original-session");
    expect(await list.execute(z.object(list.args).parse({ format: "json", offset: 2 }), context("role-a"))).toBe("[]");
  });

  it("preserves and deduplicates source sessions on writes and successive revisions", async () => {
    const write = createMemoryWriteTool();
    const result = await write.execute(z.object(write.args).parse({
      title: "Recorded decision", content: "Original evidence", source_sessions: ["source-one", "source-one"],
    }), context("role-a", "writing-session"));
    const id = text(result).split("ID: ")[1];
    const update = createMemoryUpdateTool();
    await update.execute({ id, content: "Revised evidence", source_sessions: ["source-two", "source-one"] }, context("role-a", "revision-session"));
    await update.execute({ id, relevance: "high" }, context("role-a", "later-session"));
    expect(store.read(id)).toMatchObject({
      content: "Revised evidence", session_id: "writing-session",
      source_sessions: ["source-one", "writing-session", "source-two", "revision-session", "later-session"],
    });
    store.update(id, { source_sessions: [] }, "role-a");
    expect(store.read(id)?.source_sessions).toHaveLength(5);
  });

  it("requires an active role for private writes while allowing explicit workspace writes", async () => {
    const write = createMemoryWriteTool();
    const args = z.object(write.args).parse({ title: "Decision", content: "Validated evidence" });
    expect(await write.execute(args, context())).toContain("without an active role");
    expect(store.list()).toEqual([]);
    expect(await write.execute({ ...args, scope: "workspace" }, context())).toContain("Memory written");
    expect(store.list({ roleId: "" })).toHaveLength(1);
  });

  it("returns machine-readable empty recall results", async () => {
    const recall = createMemoryRecallTool();
    expect(await recall.execute(z.object(recall.args).parse({ query: "absent", format: "json" }), context("role-a"))).toBe("[]");
  });

  it.each(["read-only cache", "Memory: indexing", "node.js cache", 'the "quoted" decision', "unfinished (cache", "cache - refresh", "缓存: 改进"])(
    "finds a literal title containing FTS punctuation: %s", (title) => {
      const id = store.write(entry({ title }));
      store.write(entry({ title, role_id: "role-b" }));
      expect(store.search({ query: title, roleId: "role-a" }).map(row => row.id)).toEqual([id]);
    },
  );

  it("preserves explicit FTS queries and keeps fallback terms conjunctive", () => {
    const first = store.write(entry({ title: "alpha", content: "First finding", tags: [] }));
    const second = store.write(entry({ title: "beta", content: "Second finding", tags: [] }));
    expect(store.search({ query: "alpha OR beta" }).map(row => row.id).sort()).toEqual([first, second].sort());
    expect(store.search({ query: "alph*" }).map(row => row.id)).toEqual([first]);
    expect(store.search({ query: "alpha missing:term" })).toEqual([]);
    expect(store.search({ query: "-:()" })).toEqual([]);
  });
});
