/** A line anchor: line number + hash */
export interface HashAnchor {
  line: number;  // 1-based
  hash: string;  // e.g., "aB" (2 chars), "aBc" (3 chars)
}

/** File version digest */
export interface FileVersion {
  version: string;       // SHA-256 hex digest (64 chars)
  algorithm: "sha256";
}

/** Replace operation: replace line(s) at pos..end with new content */
export interface ReplaceOp {
  op: "replace";
  pos: string;           // "LINE#HASH" anchor
  end?: string;          // "LINE#HASH" anchor for range replace (inclusive)
  lines: string | string[]; // new content (no anchors)
}

/** Append operation: insert after pos (or EOF if no pos) */
export interface AppendOp {
  op: "append";
  pos?: string;          // "LINE#HASH" anchor (optional — EOF if omitted)
  lines: string | string[];
}

/** Prepend operation: insert before pos (or BOF if no pos) */
export interface PrependOp {
  op: "prepend";
  pos?: string;          // "LINE#HASH" anchor (optional — BOF if omitted)
  lines: string | string[];
}

/** Union of all edit operations */
export type EditOp = ReplaceOp | AppendOp | PrependOp;

/** Raw edit from tool args (before normalization) */
export interface RawEditOp {
  op?: "replace" | "append" | "prepend";
  pos?: string;
  end?: string;
  lines?: string | string[] | null;
}

/** Per-file edit request */
export interface FileEditRequest {
  filePath: string;
  edits: RawEditOp[];
}

/** Result of re-anchoring a single changed line */
export interface ReanchoredLine {
  line: number;
  oldAnchor: string;
  newAnchor: string;
  newContent: string;
}

/** Result of editing a single file */
export interface EditFileResult {
  filePath: string;
  version: string;           // new SHA-256 after edit
  diff: string;              // unified diff
  additions: number;
  deletions: number;
  reanchored: ReanchoredLine[];
}

/** Result of a batch edit (multi-file) */
export interface BatchEditResult {
  files: EditFileResult[];
  success: boolean;
  error?: string;
}

/** Read tool result */
export interface ReadResult {
  filePath: string;
  version: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  hashWidth: number;
  lines: string[];           // annotated: "LINE#HASH|content"
}

/** File text envelope for canonicalization */
export interface FileTextEnvelope {
  content: string;
  hadBom: boolean;
  lineEnding: "\n" | "\r\n";
}

/** A hash mismatch for error reporting */
export interface HashMismatch {
  line: number;
  expected: string;
  actual?: string;
}
