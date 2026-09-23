/**
 * tool-assembly.ts — Cross-platform tool assembly.
 *
 * Assembles the intersection set of tools common to both OpenCode and Pi
 * platforms. This module MUST NOT import from any platform SDK.
 *
 * Phase 1: purely additive file.
 */

import type { CanonicalToolDef } from "./ports/tool-factory.ts";
import type { ISessionClient } from "./ports/session-client.ts";
import type { PlatformCapabilities } from "./capabilities.ts";
import type { DispatchManager } from "../dispatch/core/manager.ts";
import type { ResolvedRole } from "../types.ts";

import { createHashlineReadTool } from "../hashline/hashline-read.ts";
import { createHashlineEditTool } from "../hashline/hashline-edit.ts";
import {
  createMemoryWriteTool,
  createMemoryRecallTool,
  createMemoryListTool,
} from "../memory/tools.ts";
import { createWebSearchTool } from "../web/web-search.ts";
import { createPageReadTool } from "../web/page-read.ts";
import { createWebFetchTool } from "../web/web-fetch.ts";
import { createSignalTool } from "../signal/signal-tool.ts";
import { createInteractiveTerminalTool } from "../terminal/interactive-terminal-tool.ts";
import { createAssetSearchTool } from "../asset/asset-search.ts";
import { createAssetInspectTool } from "../asset/asset-inspect.ts";
import { createAssetValidateTool } from "../asset/asset-validate.ts";
import { createReferenceSearchTool } from "../utils/reference-search.ts";
import {
  createSessionListTool,
  createSessionSearchTool,
} from "../session/session-browse-tools.ts";
import {
  createSessionReadTool,
  createSessionInfoTool,
  createSessionDiffTool,
  createSessionForkTool,
} from "../session/session-inspect-tools.ts";

// Graph Execution Engine v2 — the OUTCOME run path's tool face is registered
// here as a caller-provided record (the shipping hosts build it from their own
// host capability layer). This assembly never constructs a graph toolset and
// never imports the legacy engine: a host that wants graph orchestration passes
// `outcomeGraphTools`.

export interface BuildToolsOptions {
  sessionClient?: ISessionClient;
  dispatchManager?: DispatchManager;
  resolvedSubagents?: Map<string, { parentFullId: string }>;
  subagentModelKey?: Map<string, string>;
  resolvedRoles: ResolvedRole[];
  directory: string;
  // Accepted for future use; not consulted in Phase 1 tool assembly.
  capabilities: PlatformCapabilities;
  extraTools?: Record<string, CanonicalToolDef>;
  dispatchToolsOverride?: Record<string, CanonicalToolDef>;
  loopToolsOverride?: Record<string, CanonicalToolDef>;
  taskToolsOverride?: Record<string, CanonicalToolDef>;
  /**
   * The graph orchestration surface this host assembles — the OUTCOME run
   * path's tool face (`graph_declare`, `graph_submit_outcome`, `graph_audit`,
   * `graph_status`), built by the host from its own capability layer
   * (`src/graph/host/outcome-host.ts` + `createOutcomeGraphTools`).
   *
   * This assembly deliberately does NOT construct a graph toolset and does NOT
   * register anything when the record is absent: a platform without an outcome
   * capability layer (no protected credential store, no dispatch adapter) has
   * no runnable graph path, and offering the legacy construction entries there
   * would be a second execution path the outcome protocol does not serve.
   */
  outcomeGraphTools?: Record<string, CanonicalToolDef>;
}

/**
 * The four role-snapshot tool keys — the tools whose behavior is bound to the
 * resolved-role snapshot (`resolvedRoles`). Kept as a membership record so
 * the dsh plugin can both skip them in its boot registration loop
 * (`key in ROLE_SNAPSHOT_TOOL_KEYS`) and rebuild them as one disposable
 * generation on an in-process role reload.
 */
export const ROLE_SNAPSHOT_TOOL_KEYS = {
  asset_search: true,
  asset_inspect: true,
  asset_validate: true,
  reference_search: true,
} as const satisfies Record<string, true>;

/**
 * Build exactly the four role-snapshot tools from a resolved-role snapshot.
 *
 * Separate from {@link buildCanonicalTools} so the dsh plugin's reload seam can
 * rebuild this generation alone (dispose-then-re-register) without recompiling
 * the rest of the canonical tool set. The boot path calls this with the same
 * argument, so the assembled map is unchanged.
 */
export function buildRoleSnapshotTools(
  resolvedRoles: ResolvedRole[],
): Record<string, CanonicalToolDef> {
  return {
    asset_search: createAssetSearchTool(resolvedRoles),
    asset_inspect: createAssetInspectTool(resolvedRoles),
    asset_validate: createAssetValidateTool(resolvedRoles),
    reference_search: createReferenceSearchTool(resolvedRoles),
  };
}

export function buildCanonicalTools(
  opts: BuildToolsOptions,
): Record<string, CanonicalToolDef> {
  let tools: Record<string, CanonicalToolDef<any>> = {};

  // 1. Core standalone + asset/reference tools (always)
  // These are the intersection tools common to both OpenCode and Pi.
  // OpenCode-only tools (e.g., memory_update, function_state, context_assemble,
  // todowrite, task_*, bash, etc.) are intentionally excluded from this set and
  // are passed via extraTools by the platform-specific assembly layer.
  tools.hashline_read = createHashlineReadTool();
  tools.hashline_edit = createHashlineEditTool();
  tools.memory_write = createMemoryWriteTool();
  tools.memory_recall = createMemoryRecallTool();
  tools.memory_list = createMemoryListTool();
  tools.web_search = createWebSearchTool();
  tools.web_read = createPageReadTool();
  tools.web_fetch = createWebFetchTool();
  tools.signal = createSignalTool();
  tools.interactive_terminal = createInteractiveTerminalTool();

  Object.assign(tools, buildRoleSnapshotTools(opts.resolvedRoles));

  // 2. Session tools (if sessionClient provided)
  if (opts.sessionClient) {
    // Session tools expect SessionClientWrapper (OpencodeSessionAdapter),
    // which is a concrete class implementing ISessionClient. Since this
    // module is forbidden from importing src/session/client.ts, derive the
    // expected parameter type from one of the session tool factory signatures.
    type SessionClientForTools = Parameters<typeof createSessionListTool>[0];
    const client = opts.sessionClient as SessionClientForTools;

    tools.session_list = createSessionListTool(client);
    tools.session_read = createSessionReadTool(client);
    tools.session_search = createSessionSearchTool(client);
    tools.session_info = createSessionInfoTool(client);
    tools.session_diff = createSessionDiffTool(client);
    tools.session_fork = createSessionForkTool(client);
  }

  // 4. dispatchToolsOverride merged below extraTools/loopToolsOverride.
  // Lowest override precedence by design: any platform passing an explicit
  // override for a dispatch_* key (real shims on opencode, or stubs on Pi)
  // registers them here. If a caller also passes extraTools or
  // loopToolsOverride with an overlapping key, those are merged afterwards
  // (higher precedence) and win.
  if (opts.dispatchToolsOverride) {
    Object.assign(tools, opts.dispatchToolsOverride);
  }

  // 3. extraTools merged on top (overrides core if same key)
  // Intentional: extraTools has higher precedence than dispatchToolsOverride.
  // If a caller passes both an override and extraTools with overlapping keys,
  // the extra tool wins. This is by design — extraTools is the platform's
  // final customization layer before loopToolsOverride.
  if (opts.extraTools) {
    Object.assign(tools, opts.extraTools);
  }

  // 5. loopToolsOverride merged last (highest precedence)
  if (opts.loopToolsOverride) {
    Object.assign(tools, opts.loopToolsOverride);
  }

  // 5a. taskToolsOverride — restored legacy task_* compatibility surface.
  // Same highest-precedence, additive merge as loopToolsOverride. The task_*
  // keys are disjoint from dispatch_*/loop_*/graph_* namespaces, so this never
  // overrides another tool.
  if (opts.taskToolsOverride) {
    Object.assign(tools, opts.taskToolsOverride);
  }

  // 5b. The OUTCOME run path's tool face — registered when, and only when, the
  // host supplied it. The graph_* keys share no namespace with loop_*, so this
  // merge never overrides another tool (same additive precedence as
  // extraTools/loopToolsOverride).
  if (opts.outcomeGraphTools) {
    Object.assign(tools, opts.outcomeGraphTools);
  }

  return tools;

  return tools;
}
