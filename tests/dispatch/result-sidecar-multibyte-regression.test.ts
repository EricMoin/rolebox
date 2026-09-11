import { describe, it, expect, afterAll } from "bun:test";
import {
  spillToFile,
  applySidecarWindow,
  readSidecarTail,
} from "../../src/dispatch/completion/result-extractor.ts";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Regression: multibyte (CJK) sidecar windowing ────────────────────
//
// Defect under test: src/dispatch/completion/result-extractor.ts
// `readSidecarWindow` (lines 149-191) treats `offset`/`limit` as BYTE
// offsets (`readSync` seeks at `offset` bytes), while the `applyWindow`
// contract (lines 72-94) defines them as CHARACTER offsets. The +4 byte
// safety margin (line 164) only aligns the read boundary; `applySidecarWindow`
// then advances `nextOffset` (line 294) by *character* count, which the next
// call consumes as *bytes* — cumulative drift on multi-byte content.
// `readSidecarTail` (lines 201-248) has the same byte-vs-character confusion.
//
// Both assertions encode the CORRECT behavior (window reads must return
// precise contiguous character slices; tail must return exactly N characters).
// They fail against the current implementation — this test is the regression
// sentinel. Do NOT fix the implementation to make this pass; the defect fix
// belongs in the source.

// CJK payload: 200 lines, each containing multi-byte characters.
const fullText = Array.from({ length: 200 }, (_, i) => "这是中文内容行，包含多字节字符。line " + i).join("\n");

// Setup runs at collection time: spill the payload to a throwaway sidecar.
const tmpDir = join(tmpdir(), `result-sidecar-mb-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tmpDir, { recursive: true });
const sidecar = spillToFile("task-mb-1", fullText, tmpDir);

describe("result sidecar multibyte regression", () => {
  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("window reads return precise contiguous character slices (no multibyte drift)", () => {
    const w1 = applySidecarWindow(sidecar, { maxChars: 120, offset: 0, limit: 120 }, fullText.length);
    expect(w1).not.toBeNull();
    const off2 = w1!.nextOffset;
    expect(off2).toBeDefined();

    const w2 = applySidecarWindow(sidecar, { maxChars: 120, offset: off2!, limit: 120 }, fullText.length);
    expect(w2).not.toBeNull();
    // Character-offset contract: window 2 must be the exact slice following window 1.
    // Today this fails — window 2 is byte-seeked and returns drifted/mojibake CJK content.
    expect(w2!.text).toBe(fullText.slice(off2!, off2! + w2!.text.length));
  });

  it("tail returns exactly the requested number of characters", () => {
    const tail = readSidecarTail(sidecar, 100);
    expect(tail).not.toBeNull();
    // Character contract: tail must return exactly N characters.
    // Today this fails — tail is byte-counted and returns fewer CJK characters.
    expect(tail!.length).toBe(100);
  });
});
