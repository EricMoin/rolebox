import { defineTool } from "../platform/ports/tool-factory.ts";
import { visibleRolesForAgent } from "../resolver/role-visibility.ts";
import { readTextFile } from "../utils/fs.ts";
import { formatError } from "../logger.ts";
import type { ResolvedReference, ResolvedRole, ResolvedSubAgent } from "../types.ts";
import { z } from "zod";

export interface LoadedReferencePayload {
  name: string;
  description: string;
  scope: ResolvedReference["scope"];
  path: string;
  relativePath: string;
  content: string;
}

interface ReferenceMatch {
  reference: ResolvedReference;
  ownerId: string;
}

function* referencesIn(
  agents: readonly (ResolvedRole | ResolvedSubAgent)[],
  parentId?: string,
): Generator<ReferenceMatch> {
  for (const agent of agents) {
    const ownerId = parentId ? `${parentId}/${agent.id}` : agent.id;
    yield* referencesIn(agent.subagents, ownerId);
    for (const reference of [...agent.references, ...agent.skills.flatMap(skill => skill.references)]) {
      yield { reference, ownerId };
    }
  }
}

/** Load an exact reference name within the skill loader's role visibility and deepest-first precedence. */
export function createLoadReferenceTool(resolvedRoles: ResolvedRole[]) {
  return defineTool({
    description: "Load a reference by exact name from the current role's visible resources, including role and skill references in its nested sub-agents (deepest-first priority). Returns full content and resolved path metadata. Other roles' private references are unavailable. Not-found errors list only visible reference names.",
    args: {
      name: z.string().min(1).describe("Exact name of the reference to load, as listed in the role or skill resources"),
    },
    async execute(input, context) {
      if (resolvedRoles.length === 0) return "No roles loaded. Cannot load references.";
      const matches = [...referencesIn(visibleRolesForAgent(resolvedRoles, context?.agent))];
      const match = matches.find(({ reference }) => reference.name === input.name);
      if (!match) {
        const available = [...new Set(matches.map(({ reference }) => reference.name))].sort();
        return `Reference not found: no visible reference named "${input.name}".\nAvailable references: ${available.join(", ") || "(none)"}`;
      }
      const { reference, ownerId } = match;
      let content: string;
      try {
        content = await readTextFile(reference.filePath);
      } catch (error) {
        return `Reference "${reference.name}" resolved to "${reference.filePath}" but its file could not be loaded: ${formatError(error).message}`;
      }
      const payload: LoadedReferencePayload = {
        name: reference.name, description: reference.description, scope: reference.scope,
        path: reference.filePath, relativePath: reference.relativePath, content,
      };
      return {
        output: [
          `## Reference: ${payload.name}`, `**Owner**: \`${ownerId}\``,
          `**Description**: ${payload.description}`, `**Scope**: ${payload.scope}`,
          `**Path**: \`${payload.path}\``, "", "### Content", "", content,
        ].join("\n"),
        metadata: { payload },
      };
    },
  });
}
