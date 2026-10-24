import { dirname, extname, resolve } from "node:path";
import type { MemorySummary, ResolvedFunction, ResolvedReference, ResolvedSkill } from "../types.ts";
import type { FnState } from "../function/runtime-state.ts";
import { createSubLogger } from "../logger.ts";
import { injectCode, renderInjectBlock } from "./blocks.ts";
import { SUBAGENT_ID_SEPARATOR } from "../constants.ts";

const PROMPT_SIZE_WARN_THRESHOLD = 400000;

const log = createSubLogger("prompt-builder");

// ---------------------------------------------------------------------------
// Block identity (custom-hook contract)
// ---------------------------------------------------------------------------

/**
 * Markdown heading → block tag. The tag names are a stable contract: custom
 * hooks address injected blocks by tag through `ctx.getBlocks()`,
 * `ctx.replaceBlock()` and `ctx.removeBlock()`.
 */
const MARKDOWN_BLOCK_TAGS: ReadonlyArray<readonly [prefix: string, tag: string]> = [
  ["## Available skills", "available_skills"],
  ["## Available references", "available_references"],
  ["## Available sub-agents", "available_subagents"],
  ["## Available public agents", "available_public_agents"],
  ["## Active functions", "active_functions"],
  ["## Available functions", "available_functions"],
  ["## Available memory", "available_memory"],
  ["## Function state:", "function_state"],
  ["## Active artifact:", "active_artifact"],
];

/**
 * Block tag of one system entry. Recognizes the markdown blocks emitted by this
 * module and the legacy `<tag>` shape, so hooks written against either prompt
 * format resolve the same block. Anything unrecognized is `text`.
 *
 * The legacy branch keeps the original `^<(\w+)>` behavior exactly: an
 * attribute-bearing tag such as `<function_state name="plan">` was never
 * addressable through this contract, and widening the match now would move
 * entries between tags for hooks that already exist.
 */
export function blockTag(block: string): string {
  const legacy = /^<(\w+)>/.exec(block);
  if (legacy) return legacy[1];
  for (const [prefix, tag] of MARKDOWN_BLOCK_TAGS) {
    if (block.startsWith(prefix)) return tag;
  }
  return "text";
}

export interface PromptSource {
  prompt: string;
}

export interface AgentPromptOptions {
  subagents?: Array<{ id: string; name: string; description: string }>;
  publicAgents?: Array<{ id: string; name: string; description: string }>;
  references?: ResolvedReference[];
  canDelegate?: boolean;
  canTeam?: boolean;
  resourceTool?: "graph_worker_exec";
}

export function buildAgentPrompt(
  role: PromptSource,
  skills: ResolvedSkill[],
  options: AgentPromptOptions = {},
): string {
  const { subagents, publicAgents, references, resourceTool } = options;

  const parts: string[] = [role.prompt === "" ? "" : `## Role instructions\n\n${role.prompt}`];

  if (references && references.length > 0) {
    parts.push(buildReferenceBlock(references, resourceTool));
  }

  if (skills.length > 0) {
    parts.push(buildSkillBlock(skills, resourceTool));
  }

  const subagentBlock = buildSubagentBlock(options.canDelegate === false ? [] : subagents ?? []);
  if (subagentBlock) {
    parts.push(subagentBlock);
  }

  const publicAgentsBlock = buildPublicAgentsBlock((options.canTeam ?? options.canDelegate) === false ? [] : publicAgents ?? []);
  if (publicAgentsBlock) {
    parts.push(publicAgentsBlock);
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
  if (functions.length === 0) return "";
  return renderInjectBlock({
    title: "Active functions",
    instruction: "These functions are currently active for this session. Follow their instructions.",
    sections: functions.map((fn) => ({
      title: fn.name,
      level: 3,
      instruction: fn.description,
      body: fn.content,
    })),
  });
}

export function buildSkillBlock(skills: ResolvedSkill[], resourceTool?: "graph_worker_exec"): string {
  if (skills.length === 0) return "";
  const instruction = resourceTool
    ? "Skills provide specialized instructions. Use graph_worker_exec to read the listed skill file when the task matches. Resolve relative resources against its directory."
    : "Skills provide specialized instructions. When a task matches, use load_role_skill if available; otherwise use the skill tool. Role workflow skills are scoped to their owning role.";
  // Workers read private copies with unpredictable paths, so name-based
  // loading is insufficient for their command-only tool surface.
  return renderInjectBlock({
    title: "Available skills",
    instruction,
    items: skills.map((s) => ({
      label: s.name,
      value: s.description,
      ...(resourceTool && s.filePath ? { sub: `File: ${injectCode(s.filePath)}` } : {}),
    })),
  });
}

/**
 * The directory an entry's own name is relative to — stated ONCE for the block
 * — or `undefined` when the references share no such directory.
 *
 * A candidate is always an ancestor DIRECTORY of the first file, so it can only
 * ever be a real path-segment boundary: the character prefix `…/theory` shared
 * by `…/theory-x.md` and `…/theory-y.md` is never a candidate, because neither
 * file sits under it. Candidates are tried from the deepest (`dirname` of the
 * first file) upward, so the base is the closest directory the entries are
 * actually named relative to.
 *
 * The one test a candidate must pass: joining it with every entry's own name
 * has to land exactly on that entry's file, because in the shared form the
 * bullet is ``- `<name>` — <description>`` and the name is the only thing
 * locating the file. A flat reference (`guide` → `…/references/guide.md`) is
 * located by its own directory. A resolver-named nested reference
 * (`theory/psychology` → `…/references/theory/psychology.md`) is located by the
 * `references` directory above it — the walk steps up to exactly that
 * directory. An explicit name that derives nothing from its file
 * (`api-docs` → `…/references/api.md`) is located by no ancestor at all, so the
 * set keeps the per-entry path line rather than a subtly wrong base.
 */
function sharedReferenceBase(references: ResolvedReference[]): string | undefined {
  const first = references[0];
  if (first === undefined) return undefined;
  for (let candidate = dirname(first.filePath); ; candidate = dirname(candidate)) {
    if (referenceBaseLocatesEvery(candidate, references)) return candidate;
    // Root reached: no ancestor locates every entry, so there is no shared base.
    if (dirname(candidate) === candidate) return undefined;
  }
}

/** True when `base` + each entry's own name is exactly that entry's file. */
function referenceBaseLocatesEvery(base: string, references: ResolvedReference[]): boolean {
  const canonical = resolve(base);
  for (const reference of references) {
    // Reference names are the file path below `references/` without its
    // extension, so both forms have to be accepted: nesting (`theory/x`) and a
    // name written with the extension.
    const filePath = resolve(reference.filePath);
    const extension = extname(filePath);
    if (resolve(canonical, reference.name) !== filePath &&
        resolve(canonical, `${reference.name}${extension}`) !== filePath) return false;
  }
  return true;
}

export function buildReferenceBlock(references: ResolvedReference[], resourceTool?: "graph_worker_exec"): string {
  if (references.length === 0) return "";
  const instruction = resourceTool
    ? "Reference documents provide deep knowledge. Use graph_worker_exec to read the listed files. Resolve relative references against the document's directory."
    : "Reference documents provide deep knowledge. Use the Read tool to load full content when needed.";
  // One `Base directory:` line for a shared directory; the old per-entry
  // `` `name`: `path` `` line otherwise, so no reference becomes unlocatable.
  const base = sharedReferenceBase(references);
  return renderInjectBlock({
    title: "Available references",
    instruction,
    ...(base === undefined ? {} : { base }),
    items: references.map((r) => (base === undefined
      ? { label: r.name, value: r.description, sub: `${injectCode(r.name)}: ${injectCode(r.filePath)}` }
      : { label: r.name, value: r.description })),
  });
}

export function buildMemoryBlock(memories: MemorySummary[]): string {
  if (memories.length === 0) return "";
  return renderInjectBlock({
    title: "Available memory",
    instruction: "Memory entries from previous sessions. Use memory_recall to search for specific memories.",
    table: {
      header: ["id", "category", "relevance", "title", "updated"],
      rows: memories.map((m) => [m.id, m.category, m.relevance, m.title, m.updated_at]),
    },
  });
}

const MEMORY_GRANT_INSTRUCTIONS = "Declare extra host tools in each node's tools array. When prior decisions or lessons matter, " +
  "grant memory_recall and memory_read if available. Grant memory_write or memory_update when the " +
  "worker should persist verified, reusable findings. Do not assume a worker inherits your tool access.";

const COMPUTER_GRANT_INSTRUCTIONS = "When a task needs desktop observation or interaction, declare the specific available computer_* tools " +
  "in that node's tools array: computer_screenshot for observation, computer_windows and computer_focus for targeting, " +
  "and only the required input tools such as computer_click or computer_type. Include computer_status and computer_permissions " +
  "when available so the worker can diagnose failures and request missing OS permissions. A declaration cannot enable " +
  "unregistered tools, override a denied capability, or grant OS permission.";

const SUBAGENT_INSTRUCTIONS = "You can delegate tasks to these sub-agents through the graph outcome protocol.\n" +
  "Declare the work as a graph with graph_declare: a version-3 declaration naming each\n" +
  "node\u0027s agent, prompt and the outcomes it may report, plus the edges that route an\n" +
  "accepted outcome to the next node. Declaring persists the plan and starts nothing\n" +
  "itself: the host dispatches the entry nodes and hands each worker the attempt\n" +
  "credential it settles with, so end your turn after graph_declare. A worker settles\n" +
  "its node with graph_submit_outcome(graph_id=..., node_id=..., outcome_id=...,\n" +
  "credential=...); the accepted outcome commits the node\u0027s state together with the\n" +
  "graph\u0027s, and the declared edge arms the next node — no further call is needed to\n" +
  "advance the graph. Read the recorded state with graph_status(graph_id=...,\n" +
  "include_output=true) and inventory the store with graph_audit; both are read-only,\n" +
  "and a node\u0027s status changes only when a settlement commits. A transition comes\n" +
  "from a declared outcome and edge only: free-form reports are never ranked, merged\n" +
  "or interpreted as progress.\n" +
  MEMORY_GRANT_INSTRUCTIONS + "\n" + COMPUTER_GRANT_INSTRUCTIONS;

export function buildSubagentBlock(
  subagents: Array<{ id: string; name: string; description: string }>,
): string {
  if (subagents.length === 0) return "";
  // The display `name` stays in the type but is not rendered: the id-first
  // bullet is the deliberate information reduction, like the dropped skill
  // `<location>` path.
  return renderInjectBlock({
    title: "Available sub-agents",
    instruction: SUBAGENT_INSTRUCTIONS,
    items: subagents.map((a) => ({ label: a.id, value: a.description })),
  });
}

const PUBLIC_AGENT_INSTRUCTIONS = "These top-level roles can collaborate as teammates with complementary expertise.\n" +
  "When a task needs skills beyond your role, use a team to separate responsibilities, " +
  "such as design decisions and implementation. A role's child agents belong to that " +
  "role: never discover, invite, or address another role's children. Share deliverables " +
  "and review findings, keeping your private child roster and internal transcripts out of team events.\n" +
  "Use the following tools only when they are available in your current tool set. " +
  "Call team_list_roles to discover current top-level roles, team_create(name, goal) " +
  "to establish a shared goal, and team_add(team_id, role_id) to invite a role. " +
  "Use team_send_event(team_id, kind, content, task_id?, recipient?) to communicate; " +
  "kind is message, task_offer, task_claim, task_complete, or task_release. " +
  "Offer work with task_offer, claim its task_id with task_claim, and start only " +
  "after the claim succeeds. Share results with task_complete or release a claim " +
  "with task_release. Use message for questions and coordination, and recipient " +
  "when only one teammate should act.\n" +
  "Read team_status to inspect members, events, and tasks. Membership changes " +
  "and completed turns are shared events; act only on new work relevant to your " +
  "expertise, and avoid acknowledgment loops. Use team_remove to remove a member " +
  "and team_delete to end a team. Team state persists across process restarts; " +
  "inspect existing state before creating a replacement, and use team_resume " +
  "when a suspended team should continue.";

export function buildPublicAgentsBlock(
  agents: Array<{ id: string; name: string; description: string }>,
): string {
  const topLevelAgents = agents.filter((agent) => !agent.id.includes(SUBAGENT_ID_SEPARATOR));
  if (topLevelAgents.length === 0) return "";
  // Same id-first bullet as the sub-agent block; `name` is not rendered.
  return renderInjectBlock({
    title: "Available public agents",
    instruction: PUBLIC_AGENT_INSTRUCTIONS,
    items: topLevelAgents.map((a) => ({ label: a.id, value: a.description })),
  });
}

/** Exported API for role workspaces; src has no call site of its own. */
export function buildFunctionStateBlock(fnName: string, s: FnState, todosRemaining: number): string {
  const evidence = Object.entries(s.evidenceObserved).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return renderInjectBlock({
    title: `Function state: ${fnName}`,
    items: [
      { value: `phase: ${s.phase}` },
      { value: `gate satisfied: ${s.gateSatisfied}` },
      { value: `todos remaining: ${todosRemaining}` },
      { value: `evidence: ${evidence}` },
      { value: `continuation count: ${s.continuationCount}` },
    ],
  });
}

export function buildActiveArtifactBlock(name: string, content: string): string {
  return renderInjectBlock({ title: `Active artifact: ${name}`, body: content });
}

export function buildAvailableFunctionsBlock(functions: ResolvedFunction[]): string {
  if (functions.length === 0) return "";
  return renderInjectBlock({
    title: "Available functions",
    instruction: "These functions are available for activation. Use |function_name| or |function_name:params| syntax to activate them.",
    sections: functions.map((fn) => {
      const paramsStr = fn.params
        ? Object.entries(fn.params).map(([k, v]) => `${k}=${v}`).join(", ")
        : undefined;
      return {
        title: fn.name,
        level: 3 as const,
        instruction: paramsStr === undefined ? fn.description : [fn.description, `params: ${paramsStr}`],
        body: fn.content,
      };
    }),
  });
}
