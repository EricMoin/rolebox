import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { MemoryStore } from "./store.ts";
import type { MemoryEntry } from "./types.ts";

function sourceSessions(sessions: string[] | undefined, currentSession: string): string[] {
  return [...new Set([...(sessions ?? []), currentSession].filter(Boolean))];
}

// ── memory_write ─────────────────────────────────────────────────────────

export function createMemoryWriteTool() {
  return defineTool({
    description:
      "Persist durable decisions, preferences, facts, or lessons for later sessions. " +
      "When available and authorized, use memory_recall and memory_read to check for an existing entry, and memory_update for a supported revision. " +
      "Keep conflicting conclusions separate until resolved. Do not store secrets or temporary task progress. " +
      "Returns the new memory ID on success.",
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
      source_sessions: z.array(z.string().min(1)).optional()
        .describe("Sessions supporting this memory; the current session is also recorded automatically"),
    },
    async execute(input, context) {
      if (input.scope === "role" && !context.agent) {
        return "Cannot write role-scoped memory without an active role. Select a role or use scope=workspace for shared knowledge.";
      }
      const store = await MemoryStore.create(context.directory);
      try {
        const id = store.write({
          title: input.title,
          content: input.content,
          category: input.category,
          scope: input.scope,
          role_id:
            input.scope === "workspace" ? "shared" : context.agent!,
          tags: input.tags ?? [],
          relevance: input.relevance,
          session_id: context.sessionID,
          source_sessions: sourceSessions(input.source_sessions, context.sessionID),
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
  return defineTool({
    description:
      "Search workspace and current-role memories before repeating research, choosing an approach, or writing a memory. " +
      "Use concrete keywords in the full-text query. Markdown returns ranked previews. Read full content before relying on a result: " +
      "use format=json, or memory_read(id) when available and authorized. An empty result is not proof that no relevant memory exists.",
    args: {
      query: z.string().min(1).describe("Keywords or an FTS query; invalid FTS syntax falls back to literal terms that must all match"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("Output format: 'markdown' for human-readable, 'json' for machine parsing"),
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
      const store = await MemoryStore.create(context.directory);
      try {
        const results = store.search({
          query: input.query,
          roleId: context.agent ?? "",
          scope: input.scope,
          category: input.category,
          limit: input.limit,
        });
        for (const r of results) {
          store.touch(r.id);
        }
        if (input.format === "json") {
          return JSON.stringify(results, null, 2);
        }
        if (results.length === 0) {
          return `No memories found matching "${input.query}".`;
        }

        return results
          .map(
            (r) =>
              `ID: ${r.id}\nTitle: ${r.title}\nScope: ${r.scope} | Category: ${r.category} | Relevance: ${r.relevance}\n${r.content.slice(0, 200)}${r.content.length > 200 ? "...\nFor full content use format=json, or memory_read with this ID when available and authorized." : ""}`,
          )
          .join("\n---\n");
      } finally {
        store.close();
      }
    },
  });
}

export function createMemoryReadTool() {
  return defineTool({
    description:
      "Read a workspace or current-role memory by ID, including its complete content and source sessions. " +
      "Read an ID from supplied context or from memory_recall/memory_list when those tools are available and authorized. " +
      "Before relying on or revising an entry, check whether it still applies to the current task.",
    args: {
      id: z.string().min(1).describe("Memory ID from memory_recall or memory_list"),
      format: z.enum(["markdown", "json"]).optional().describe("Output format; defaults to markdown"),
    },
    async execute(input, context) {
      const store = await MemoryStore.create(context.directory);
      try {
        const entry = store.read(input.id, context.agent ?? "");
        if (!entry) return input.format === "json" ? "null" : `Memory ID ${input.id} not found.`;
        store.touch(entry.id);
        if (input.format === "json") return JSON.stringify(entry, null, 2);
        return `ID: ${entry.id}\nTitle: ${entry.title}\nScope: ${entry.scope} | Category: ${entry.category} | Relevance: ${entry.relevance}\nSource sessions: ${entry.source_sessions.join(", ")}\n\n${entry.content}`;
      } finally {
        store.close();
      }
    },
  });
}

// ── memory_list ───────────────────────────────────────────────────────────

export function createMemoryListTool() {
  return defineTool({
    description:
      "Browse workspace and current-role memory summaries when you have no search keywords or are consolidating sessions. " +
      "Returns IDs, scope, source_sessions, titles and update dates; use memory_read for content when available and authorized. " +
      "Use format=json and paginate with offset to inspect provenance before consolidating more sessions.",
    args: {
      format: z.enum(["markdown", "json"]).optional().describe("Output format; defaults to markdown"),
      scope: z
        .enum(["workspace", "role", "both"])
        .optional()
        .default("both"),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).optional().describe("Skip this many summaries for pagination; defaults to 0"),
      sort: z
        .enum(["recent", "relevance", "accessed"])
        .optional()
        .default("recent"),
    },
    async execute(input, context) {
      const store = await MemoryStore.create(context.directory);
      try {
        const summaries = store.list({
          roleId: context.agent ?? "",
          scope: input.scope,
          category: input.category,
          limit: input.limit,
          offset: input.offset,
          sort: input.sort,
        });
        if (input.format === "json") return JSON.stringify(summaries, null, 2);
        if (summaries.length === 0) {
          return "No memories found.";
        }
        return summaries
          .map(
            (s) =>
              `- ${s.title} [${s.category}] (${s.relevance}) — ${s.updated_at} | ID: ${s.id} | Scope: ${s.scope} | Source sessions: ${s.source_sessions.join(", ")}`,
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
  return defineTool({
    description:
      "Revise a workspace or current-role memory whose existing content is known; read it with memory_read first when available and authorized. " +
      "Only provided fields change; source sessions are merged. " +
      "Preserve useful context and provenance. Do not replace a different conclusion merely because keywords match. " +
      "Returns a confirmation message with the updated memory ID.",
    args: {
      id: z.string().describe("Memory ID to update"),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).optional(),
      category: z
        .enum(["decision", "preference", "fact", "lesson", "note"])
        .optional(),
      tags: z.array(z.string()).optional(),
      relevance: z
        .enum(["high", "medium", "low"])
        .optional(),
      source_sessions: z.array(z.string().min(1)).optional()
        .describe("Additional supporting sessions; merged with existing sources and the current session"),
    },
    async execute(input, context) {
      const store = await MemoryStore.create(context.directory);
      try {
        const updates: Partial<MemoryEntry> = {
          source_sessions: sourceSessions(input.source_sessions, context.sessionID),
        };
        if (input.title !== undefined) updates.title = input.title;
        if (input.content !== undefined) updates.content = input.content;
        if (input.category !== undefined) updates.category = input.category;
        if (input.tags !== undefined) updates.tags = input.tags;
        if (input.relevance !== undefined) updates.relevance = input.relevance;
        if (!store.update(input.id, updates, context.agent ?? "")) {
          return `Memory ID ${input.id} not found — nothing updated`;
        }
        return `Memory ${input.id} updated.`;
      } finally {
        store.close();
      }
    },
  });
}
