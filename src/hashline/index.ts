// Foundation exports
export {
  computeLineHash,
  computeFileVersion,
  formatHashLine,
  formatHashLines,
  hashWidthForLineCount,
  canonicalizeFileText,
  restoreFileText,
} from "./hash.ts";
export {
  BASE64_DICT,
  HASHLINE_REF_PATTERN,
  HASHLINE_REF_EXTRACT_PATTERN,
  MISMATCH_CONTEXT,
  FUZZY_SEARCH_WINDOW,
} from "./constants.ts";
export type {
  HashAnchor,
  FileVersion,
  EditOp,
  ReplaceOp,
  AppendOp,
  PrependOp,
  RawEditOp,
  FileEditRequest,
  ReanchoredLine,
  EditFileResult,
  BatchEditResult,
  ReadResult,
  FileTextEnvelope,
  HashMismatch,
} from "./types.ts";

// Tool creation functions
export { createHashlineReadTool } from "./hashline-read.ts";
export { createHashlineEditTool } from "./hashline-edit.ts";

// Re-export key utilities for external use
export { applyEditsWithReport, normalizeEdits } from "./edit-primitives.ts";
export { parseLineRef, validateLineRef, validateLineRefs, validateVersion, HashlineMismatchError } from "./validation.ts";
export { myersDiff, reanchorChangedLines, generateUnifiedDiff, countLineDiffs } from "./diff.ts";
export { findNearbyMatch, suggestCorrectAnchor, detectUniformOffset } from "./fuzzy.ts";
export { atomicWriteFile, atomicWriteBatch } from "./atomic-write.ts";
