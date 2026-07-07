import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { DispatchManager } from "./manager.ts";
import type { SessionClientWrapper } from "../session/client.ts";
import type { ResolvedRole } from "../types.ts";
import { MemoryStore } from "../memory/store.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("context-assemble");

interface ContextAssembleDeps {
  dispatchManager: DispatchManager;
  sessionClient: SessionClientWrapper;
  resolvedRoles: ResolvedRole[];
  directory: string;
}

export function createContextAssembleTool(deps: ContextAssembleDeps) {
  return tool({
    description:
      "Orchestrates cross-domain search across task/memory/asset/session and assembles a token-bounded context block. Searches memory, dispatch tasks, role assets (skills/functions/references), and recent session messages, then combines results into a single markdown context block truncated to fit a token budget.",
    args: {
      topic: z
        .string()
        .min(1)
        .describe("The topic/query to search across all domains"),
      max_tokens: z
        .number()
        .int()
        .min(100)
        .max(20000)
        .optional()
        .default(4000)
        .describe("Approximate token budget for assembled context"),
      sources: z
        .array(z.enum(["task", "memory", "asset", "session"]))
        .optional()
        .default(["memory", "asset", "task", "session"])
        .describe("Which domains to search"),
    },
    async execute(input) {
      const activeSources = input.sources ?? ["memory", "asset", "task", "session"];
      const maxTokens = input.max_tokens ?? 4000;
      const budgetPerSource = Math.floor(maxTokens / activeSources.length);
      const charsPerSource = budgetPerSource * 4;

      const topic = input.topic;
      const topicLower = topic.toLowerCase();

      // ── Source 1: Memory ──────────────────────────────────────────────────
      let memorySection = "";
      if (activeSources.includes("memory")) {
        try {
          const store = new MemoryStore(deps.directory);
          const results = store.search({ query: topic, limit: 5 });
          store.close();

          if (results.length > 0) {
            memorySection = "### Memory Matches\n" +
              results
                .map((r) => `- **${r.title}** [${r.category}]: ${r.content.slice(0, 200)}`)
                .join("\n");
          }
        } catch (err) {
          log.warn("memory search failed", { topic, error: String(err) });
          memorySection = "### Memory Matches\n- _(search failed)_";
        }
      }

      // ── Source 2: Task ────────────────────────────────────────────────────
      let taskSection = "";
      if (activeSources.includes("task")) {
        try {
          const allTasks = typeof (deps.dispatchManager as any).getAllTasks === "function"
            ? (deps.dispatchManager as any).getAllTasks()
            : [];

          const matchingTasks = allTasks
            .filter((t: any) => {
              const searchText = [
                t.prompt ?? "",
                t.description ?? "",
                t.agent ?? "",
              ].join(" ").toLowerCase();
              return searchText.includes(topicLower);
            })
            .sort((a: any, b: any) => b.startedAt.getTime() - a.startedAt.getTime())
            .slice(0, 5);

          if (matchingTasks.length > 0) {
            taskSection = "### Task Matches\n" +
              matchingTasks
                .map((t: any) =>
                  `- **${t.id}** (${t.agent}, ${t.status}): ${(t.description || t.prompt || "").slice(0, 150)}`,
                )
                .join("\n");
          }
        } catch (err) {
          log.warn("task search failed", { topic, error: String(err) });
          taskSection = "### Task Matches\n- _(search failed)_";
        }
      }

      // ── Source 3: Asset ───────────────────────────────────────────────────
      let assetSection = "";
      if (activeSources.includes("asset")) {
        try {
          const matches: string[] = [];
          for (const role of deps.resolvedRoles) {
            for (const skill of role.skills) {
              if (
                skill.name.toLowerCase().includes(topicLower) ||
                skill.description.toLowerCase().includes(topicLower)
              ) {
                matches.push(
                  `- Skill: ${skill.name} (role: ${role.id}) — ${skill.description}`,
                );
              }
            }
            for (const fn of role.functions) {
              if (
                fn.name.toLowerCase().includes(topicLower) ||
                fn.description.toLowerCase().includes(topicLower)
              ) {
                matches.push(
                  `- Function: ${fn.name} (role: ${role.id}) — ${fn.description}`,
                );
              }
            }
            for (const ref of role.references) {
              if (
                ref.name.toLowerCase().includes(topicLower) ||
                ref.description.toLowerCase().includes(topicLower)
              ) {
                matches.push(
                  `- Reference: ${ref.name} (role: ${role.id}) — ${ref.description}`,
                );
              }
            }
          }

          if (matches.length > 0) {
            assetSection = "### Asset Matches\n" + matches.slice(0, 10).join("\n");
          }
        } catch (err) {
          log.warn("asset search failed", { topic, error: String(err) });
          assetSection = "### Asset Matches\n- _(search failed)_";
        }
      }

      // ── Source 4: Session ─────────────────────────────────────────────────
      let sessionSection = "";
      if (activeSources.includes("session")) {
        try {
          const sessions = await deps.sessionClient.list(deps.directory);
          const recentSessions = sessions.slice(0, 5);
          const sessionMatches: string[] = [];

          for (const sess of recentSessions) {
            if (sess.title && sess.title.toLowerCase().includes(topicLower)) {
              sessionMatches.push(`- Session: ${sess.title} (${sess.id})`);
              continue;
            }

            // Search messages content
            const msgs = await deps.sessionClient.messages(sess.id, {
              directory: deps.directory,
              limit: 20,
            });

            for (const msg of msgs) {
              for (const part of msg.parts) {
                if (part.type === "text" && (part as any).text) {
                  const text = (part as any).text as string;
                  if (text.toLowerCase().includes(topicLower)) {
                    const snippet = text.slice(0, 150);
                    sessionMatches.push(
                      `- Session: ${sess.title || sess.id} — "${snippet}..."`,
                    );
                    break;
                  }
                }
              }
              if (sessionMatches.length >= 5) break;
            }
            if (sessionMatches.length >= 5) break;
          }

          if (sessionMatches.length > 0) {
            sessionSection = "### Session Matches\n" + sessionMatches.join("\n");
          }
        } catch (err) {
          log.warn("session search failed", { topic, error: String(err) });
          sessionSection = "### Session Matches\n- _(search failed)_";
        }
      }

      // ── Truncate each section to budget ───────────────────────────────────
      const truncate = (text: string, maxChars: number): string => {
        if (text.length <= maxChars) return text;
        return text.slice(0, maxChars) + "\n\n_(truncated to fit token budget)_";
      };

      memorySection = truncate(memorySection, charsPerSource);
      taskSection = truncate(taskSection, charsPerSource);
      assetSection = truncate(assetSection, charsPerSource);
      sessionSection = truncate(sessionSection, charsPerSource);

      // ── Check if anything was found ───────────────────────────────────────
      const allEmpty = [memorySection, taskSection, assetSection, sessionSection]
        .every((s) => s.length === 0 || s.includes("_(search failed)_"));

      if (allEmpty) {
        return `No matches found for '${topic}' across any source.`;
      }

      // ── Assemble final block ──────────────────────────────────────────────
      const parts: string[] = [
        "## Assembled Context",
        "",
        `**Topic:** ${topic}`,
        `**Budget:** ${maxTokens} tokens (${activeSources.length} sources, ~${budgetPerSource} tokens each)`,
        `**Sources:** ${activeSources.join(", ")}`,
        "",
        "---",
        "",
      ];

      if (activeSources.includes("memory") && memorySection) {
        parts.push(memorySection);
        parts.push("");
        parts.push("---");
        parts.push("");
      }

      if (activeSources.includes("task") && taskSection) {
        parts.push(taskSection);
        parts.push("");
        parts.push("---");
        parts.push("");
      }

      if (activeSources.includes("asset") && assetSection) {
        parts.push(assetSection);
        parts.push("");
        parts.push("---");
        parts.push("");
      }

      if (activeSources.includes("session") && sessionSection) {
        parts.push(sessionSection);
        parts.push("");
        parts.push("---");
        parts.push("");
      }

      return parts.join("\n");
    },
  });
}
