import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { ResolvedRole, ResolvedReference } from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("search:reference");

interface RefEntry {
  name: string;
  description: string;
  filePath: string;
  roleId: string;
  scope: string;
}

function collectReferences(roles: ResolvedRole[]): RefEntry[] {
  const refs: RefEntry[] = [];
  const seen = new Set<string>(); // dedupe by filePath

  for (const role of roles) {
    for (const ref of role.references) {
      if (!seen.has(ref.filePath)) {
        seen.add(ref.filePath);
        refs.push({
          name: ref.name,
          description: ref.description,
          filePath: ref.filePath,
          roleId: role.id,
          scope: ref.scope,
        });
      }
    }
    // Collect from subagents
    collectSubagentReferences(role.subagents, role.id, refs, seen);
  }

  return refs;
}

function collectSubagentReferences(
  subagents: ResolvedRole["subagents"],
  parentRoleId: string,
  refs: RefEntry[],
  seen: Set<string>,
): void {
  for (const sub of subagents) {
    for (const ref of sub.references) {
      if (!seen.has(ref.filePath)) {
        seen.add(ref.filePath);
        refs.push({
          name: ref.name,
          description: ref.description,
          filePath: ref.filePath,
          roleId: `${parentRoleId}/${sub.id}`,
          scope: ref.scope,
        });
      }
    }
    if (sub.subagents && sub.subagents.length > 0) {
      collectSubagentReferences(sub.subagents, `${parentRoleId}/${sub.id}`, refs, seen);
    }
  }
}

interface SearchMatch {
  refName: string;
  roleId: string;
  filePath: string;
  lineNumber: number;
  matchedLine: string;
  contextBefore: string[];
  contextAfter: string[];
}

async function searchInFile(
  filePath: string,
  query: string,
  caseSensitive: boolean,
  contextLines: number,
): Promise<SearchMatch[]> {
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch (err) {
    log.debug("Failed to read reference file", { filePath, error: String(err) });
    return [];
  }

  const lines = content.split("\n");
  const matches: SearchMatch[] = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
    if (line.includes(searchQuery)) {
      const contextStart = Math.max(0, i - contextLines);
      const contextEnd = Math.min(lines.length, i + contextLines + 1);
      matches.push({
        refName: "",
        roleId: "",
        filePath,
        lineNumber: i + 1,
        matchedLine: lines[i],
        contextBefore: lines.slice(contextStart, i),
        contextAfter: lines.slice(i + 1, contextEnd),
      });
    }
  }

  return matches;
}

export function createReferenceSearchTool(roles: ResolvedRole[]) {
  const allRefs = collectReferences(roles);

  return tool({
    description:
      "Full-text search across all reference documents (markdown files) loaded by resolved roles and sub-agents. Searches file contents, not just metadata. Returns matched lines with surrounding context. Use this to find specific knowledge within reference documents.",
    args: {
      query: z
        .string()
        .min(1)
        .describe("Full-text search query (substring match)"),
      case_sensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Case-sensitive search (default false)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max matches to return (default 10)"),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(2)
        .describe("Lines of context before and after each match (default 2)"),
      role_id: z
        .string()
        .optional()
        .describe("Limit search to references of a specific role"),
    },
    async execute(input) {
      if (allRefs.length === 0) {
        return "No reference documents found. Make sure roles have references loaded.";
      }

      // Filter by role_id if specified
      let refs = allRefs;
      if (input.role_id) {
        refs = refs.filter((r) => r.roleId === input.role_id || r.roleId.startsWith(input.role_id + "/"));
      }

      // Search all reference files in parallel
      const searchPromises = refs.map(async (ref) => {
        const matches = await searchInFile(
          ref.filePath,
          input.query,
          input.case_sensitive ?? false,
          input.context_lines ?? 2,
        );
        // Attach ref metadata to each match
        return matches.map((m) => ({
          ...m,
          refName: ref.name,
          roleId: ref.roleId,
        }));
      });

      const resultsPerFile = await Promise.all(searchPromises);
      const allMatches = resultsPerFile.flat();

      if (allMatches.length === 0) {
        return `No matches for "${input.query}" in reference documents.`;
      }

      // Sort by file, then by line number
      allMatches.sort((a, b) => {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return a.lineNumber - b.lineNumber;
      });

      const limited = allMatches.slice(0, input.limit ?? 10);

      // Format output
      const sections = limited.map((m) => {
        const lines: string[] = [];
        lines.push(`### ${m.refName} (${m.roleId})`);
        lines.push(`File: ${m.filePath}:${m.lineNumber}`);
        lines.push("");
        // Context before
        for (const line of m.contextBefore) {
          lines.push(`  ${line}`);
        }
        // Matched line (bolded with **)
        lines.push(`> **${m.matchedLine}**`);
        // Context after
        for (const line of m.contextAfter) {
          lines.push(`  ${line}`);
        }
        lines.push("");
        return lines.join("\n");
      });

      const header = `## Reference Search Results: "${input.query}"\n\nFound ${allMatches.length} match(es)${allMatches.length > limited.length ? ` (showing first ${limited.length})` : ""} across ${new Set(limited.map((m) => m.filePath)).size} file(s).\n`;

      return header + sections.join("---\n");
    },
  });
}
