import type { ResolvedRole } from "../../../types.ts";
import { createLoadRoleSkillTool } from "../../../asset/skill-tool.ts";
import { buildCanonicalTools } from "../../tool-assembly.ts";
import { codexCapabilities } from "../../capabilities.ts";
import type { CanonicalToolDef } from "../../types.ts";
import { CodexGraphHost } from "./graph-host.ts";
import { CodexSessionAdapter, type CodexSessionOptions } from "./session.ts";
import { codexRoleToolAllowed } from "./tool-policy.ts";
import { CodexParentNotifications } from "./parent-notifications.ts";

export interface CodexRuntimeOptions {
  directory: string;
  storeRoot: string;
  roles: readonly ResolvedRole[];
  computerUse?: boolean;
  browseUse?: boolean;
  rpcFactory?: CodexSessionOptions["rpcFactory"];
  env?: Readonly<Record<string, string | undefined>>;
  codexHome?: string;
}

export function createCodexRuntime(options: CodexRuntimeOptions) {
  const sessions = new CodexSessionAdapter({ directory: options.directory, roles: options.roles, rpcFactory: options.rpcFactory });
  const parentNotifications = new CodexParentNotifications({ codexHome: options.codexHome, env: options.env });
  const graph = new CodexGraphHost({ ...options, sessions, parentNotifications });
  const assembled = buildCanonicalTools({
    directory: options.directory, resolvedRoles: [...options.roles], capabilities: codexCapabilities(),
    sessionClient: sessions, outcomeGraphTools: graph.createTools(), getEffectiveAgent: id => sessions.agentOf(id),
    computerUse: options.computerUse, browseUse: options.browseUse,
    extraTools: { load_role_skill: createLoadRoleSkillTool([...options.roles]) },
  });
  assembled.session_diff = {
    ...assembled.session_diff,
    description: "Read Codex's recorded unified file patches, optionally through a completed turn or message. These are recorded changes, not current working-tree contents.",
    execute: async (input, context) => {
      const patches = await sessions.patches(input.session_id as string, {
        directory: context.directory, messageID: input.message_id as string | undefined,
      });
      return patches.length === 0 ? "No recorded file changes in this Codex session." : patches.map(
        change => `### ${change.file}\n\n\`\`\`diff\n${change.patch}\n\`\`\``,
      ).join("\n\n");
    },
  };
  assembled.session_fork = {
    ...assembled.session_fork,
    description: "Fork a Codex session at a completed turn boundary. message_id must be the turn ID or its final message ID; Codex cannot truncate the middle of a turn. Requires host sandbox metadata.",
  };
  const tools: Record<string, CanonicalToolDef> = Object.fromEntries(Object.entries(assembled).map(([name, tool]) => [name, {
    ...tool,
    execute: (input, context) => sessions.inSession(context.sessionID, async () => {
      if (name !== "graph_submit_outcome" && !codexRoleToolAllowed(options.roles, context.agent, name)) {
        return { output: `The acting role's policy disables ${name}.`, metadata: { error: true } };
      }
      return tool.execute(input, context);
    }),
  } satisfies CanonicalToolDef]));
  sessions.setTools(tools);
  return {
    tools, sessions, graph,
    close() { graph.close(); sessions.close(); },
  };
}
