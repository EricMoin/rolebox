// ---------------------------------------------------------------------------
// LSP Protocol Types — subset of the LSP JSON-RPC spec
// ---------------------------------------------------------------------------

/** 0-based line/character position in a text document. */
export interface Position {
  line: number;
  character: number;
}

/** A range in a text document (start is inclusive, end is exclusive). */
export interface Range {
  start: Position;
  end: Position;
}

/** A location inside a resource (document URI + range). */
export interface Location {
  uri: string;
  range: Range;
}

/** Diagnostic severity levels. */
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

/** Related information for a diagnostic. */
export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

/** A diagnostic (warning, error, hint) in a text document. */
export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

/** Symbol kind enum (1-26). */
export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

/** Symbol information (workspace symbol result). */
export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

/** Document symbol (hierarchical). */
export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** Completion item kind enum (1-25). */
export enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

/** Completion item. */
export interface CompletionItem {
  label: string;
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string | MarkupContent;
  insertText?: string;
  insertTextFormat?: number;
}

/** Markup content (plaintext or markdown). */
export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

/** Marked string (plain string or tagged code block). */
export type MarkedString = string | { language: string; value: string };

/** Hover result. */
export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
}

/** Signature help. */
export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

/** Signature information. */
export interface SignatureInformation {
  label: string;
  documentation?: string | MarkupContent;
  parameters?: ParameterInformation[];
}

/** Parameter information. */
export interface ParameterInformation {
  label: string;
  documentation?: string | MarkupContent;
}

/** A text edit (single replacement). */
export interface TextEdit {
  range: Range;
  newText: string;
}

/** Workspace edit (collection of changes). */
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: any[];
}

/** A command to execute. */
export interface Command {
  title: string;
  command: string;
  arguments?: any[];
}

/** Code action (quick fix / refactoring). */
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: Command;
}

/** Code lens. */
export interface CodeLens {
  range: Range;
  command?: Command;
  data?: any;
}

/** Folding range. */
export interface FoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: string;
}

/** Selection range. */
export interface SelectionRange {
  range: Range;
  parent?: SelectionRange;
}

/** Inlay hint label part. */
export interface InlayHintLabelPart {
  value: string;
  tooltip?: string;
  location?: Location;
  command?: Command;
}

/** Inlay hint. */
export interface InlayHint {
  position: Position;
  label: string | InlayHintLabelPart[];
  kind?: number;
  textEdits?: TextEdit[];
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** Call hierarchy item. */
export interface CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  detail?: string;
  data?: any;
}

/** Incoming call (from caller). */
export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

/** Outgoing call (to callee). */
export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

/** Type hierarchy item. */
export interface TypeHierarchyItem {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  detail?: string;
  data?: any;
}

/** Semantic tokens (flat array of uint32). */
export interface SemanticTokens {
  data: number[];
}

/** Document link. */
export interface DocumentLink {
  range: Range;
  target?: string;
  tooltip?: string;
}

/** Color information. */
export interface ColorInformation {
  range: Range;
  color: Color;
}

/** RGBA color. */
export interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** Document highlight kind enum. */
export enum DocumentHighlightKind {
  Text = 1,
  Read = 2,
  Write = 3,
}

/** Document highlight. */
export interface DocumentHighlight {
  range: Range;
  kind?: DocumentHighlightKind;
}

// ---------------------------------------------------------------------------
// Internal server types
// ---------------------------------------------------------------------------

/** Configuration for a single language server. */
export interface LspServerConfig {
  languageId: string;
  command: string;
  args?: string[];
  rootUri: string;
  initializationOptions?: Record<string, unknown>;
  filePatterns: string[];
  extensions: string[];
}

/** Runtime state of a spawned language server. */
export interface LspServerState {
  languageId: string;
  process: any;
  capabilities: any;
  status: "starting" | "running" | "dead" | "failed";
  startedAt: Date;
  pendingRequests: Map<
    number,
    { resolve: Function; reject: Function; timeout: any }
  >;
  diagnosticCache: Map<string, Diagnostic[]>;
  restartCount: number;
}

/** LSP initialize parameters (params of 'initialize' request). */
export interface InitializeParams {
  processId: number | null;
  clientInfo?: { name: string; version?: string };
  locale?: string;
  rootPath?: string | null;
  rootUri: string | null;
  capabilities: any;
  initializationOptions?: Record<string, unknown>;
  trace?: "off" | "messages" | "verbose";
  workspaceFolders?: { uri: string; name: string }[] | null;
}

/** LSP initialize result. */
export interface InitializeResult {
  capabilities: any;
  serverInfo?: { name?: string; version?: string };
}
