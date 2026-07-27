import type { MemorySummary, ResolvedFunction, ResolvedReference, ResolvedSkill, ResolvedGraph } from "../types.ts";
import type { FnState } from "../function/runtime-state.ts";
import { buildCollaborationBlock } from "../graph/index.ts";
import { createSubLogger } from "../logger.ts";

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

export function buildMemoryBlock(memories: MemorySummary[]): string {
  if (memories.length === 0) return "";
  return renderSection(
    "available_memory",
    "Memory entries from previous sessions. Use memory_recall to search for specific memories.",
    memories.map((m) => xml("memory", [
      xml("id", [m.id]),
      xml("title", [m.title]),
      xml("category", [m.category]),
      xml("relevance", [m.relevance]),
      xml("updated", [m.updated_at]),
    ])),
  );
}

const SUBAGENT_INSTRUCTIONS = `You can delegate tasks to these sub-agents via the graph execution engine.
Model each delegated task as a graph node. Use graph_create to start a graph, then
graph_add_node(graph_id=..., id=..., agent=<sub-agent id>, prompt="...") to register a
worker node, then graph_run(graph_id=..., node_id=...) to execute it.
When graph_run returns, read the full worker result with
graph_status(graph_id=..., node_id=<node_id>, include_output=true).
For multi-step work that must run together, add edges (graph_add_edge) between nodes and
run the graph as a whole; graph_cancel(graph_id=..., node_id=...) stops a running node.
IMPORTANT: node completion does not always push a notification. When the graph runs with
node-completion notifications enabled (an emperor session is wired), a <system-reminder> is
injected into your session when a background node completes. When notifications are disabled
or no emperor session is available, no reminder is sent. Never assume a reminder will always
arrive — read the worker result with graph_status(graph_id=..., node_id=<node_id>,
include_output=true). Do not poll graph_status in a loop to wait for a task; re-read it when
you need the result (or when a <system-reminder> indicates completion).`;

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

export function buildFunctionStateBlock(fnName: string, s: FnState, todosRemaining: number): string {
  return `<function_state name="${fnName}">
  <phase>${s.phase}</phase>
  <gate_satisfied>${s.gateSatisfied}</gate_satisfied>
  <todos_remaining>${todosRemaining}</todos_remaining>
  <evidence>${Object.entries(s.evidenceObserved).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}</evidence>
  <continuation>${s.continuationCount}</continuation>
</function_state>`;
}

export function buildActiveArtifactBlock(name: string, content: string): string {
  return `<active_artifact name="${name}">\n${content}\n</active_artifact>`;
}

export function buildAvailableFunctionsBlock(functions: ResolvedFunction[]): string {
  if (functions.length === 0) return "";
  return renderSection(
    "available_functions",
    "These functions are available for activation. Use |function_name| or |function_name:params| syntax to activate them.",
    functions.map((fn) => {
      const children: (XmlChild | CdataNode)[] = [
        xml("name", [fn.name]),
        xml("description", [fn.description]),
      ];
      if (fn.params) {
        const paramsStr = Object.entries(fn.params)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        children.push(xml("params", [paramsStr]));
      }
      children.push(xml("content", [cdata(fn.content)]));
      return xml("function", children);
    }),
  );
}
