import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { MemoryStore } from "./store.ts";

// ── memory_write ─────────────────────────────────────────────────────────

export function createMemoryWriteTool() {
  return tool({
    description:
      "Write a new memory entry to persistent storage. Memories persist across sessions for future recall.",
    args: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short title for this memory"),
      content: z.string().min(1).describe("Memory content in Markdown"),
      category: z
        .enum(["decision", "preference", "fact", "lesson", "note"])
        .optional()
        .default("note"),
      scope: z
        .enum(["workspace", "role"])
        .optional()
        .default("role")
        .describe("workspace=shared, role=private to current role"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization"),
      relevance: z
        .enum(["high", "medium", "low"])
        .optional()
        .default("medium"),
    },
    async execute(input, context) {
      const store = new MemoryStore(context.directory);
      try {
        const id = store.write({
          title: input.title,
          content: input.content,
          category: input.category,
          scope: input.scope,
          role_id:
            input.scope === "workspace" ? "shared" : (context.agent ?? "unknown"),
          tags: input.tags ?? [],
          relevance: input.relevance,
          session_id: context.sessionID,
          source_sessions: [],
        });
        return `Memory written. ID: ${id}`;
      } finally {
        store.close();
      }
    },
  });
}

// ── memory_recall ─────────────────────────────────────────────────────────

export function createMemoryRecallTool() {
  return tool({
    description:
      "Search memories by full-text query with optional filters. Returns ranked results.",
    args: {
      query: z.string().min(1).describe("Full-text search query"),
      scope: z
        .enum(["workspace", "role", "both"])
        .optional()
        .default("both"),
      category: z.string().optional().describe("Filter by category"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results"),
    },
    async execute(input, context) {
      const store = new MemoryStore(context.directory);
      try {
        const results = store.search({
          query: input.query,
          scope: input.scope,
          category: input.category,
          limit: input.limit,
        });
        for (const r of results) {
          store.touch(r.id);
        }
        if (results.length === 0) {
          return `No memories found matching "${input.query}".`;
        }
        return results
          .map(
            (r) =>
              `ID: ${r.id}\nTitle: ${r.title}\nCategory: ${r.category} | Relevance: ${r.relevance}\n${r.content.slice(0, 200)}...`,
          )
          .join("\n---\n");
      } finally {
        store.close();
      }
    },
  });
}

// ── memory_list ───────────────────────────────────────────────────────────

export function createMemoryListTool() {
  return tool({
    description:
      "List memory summaries for browsing or system prompt injection.",
    args: {
      scope: z
        .enum(["workspace", "role", "both"])
        .optional()
        .default("both"),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      sort: z
        .enum(["recent", "relevance", "accessed"])
        .optional()
        .default("recent"),
    },
    async execute(input, context) {
      const store = new MemoryStore(context.directory);
      try {
        const summaries = store.list({
          scope: input.scope,
          category: input.category,
          limit: input.limit,
          sort: input.sort,
        });
        if (summaries.length === 0) {
          return "No memories found.";
        }
        return summaries
          .map(
            (s) =>
              `- ${s.title} [${s.category}] (${s.relevance}) — ${s.updated_at}`,
          )
          .join("\n");
      } finally {
        store.close();
      }
    },
  });
}

// ── memory_update ─────────────────────────────────────────────────────────

export function createMemoryUpdateTool() {
  return tool({
    description:
      "Update an existing memory entry. Only provided fields are changed.",
    args: {
      id: z.string().describe("Memory ID to update"),
      title: z.string().optional(),
      content: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      relevance: z.string().optional(),
    },
    async execute(input, context) {
      const store = new MemoryStore(context.directory);
      try {
        const updates: Record<string, unknown> = {};
        if (input.title !== undefined) updates.title = input.title;
        if (input.content !== undefined) updates.content = input.content;
        if (input.category !== undefined) updates.category = input.category;
        if (input.tags !== undefined) updates.tags = input.tags;
        if (input.relevance !== undefined) updates.relevance = input.relevance;
        store.update(input.id, updates as any);
        return `Memory ${input.id} updated.`;
      } finally {
        store.close();
      }
    },
  });
}
