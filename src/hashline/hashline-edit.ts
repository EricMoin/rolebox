import { readFile } from "node:fs/promises";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { canonicalizeFileText, computeFileVersion, hashWidthForLineCount, restoreFileText } from "./hash.ts";
import { normalizeEdits, applyEditsWithReport } from "./edit-primitives.ts";
import { validateVersion } from "./validation.ts";
import { reanchorChangedLines, generateUnifiedDiff, countLineDiffs } from "./diff.ts";
import { detectUniformOffset, suggestCorrectAnchor } from "./fuzzy.ts";
import { atomicWriteFile, atomicWriteBatch, verifyFileUnchanged } from "./atomic-write.ts";
import { normalizeLockKey, withPathLocks } from "./path-lock.ts";
import { collectLineRefs } from "./edit-ordering.ts";
import type { EditOp, HashMismatch, RawEditOp, FileEditRequest } from "./types.ts";

/** Per-file edit input, as accepted by createHashlineEditTool. */
export interface HashlineEditInputFile extends FileEditRequest {
  hashWidth?: number;
}

/**
 * Internal test-only hooks for createHashlineEditTool.
 *
 * `beforeWrite` is invoked while all path locks are held, after every file's
 * edit has been computed and before the pre-write version recheck. It defaults
 * to no behavior and is intentionally NOT part of the public tool schema or the
 * user-facing tool documentation — it exists to let tests inject deterministic
 * external modifications into the read → recheck window.
 */
export interface HashlineEditToolHooks {
  beforeWrite?: (ctx: {
    files: HashlineEditInputFile[];
    writes: Array<{ filePath: string; content: string }>;
  }) => void | Promise<void>;
}

/** Per-file result of the read → validate → compute pipeline. */
export interface ProcessedFileResult {
  filePath: string;
  version: string;
  /** True when the file existed at read phase (false for to-be-created files). */
  existed: boolean;
  diff: string;
  additions: number;
  deletions: number;
  reanchored: string;
  error?: string;
  content?: string;
  correctionsApplied?: Array<{old: string; new: string}>;
  noopEdits?: number;
  deduplicatedEdits?: number;
}

function remapEditAnchors(edits: EditOp[], corrections: Map<string, string>): EditOp[] {
  return edits.map((edit) => {
    if (edit.op !== "replace") return edit;
    const newPos = edit.pos && corrections.has(edit.pos) ? corrections.get(edit.pos)! : edit.pos;
    const newEnd = edit.end && corrections.has(edit.end) ? corrections.get(edit.end)! : edit.end;
    if (newPos === edit.pos && newEnd === edit.end) return edit;
    return { ...edit, pos: newPos, end: newEnd } as EditOp;
  });
}

function buildHashMismatchErrorDetail(
  mismatches: HashMismatch[],
  fileLines: string[],
  hashWidth: number,
): string {
  const lines: string[] = [
    "Hashline verification failed. The following anchors could not be validated:",
    "",
  ];
  for (const mismatch of mismatches) {
    const suggestion = suggestCorrectAnchor(mismatch, fileLines, hashWidth);
    const lineInfo = `  Line ${mismatch.line}: expected hash "${mismatch.expected}", got "${mismatch.actual ?? "(line does not exist)"}"`;
    lines.push(lineInfo);
    if (suggestion) {
      lines.push(`  \u2192 ${suggestion}`);
    }
    lines.push("");
  }
  lines.push("Re-read the file with hashline_read to get fresh anchors and version, then retry.");
  return lines.join("\n");
}

function isHashMismatchError(err: unknown): err is { mismatches: HashMismatch[]; fileLines: string[] } {
  if (!(err instanceof Error)) return false;
  const e = err as unknown as Record<string, unknown>;
  return (
    e.name === "HashlineMismatchError" &&
    Array.isArray(e.mismatches) &&
    Array.isArray(e.fileLines)
  );
}

async function processSingleFile(
  filePath: string,
  rawEdits: Array<{
    op?: "replace" | "append" | "prepend";
    pos?: string;
    end?: string;
    lines?: string | string[] | null;
  }>,
  expectedVersion: string,
  providedHashWidth?: number,
): Promise<ProcessedFileResult> {
  let raw: string;
  let fileExisted = true;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      fileExisted = false;
      const normalizedEdits = normalizeEdits(rawEdits);
      const refs = collectLineRefs(normalizedEdits);
      if (refs.length > 0) {
        return {
          filePath, existed: fileExisted, version: "", diff: "", additions: 0, deletions: 0, reanchored: "",
          error: `File not found: ${filePath}. Cannot apply anchor-based edits to a non-existent file. Use anchorless append/prepend to create a new file.`,
        };
      }
      raw = "";
    } else {
      return {
        filePath, existed: fileExisted, version: "", diff: "", additions: 0, deletions: 0, reanchored: "",
        error: `Error reading file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const envelope = canonicalizeFileText(raw);
  const canonicalContent = envelope.content;

  if (fileExisted) {
    const actualVersion = computeFileVersion(canonicalContent);
    try {
      validateVersion(expectedVersion, actualVersion);
    } catch {
      return {
        filePath, existed: fileExisted, version: actualVersion, diff: "", additions: 0, deletions: 0, reanchored: "",
        error: `File version mismatch for ${filePath}: expected ${expectedVersion}, got ${actualVersion}. Re-read the file with hashline_read to get the current version.`,
      };
    }
  }

  const lineCount = canonicalContent === "" ? 0 : canonicalContent.split("\n").length;
  const hashWidth = hashWidthForLineCount(lineCount);

  // Validate per-file hashWidth if provided
  if (providedHashWidth !== undefined && providedHashWidth !== hashWidth) {
    return {
      filePath, existed: fileExisted, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
      error: `hashWidth mismatch for ${filePath}: expected ${providedHashWidth} from read output, computed ${hashWidth} from file`,
    };
  }

  const normalizedEdits = normalizeEdits(rawEdits);

  let resultContent: string;
  let correctionsApplied: Array<{old: string; new: string}> | undefined;
  let noopEditCount = 0;
  let dedupEditCount = 0;

  try {
    const editResult = applyEditsWithReport(canonicalContent, normalizedEdits, hashWidth);
    resultContent = editResult.content;
    noopEditCount = editResult.noopEdits;
    dedupEditCount = editResult.deduplicatedEdits;
  } catch (err: unknown) {
    if (isHashMismatchError(err)) {
      const corrections = detectUniformOffset(err.mismatches, err.fileLines, hashWidth);
      if (corrections && corrections.size > 0) {
        correctionsApplied = Array.from(corrections.entries()).map(([oldRef, newRef]) => ({ old: oldRef, new: newRef }));
        const correctedEdits = remapEditAnchors(normalizedEdits, corrections);
        try {
          const editResult = applyEditsWithReport(canonicalContent, correctedEdits, hashWidth);
          resultContent = editResult.content;
          noopEditCount = editResult.noopEdits;
          dedupEditCount = editResult.deduplicatedEdits;
        } catch (retryErr: unknown) {
          if (isHashMismatchError(retryErr)) {
            return {
              filePath, existed: fileExisted, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
              error: buildHashMismatchErrorDetail(retryErr.mismatches, retryErr.fileLines, hashWidth),
            };
          }
          throw retryErr;
        }
      } else {
        return {
          filePath, existed: fileExisted, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
          error: buildHashMismatchErrorDetail(err.mismatches, err.fileLines, hashWidth),
        };
      }
    } else {
      throw err;
    }
  }

  const trailingNewlineCount = canonicalContent.match(/\n+$/)?.[0].length ?? 0;
  let finalContent = resultContent;
  // Strip all trailing newlines, then reapply exactly the original count
  finalContent = finalContent.replace(/\n+$/, "");
  finalContent = finalContent + "\n".repeat(trailingNewlineCount);

  if (finalContent === canonicalContent) {
    return {
      filePath, existed: fileExisted, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
      correctionsApplied, noopEdits: noopEditCount, deduplicatedEdits: dedupEditCount,
      error: `No changes were made to ${filePath}. The resulting content is identical to the original. Re-read the file and provide different edit content.`,
    };
  }

  finalContent = restoreFileText(finalContent, envelope);
  const newVersion = computeFileVersion(resultContent);
  const oldLines = canonicalContent === "" ? [] : canonicalContent.split("\n");
  const newLines = resultContent === "" ? [] : resultContent.split("\n");
  const diff = generateUnifiedDiff(canonicalContent, resultContent, filePath);
  const { additions, deletions } = countLineDiffs(canonicalContent, resultContent);
  const reanchoredLines = reanchorChangedLines(oldLines, newLines, hashWidth);

  const reanchoredStr = reanchoredLines
    .map((r) => {
      const oldStr = r.oldAnchor;
      const newStr = r.newAnchor || "(deleted)";
      return `    line ${r.line}: ${oldStr} \u2192 ${newStr}`;
    })
    .join("\n");

  return {
    filePath, existed: fileExisted, version: newVersion, diff, additions, deletions, reanchored: reanchoredStr, content: finalContent,
    correctionsApplied, noopEdits: noopEditCount, deduplicatedEdits: dedupEditCount,
  };
}

export function createHashlineEditTool(hooks: HashlineEditToolHooks = {}) {
  return defineTool({
    description:
      "Edit a file using LINE#HASH anchors obtained from hashline_read. " +
      "Use this after reading a file with hashline_read — copy the version and anchors, then submit edits. " +
      "All edits reference the ORIGINAL file state and are applied bottom-up. " +
      "Supports replace (single or range), append (after anchor or EOF), and prepend (before anchor or BOF). " +
      "Returns version, per-file diff with additions/deletions, and a reanchored map of old -> new hashes. " +
      "Concurrency: edits to the same file are serialized within this process, and each file is re-checked " +
      "against its version immediately before writing — a stale version is rejected without writing anything. " +
      "Duplicate file paths in one batch are rejected. Limits: serialization is in-process only (no cross-process locking); " +
      "batches are not cross-file transactions; writes are not fsync-durable.",
    args: {
      files: z
        .array(
          z.object({
            filePath: z.string().describe("Absolute path to the file to edit"),
            version: z.string().describe("SHA-256 version from your last hashline_read of each file. Used to detect external modifications."),
            hashWidth: z.number().int().min(2).max(8).optional().describe("Optional hashWidth from read output. If provided, validated against the file's actual line count."),
            edits: z
              .array(
                z.object({
                  op: z
                    .enum(["replace", "append", "prepend"])
                    .default("replace")
                    .describe("Operation type: replace (default), append, or prepend"),
                  pos: z
                    .string()
                    .optional()
                    .describe(
                      'LINE#HASH anchor, e.g. "10#aB". The line to target, from hashline_read output.',
                    ),
                  end: z
                    .string()
                    .optional()
                    .describe(
                      'End anchor for range replace, e.g. "15#cD". Inclusive. Omit for single-line replace.',
                    ),
                  lines: z
                    .union([z.string(), z.array(z.string())])
                    .optional()
                    .describe(
                      "New content for the replace/insert. Must NOT include anchors, diff markers, or anchor echoes.",
                    ),
                }),
              )
              .min(1)
              .describe("Edit operations to apply to this file"),
          }),
        )
        .min(1)
        .describe("Files to edit"),
    },
    async execute(input) {
      const files = input.files;

      // ── Duplicate-path rejection ──
      // Must happen BEFORE any read, write, or lock acquisition (zero side
      // effects). Two entries for the same path in one batch would validate
      // independently and then silently overwrite each other during the write
      // phase. Uses the same normalized key as the lock, so platform-appropriate
      // case aliases are rejected too.
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const file of files) {
        const key = normalizeLockKey(file.filePath);
        const first = seen.get(key);
        if (first !== undefined) {
          duplicates.push(`"${file.filePath}" (duplicate of "${first}")`);
        } else {
          seen.set(key, file.filePath);
        }
      }
      if (duplicates.length > 0) {
        return (
          "Error: Duplicate filePath in edit batch: " +
          duplicates.join(", ") +
          ". Merge the edits for each file into a single entry, then retry."
        );
      }

      // ── Locked critical section ──
      // One lock per distinct path, acquired in globally sorted key order
      // (deadlock-free for overlapping concurrent batches), held across the
      // entire read → version validate → edit compute → pre-write recheck →
      // write cycle, and released in reverse order on every path (success,
      // per-file error, or exception).
      try {
        return await withPathLocks(
          files.map((f) => f.filePath),
          async (): Promise<string> => {
            const results: ProcessedFileResult[] = [];

            for (const file of files) {
              const result = await processSingleFile(file.filePath, file.edits, file.version, file.hashWidth);
              results.push(result);
            }

            const errors = results.filter((r) => r.error);
            if (errors.length > 0) {
              const output: string[] = ["Error: Edit failed for some files."];
              const successes = results.filter((r) => !r.error);
              if (successes.length > 0) {
                output.push("");
                output.push("Succeeded files:");
                for (const s of successes) {
                  output.push(`  ${s.filePath}`);
                }
              }
              output.push("");
              output.push("Failed files:");
              for (const err of errors) {
                output.push(`  ${err.filePath}: ${err.error}`);
              }
              return output.join("\n");
            }

            const writes: Array<{ filePath: string; content: string }> = [];
            for (let i = 0; i < files.length; i++) {
              writes.push({ filePath: files[i].filePath, content: results[i].content! });
            }

            // Internal test-only seam: after edit computation, before the
            // pre-write recheck. Default: no behavior.
            await hooks.beforeWrite?.({ files, writes });

            // ── Pre-write revalidation (best-effort CAS) ──
            // Re-read every file and confirm it still matches the version
            // observed during the read phase (for to-be-created files: still
            // absent). Any conflict fails the whole batch before a single byte
            // is written, preserving the existing zero-write-on-validation-
            // failure semantics.
            const conflicts: string[] = [];
            for (let i = 0; i < files.length; i++) {
              const baseline = results[i].existed ? files[i].version : null;
              const conflict = await verifyFileUnchanged(files[i].filePath, baseline);
              if (conflict !== null) conflicts.push(conflict);
            }
            if (conflicts.length > 0) {
              const lines = [
                "Error: Edit failed: files changed while the edit was being computed. No files were written.",
                "",
                ...conflicts,
                "",
                "Re-read each file with hashline_read to get fresh versions and anchors, then retry.",
              ];
              return lines.join("\n");
            }

            try {
              if (writes.length === 1) {
                await atomicWriteFile(writes[0].filePath, writes[0].content);
              } else {
                await atomicWriteBatch(writes);
              }
            } catch (err) {
              return `Write failed: file system error (${err instanceof Error ? err.message : String(err)}).`;
            }

            const output: string[] = [];
            output.push(`version: ${results[0].version}`);
            output.push("files:");

            for (const result of results) {
              output.push(`  filePath: ${result.filePath}`);
              output.push(`  version: ${result.version}`);
              output.push(`  diff: |`);
              const diffLines = result.diff.split("\n");
              for (const line of diffLines) {
                output.push(`    ${line}`);
              }
              output.push(`  additions: ${result.additions}`);
              output.push(`  deletions: ${result.deletions}`);
              if (result.reanchored) {
                output.push(`  reanchored:`);
                output.push(result.reanchored);
              }
              if (result.correctionsApplied && result.correctionsApplied.length > 0) {
                output.push(`  corrections_applied:`);
                for (const c of result.correctionsApplied) {
                  output.push(`    ${c.old} -> ${c.new}`);
                }
              }
              if (result.noopEdits && result.noopEdits > 0) {
                output.push(`  noop_edits: ${result.noopEdits}`);
              }
              if (result.deduplicatedEdits && result.deduplicatedEdits > 0) {
                output.push(`  deduplicated_edits: ${result.deduplicatedEdits}`);
              }
              output.push("");
            }

            return output.join("\n");
          },
        );
      } catch (err) {
        // Unexpected internal failure (e.g. a revalidation read error). Keep the
        // tool's string-return contract — never throw.
        return `Error: Edit failed: ${err instanceof Error ? err.message : String(err)}.`;
      }
    },
  });
}
