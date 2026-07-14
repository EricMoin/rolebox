import { readFile } from "node:fs/promises";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { canonicalizeFileText, computeFileVersion, hashWidthForLineCount, restoreFileText } from "./hash.ts";
import { normalizeEdits, applyEditsWithReport } from "./edit-primitives.ts";
import { validateVersion } from "./validation.ts";
import { reanchorChangedLines, generateUnifiedDiff, countLineDiffs } from "./diff.ts";
import { detectUniformOffset, suggestCorrectAnchor } from "./fuzzy.ts";
import { atomicWriteFile, atomicWriteBatch } from "./atomic-write.ts";
import { collectLineRefs } from "./edit-ordering.ts";
import type { EditOp, HashMismatch } from "./types.ts";

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
): Promise<{
  filePath: string;
  version: string;
  diff: string;
  additions: number;
  deletions: number;
  reanchored: string;
  error?: string;
  content?: string;
  correctionsApplied?: Array<{old: string; new: string}>;
  noopEdits?: number;
  deduplicatedEdits?: number;
}> {
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
          filePath, version: "", diff: "", additions: 0, deletions: 0, reanchored: "",
          error: `File not found: ${filePath}. Cannot apply anchor-based edits to a non-existent file. Use anchorless append/prepend to create a new file.`,
        };
      }
      raw = "";
    } else {
      return {
        filePath, version: "", diff: "", additions: 0, deletions: 0, reanchored: "",
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
        filePath, version: actualVersion, diff: "", additions: 0, deletions: 0, reanchored: "",
        error: `File version mismatch for ${filePath}: expected ${expectedVersion}, got ${actualVersion}. Re-read the file with hashline_read to get the current version.`,
      };
    }
  }

  const lineCount = canonicalContent === "" ? 0 : canonicalContent.split("\n").length;
  const hashWidth = hashWidthForLineCount(lineCount);

  // Validate per-file hashWidth if provided
  if (providedHashWidth !== undefined && providedHashWidth !== hashWidth) {
    return {
      filePath, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
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
              filePath, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
              error: buildHashMismatchErrorDetail(retryErr.mismatches, retryErr.fileLines, hashWidth),
            };
          }
          throw retryErr;
        }
      } else {
        return {
          filePath, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
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
      filePath, version: computeFileVersion(canonicalContent), diff: "", additions: 0, deletions: 0, reanchored: "",
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
    filePath, version: newVersion, diff, additions, deletions, reanchored: reanchoredStr, content: finalContent,
    correctionsApplied, noopEdits: noopEditCount, deduplicatedEdits: dedupEditCount,
  };
}

export function createHashlineEditTool() {
  return defineTool({
    description:
      "Edit a file using LINE#HASH anchors obtained from hashline_read.\n" +
      "\n" +
      "WORKFLOW:\n" +
      "  1. Read the file with hashline_read \u2014 copy the `version` and exact LINE#HASH anchors\n" +
      "  2. Submit one hashline_edit call per file with the anchors from that read\n" +
      "  3. If you need to edit the same file again, re-read it first to get fresh anchors\n" +
      "\n" +
      "SNAPSHOT SEMANTICS:\n" +
      "  All edits reference the ORIGINAL file state. Hashes are validated against the\n" +
      "  original file and edits are applied bottom-up so indices stay correct even with\n" +
      "  multiple edits in the same call.\n" +
      "\n" +
      "OPERATIONS:\n" +
      "  replace (default) \u2014 Replace line(s) at pos..end (inclusive) with new content.\n" +
      "    - pos: single anchor or start of range\n" +
      "    - end: end anchor for range (omit for single-line replace)\n" +
      "    - lines: replacement content (no anchors, no diff markers)\n" +
      "    - Omit lines or set to empty string/array to delete the line(s)\n" +
      "\n" +
      "  append \u2014 Insert content after the anchor line (or at EOF if no pos).\n" +
      "    - pos: anchor to insert after (omit for EOF)\n" +
      "    - lines: content to insert\n" +
      "\n" +
      "  prepend \u2014 Insert content before the anchor line (or at BOF if no pos).\n" +
      "    - pos: anchor to insert before (omit for BOF)\n" +
      "    - lines: content to insert\n" +
      "\n" +
      "RULES:\n" +
      "  - lines must contain ONLY the replacement content (no anchors, no diff markers)\n" +
      "  - Tags (LINE#HASH) must be copied exactly from read output\n" +
      "  - Batch = multiple operations in edits[], NOT one big replace\n" +
      "  - Use separate edit calls for separate files (or batch them in files[])\n" +
      "  - After editing, re-read the file to get updated anchors for subsequent edits\n" +
      "\n" +
      "Returns:\n" +
      "  version: <new SHA-256>\n" +
      "  files:\n" +
      "    filePath: <path>\n" +
      "    version: <sha256>\n" +
      "    diff: <unified diff>\n" +
      "    additions: <number>\n" +
      "    deletions: <number>\n" +
      "    reanchored:\n" +
      "      line N: <oldHash> -> <newHash>",
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

      const results: Array<{
        filePath: string;
        version: string;
        diff: string;
        additions: number;
        deletions: number;
        reanchored: string;
        error?: string;
        content?: string;
        correctionsApplied?: Array<{old: string; new: string}>;
        noopEdits?: number;
        deduplicatedEdits?: number;
      }> = [];

      for (const file of files) {
        const result = await processSingleFile(file.filePath, file.edits, file.version, file.hashWidth);
        results.push(result);
        if (result.error) {
          break;
        }
      }

      const errors = results.filter((r) => r.error);
      if (errors.length > 0) {
        const output: string[] = ["Error: Edit failed."];
        for (const err of errors) {
          output.push(err.error!);
        }
        return output.join("\n");
      }

      const writes: Array<{ filePath: string; content: string }> = [];
      for (let i = 0; i < files.length; i++) {
        writes.push({ filePath: files[i].filePath, content: results[i].content! });
      }

      if (writes.length === 1) {
        await atomicWriteFile(writes[0].filePath, writes[0].content);
      } else {
        await atomicWriteBatch(writes);
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
  });
}
