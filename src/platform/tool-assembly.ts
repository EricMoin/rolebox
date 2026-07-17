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
import {
  createDispatchTool,
  createDispatchOutputTool,
  createDispatchCancelTool,
  createDispatchApproveTool,
  createDispatchRejectTool,
  createDispatchMetricsTool,
} from "../dispatch/tools.ts";
import { createDispatchStatusTool } from "../dispatch/query/task-status.ts";
import { createDispatchProgressTool, createDispatchStreamTool } from "../dispatch/progress/progress-tools.ts";

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
}

export function buildCanonicalTools(
  opts: BuildToolsOptions,
): Record<string, CanonicalToolDef> {
  const tools: Record<string, CanonicalToolDef<any>> = {};

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
    // Aliases for backward/forward compatibility
    tools.session_inspect = createSessionInfoTool(client);
    tools.session_changes = createSessionDiffTool(client);
    tools.session_branch = createSessionForkTool(client);
  }

  // 3. Dispatch tools
  if (opts.dispatchToolsOverride && Object.keys(opts.dispatchToolsOverride).length > 0) {
    Object.assign(tools, opts.dispatchToolsOverride);
  } else if (opts.dispatchManager && opts.resolvedSubagents) {
    const mgr = opts.dispatchManager;
    const subagents = opts.resolvedSubagents;
    const modelKey = opts.subagentModelKey;

    tools.dispatch = createDispatchTool(mgr, subagents, modelKey);
    tools.dispatch_output = createDispatchOutputTool(mgr);
    tools.dispatch_cancel = createDispatchCancelTool(mgr);
    tools.dispatch_approve = createDispatchApproveTool(mgr);
    tools.dispatch_reject = createDispatchRejectTool(mgr);
    tools.dispatch_metrics = createDispatchMetricsTool();
    tools.dispatch_status = createDispatchStatusTool(mgr);

    tools.dispatch_progress = createDispatchProgressTool(mgr);
    tools.dispatch_stream = createDispatchStreamTool(mgr);
  }

  // 4. extraTools merged on top (overrides core if same key)
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

  return tools;
}
