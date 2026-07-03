export { LspClientManager } from "./client-manager.ts";
export { LspDocumentManager } from "./document-manager.ts";

import { tool } from "@opencode-ai/plugin";
import type { LspClientManager } from "./client-manager.ts";
import type { LspDocumentManager } from "./document-manager.ts";

import { createLspDiagnosticsTool } from "./tools/diags.ts";
import {
  createLspGotoDefinitionTool,
  createLspGotoTypeDefinitionTool,
  createLspGotoImplementationTool,
  createLspGotoDeclarationTool,
  createLspFindReferencesTool,
  createLspDocumentHighlightsTool,
} from "./tools/nav.ts";
import {
  createLspDocumentSymbolsTool,
  createLspWorkspaceSymbolsTool,
} from "./tools/symbols.ts";
import {
  createLspPrepareRenameTool,
  createLspRenameTool,
} from "./tools/rename.ts";
import {
  createLspHoverTool,
  createLspSignatureHelpTool,
} from "./tools/hover.ts";
import { createLspCompletionTool } from "./tools/completion.ts";
import {
  createLspCodeActionsTool,
  createLspExecuteCodeActionTool,
} from "./tools/code-actions.ts";
import {
  createLspFormatDocumentTool,
  createLspFormatRangeTool,
} from "./tools/format.ts";
import {
  createLspPrepareCallHierarchyTool,
  createLspIncomingCallsTool,
  createLspOutgoingCallsTool,
  createLspTypeHierarchySupertypesTool,
  createLspTypeHierarchySubtypesTool,
} from "./tools/hierarchy.ts";
import {
  createLspFoldingRangesTool,
  createLspSelectionRangesTool,
  createLspSemanticTokensTool,
} from "./tools/structure.ts";
import {
  createLspCodeLensTool,
  createLspInlayHintsTool,
  createLspDocumentLinksTool,
  createLspDocumentColorsTool,
} from "./tools/lens.ts";
import {
  createLspServersTool,
  createLspRestartServerTool,
} from "./tools/server-mgmt.ts";

// Re-exports for consumers
export { createLspDiagnosticsTool } from "./tools/diags.ts";
export {
  createLspGotoDefinitionTool,
  createLspGotoTypeDefinitionTool,
  createLspGotoImplementationTool,
  createLspGotoDeclarationTool,
  createLspFindReferencesTool,
  createLspDocumentHighlightsTool,
} from "./tools/nav.ts";
export {
  createLspDocumentSymbolsTool,
  createLspWorkspaceSymbolsTool,
} from "./tools/symbols.ts";
export {
  createLspPrepareRenameTool,
  createLspRenameTool,
} from "./tools/rename.ts";
export {
  createLspHoverTool,
  createLspSignatureHelpTool,
} from "./tools/hover.ts";
export { createLspCompletionTool } from "./tools/completion.ts";
export {
  createLspCodeActionsTool,
  createLspExecuteCodeActionTool,
} from "./tools/code-actions.ts";
export {
  createLspFormatDocumentTool,
  createLspFormatRangeTool,
} from "./tools/format.ts";
export {
  createLspPrepareCallHierarchyTool,
  createLspIncomingCallsTool,
  createLspOutgoingCallsTool,
  createLspTypeHierarchySupertypesTool,
  createLspTypeHierarchySubtypesTool,
} from "./tools/hierarchy.ts";
export {
  createLspFoldingRangesTool,
  createLspSelectionRangesTool,
  createLspSemanticTokensTool,
} from "./tools/structure.ts";
export {
  createLspCodeLensTool,
  createLspInlayHintsTool,
  createLspDocumentLinksTool,
  createLspDocumentColorsTool,
} from "./tools/lens.ts";
export {
  createLspServersTool,
  createLspRestartServerTool,
} from "./tools/server-mgmt.ts";

type LspTool = ReturnType<typeof tool>;

export function createAllLspTools(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
): Record<string, LspTool> {
  const entries: Array<[string, LspTool]> = [
    ["lsp_diagnostics", createLspDiagnosticsTool(clientManager, docManager)],
    ["lsp_goto_definition", createLspGotoDefinitionTool(clientManager, docManager)],
    ["lsp_goto_type_definition", createLspGotoTypeDefinitionTool(clientManager, docManager)],
    ["lsp_goto_implementation", createLspGotoImplementationTool(clientManager, docManager)],
    ["lsp_goto_declaration", createLspGotoDeclarationTool(clientManager, docManager)],
    ["lsp_find_references", createLspFindReferencesTool(clientManager, docManager)],
    ["lsp_document_highlights", createLspDocumentHighlightsTool(clientManager, docManager)],
    ["lsp_document_symbols", createLspDocumentSymbolsTool(clientManager, docManager)],
    ["lsp_workspace_symbols", createLspWorkspaceSymbolsTool(clientManager, docManager)],
    ["lsp_prepare_rename", createLspPrepareRenameTool(clientManager, docManager)],
    ["lsp_rename", createLspRenameTool(clientManager, docManager)],
    ["lsp_hover", createLspHoverTool(clientManager, docManager)],
    ["lsp_signature_help", createLspSignatureHelpTool(clientManager, docManager)],
    ["lsp_completion", createLspCompletionTool(clientManager, docManager)],
    ["lsp_code_actions", createLspCodeActionsTool(clientManager, docManager)],
    ["lsp_execute_code_action", createLspExecuteCodeActionTool(clientManager, docManager)],
    ["lsp_format_document", createLspFormatDocumentTool(clientManager, docManager)],
    ["lsp_format_range", createLspFormatRangeTool(clientManager, docManager)],
    ["lsp_prepare_call_hierarchy", createLspPrepareCallHierarchyTool(clientManager, docManager)],
    ["lsp_incoming_calls", createLspIncomingCallsTool(clientManager, docManager)],
    ["lsp_outgoing_calls", createLspOutgoingCallsTool(clientManager, docManager)],
    ["lsp_type_hierarchy_supertypes", createLspTypeHierarchySupertypesTool(clientManager, docManager)],
    ["lsp_type_hierarchy_subtypes", createLspTypeHierarchySubtypesTool(clientManager, docManager)],
    ["lsp_folding_ranges", createLspFoldingRangesTool(clientManager, docManager)],
    ["lsp_selection_ranges", createLspSelectionRangesTool(clientManager, docManager)],
    ["lsp_semantic_tokens", createLspSemanticTokensTool(clientManager, docManager)],
    ["lsp_code_lens", createLspCodeLensTool(clientManager, docManager)],
    ["lsp_inlay_hints", createLspInlayHintsTool(clientManager, docManager)],
    ["lsp_document_links", createLspDocumentLinksTool(clientManager, docManager)],
    ["lsp_document_colors", createLspDocumentColorsTool(clientManager, docManager)],
    ["lsp_servers", createLspServersTool(clientManager)],
    ["lsp_restart_server", createLspRestartServerTool(clientManager)],
  ];

  const result: Record<string, LspTool> = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
}
