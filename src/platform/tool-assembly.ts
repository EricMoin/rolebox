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

// Graph Execution Engine v2 — Phase 4, Subtask 6. Additive registration of the
// seven imperative graph_* tools. Import-only (no protected files touched).
import { createGraphTools } from "../graph/tools/index.ts";
import type { GraphNotifySource } from "../graph/tools/index.ts";

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
   * Optional graph node-completion notifier (subtask 3): a prebuilt
   * `GraphCompletionHandler` or an owner config carrying the emperor session id
   * + session client. Threaded through `createGraphTools` into every engine the
   * graph tools construct so node completions route to graph-notify targeting
   * the emperor session. Absent → graph_run builds engines with the default
   * no-op completion seam (backward compatible). `graphParentContext` budget
   * scoping (`sessionID: graphId`) is untouched.
   */
  graphNotify?: GraphNotifySource;
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

  tools.asset_search = createAssetSearchTool(opts.resolvedRoles);
  tools.asset_inspect = createAssetInspectTool(opts.resolvedRoles);
  tools.asset_validate = createAssetValidateTool(opts.resolvedRoles);
  tools.reference_search = createReferenceSearchTool(opts.resolvedRoles);

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

  // 5b. Graph Execution Engine v2 tools — Phase A coexistence (additive only)
  // Registered alongside the loop_* tools when a dispatch manager is present.
  // The graph_* keys share no namespace with loop_*, so this merge never
  // overrides a legacy tool. Same additive precedence as
  // extraTools/loopToolsOverride (Object.assign onto the assembled map).
  if (opts.dispatchManager) {
    Object.assign(tools, createGraphTools(opts.dispatchManager, {
      directory: opts.directory,
      graphNotify: opts.graphNotify,
    }));
  }

  return tools;
}
