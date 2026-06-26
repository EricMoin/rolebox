import type { ResolvedFunction, ResolvedReference, ResolvedSkill, ResolvedGraph } from "./types.ts";
import { buildCollaborationBlock } from "./graph/index.ts";
import { createSubLogger } from "./logger.ts";

const PROMPT_SIZE_WARN_THRESHOLD = 400000;

const log = createSubLogger("prompt-builder");

type XmlChild = XmlNode | string;

export type XmlNode = { tag: string; children: XmlChild[] };
type CdataNode = { cdata: string };

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xml(tag: string, children: (XmlChild | CdataNode)[]): XmlNode {
  return { tag, children: children as XmlChild[] };
}

function cdata(content: string): CdataNode {
  return { cdata: content };
}

function isCdata(child: unknown): child is CdataNode {
  return typeof child === "object" && child !== null && "cdata" in child;
}

export function renderXml(node: XmlNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const children = node.children as (XmlChild | CdataNode)[];

  if (children.length === 1 && typeof children[0] === "string") {
    return `${pad}<${node.tag}>${escapeXml(children[0])}</${node.tag}>`;
  }

  const childPad = "  ".repeat(indent + 1);
  const inner = children
    .map((child) => {
      if (typeof child === "string") return `${childPad}${escapeXml(child)}`;
      if (isCdata(child)) return `${childPad}<![CDATA[\n${child.cdata}\n${childPad}]]>`;
      return renderXml(child, indent + 1);
    })
    .join("\n");
  return `${pad}<${node.tag}>\n${inner}\n${pad}</${node.tag}>`;
}

function renderSection(tag: string, instruction: string, items: XmlNode[]): string {
  if (items.length === 0) return "";
  const body = items.map((item) => renderXml(item, 1)).join("\n");
  return `<${tag}>\n${instruction}\n${body}\n</${tag}>`;
}

export interface PromptSource {
  prompt: string;
}

export interface AgentPromptOptions {
  subagents?: Array<{ id: string; name: string; description: string }>;
  references?: ResolvedReference[];
  graph?: ResolvedGraph;
}

export function buildAgentPrompt(
  role: PromptSource,
  skills: ResolvedSkill[],
  options: AgentPromptOptions = {},
): string {
  const { subagents, references, graph } = options;

  const parts: string[] = [role.prompt];

  if (references && references.length > 0) {
    parts.push(buildReferenceBlock(references));
  }

  if (skills.length > 0) {
    parts.push(buildSkillBlock(skills));
  }

  const subagentBlock = buildSubagentBlock(subagents ?? []);
  if (subagentBlock) {
    parts.push(subagentBlock);
  }

  if (graph) {
    const collaborationBlock = buildCollaborationBlock(graph, subagents ?? []);
    if (collaborationBlock) {
      parts.push(collaborationBlock);
    }
  }

  const prompt = parts.join("\n\n");
  const estimatedTokens = Math.ceil(prompt.length / 4);
  log.info("Prompt assembled", { chars: prompt.length, estimatedTokens });
  if (prompt.length > PROMPT_SIZE_WARN_THRESHOLD) {
    log.warn("Prompt size exceeds recommended limit", { chars: prompt.length, estimatedTokens, threshold: Math.ceil(PROMPT_SIZE_WARN_THRESHOLD / 4) });
  }
  return prompt;
}

export function buildFunctionBlock(functions: ResolvedFunction[]): string {
  return renderSection(
    "active_functions",
    "These functions are currently active for this session. Follow their instructions.",
    functions.map((fn) => xml("function", [
      xml("name", [fn.name]),
      xml("description", [fn.description]),
      xml("instructions", [cdata(fn.content)]),
    ])),
  );
}

export function buildSkillBlock(skills: ResolvedSkill[]): string {
  return renderSection(
    "available_skills",
    "Skills provide specialized instructions. Use the skill tool to load when task matches.",
    skills.map((s) => xml("skill", [
      xml("name", [s.name]),
      xml("description", [s.description]),
      xml("scope", [s.scope]),
    ])),
  );
}

export function buildReferenceBlock(references: ResolvedReference[]): string {
  return renderSection(
    "available_references",
    "Reference documents provide deep knowledge. Use the Read tool to load full content when needed.",
    references.map((r) => xml("reference", [
      xml("name", [r.name]),
      xml("path", [r.filePath]),
      xml("description", [r.description]),
    ])),
  );
}

const SUBAGENT_INSTRUCTIONS = `You can delegate tasks to these sub-agents via the dispatch() tool.
Use dispatch(subagent="agent-id", prompt="...", run_in_background=false) for synchronous execution.
Use dispatch(subagent="agent-id", prompt="...", run_in_background=true) for background execution.
IMPORTANT: When run_in_background=true, you will receive a <system-reminder> notification when the task completes.
Do NOT call dispatch_output to poll for results. Wait for the <system-reminder> notification first.
Use dispatch_output(task_id="bg_xxx") ONLY after receiving the completion notification.
Use dispatch_cancel(task_id="bg_xxx") to cancel a running background task.`;

export function buildSubagentBlock(
  subagents: Array<{ id: string; name: string; description: string }>,
): string {
  return renderSection(
    "available_subagents",
    SUBAGENT_INSTRUCTIONS,
    subagents.map((a) => xml("subagent", [
      xml("id", [a.id]),
      xml("name", [a.name]),
      xml("description", [a.description]),
    ])),
  );
}
