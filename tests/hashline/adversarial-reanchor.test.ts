import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ── Adversarial reanchor-correctness suite ────────────────────────────────
//
// Target defects under adversarial probe (do NOT "fix" the implementation —
// this suite asserts the CORRECT contract; a failing assertion is the
// reproduction of the defect, exactly like the other hashline regression
// suites in this directory):
//
//   D6b — src/hashline/diff.ts:41-45 (reanchorChangedLines, insert branch)
//     The insert entry's oldAnchor is computed from a phantom "" content
//     seeded with entry.newLine. Because "" is a symbol-only line it gets
//     line-number seeding (src/hashline/hash.ts:63-66), so the phantom
//     oldAnchor coincides with the real pre-edit read anchor ONLY when the
//     old line at the insert position was itself empty. Any non-empty old
//     line at that position produces oldAnchor ≠ pre-edit read anchor.
//
//   D7 — src/hashline/fuzzy.ts:11-31 (findNearbyMatch)
//     (i) Search order is below-first at every distance ("就近匹配优先下方"),
//         so an ambiguous duplicate match resolves to the WRONG (lower) line.
//     (ii) For symbol-only lines the line-number seed makes the hash
//         position-dependent, so a shifted symbol line can never be matched
//         and detectUniformOffset (fuzzy.ts:67-101) aborts the correction.
//
//   D-g — src/hashline/hashline-edit.ts:52-60 (remapEditAnchors)
//     Corrections from detectUniformOffset are only applied to edits with
//     op === "replace"; append/prepend edits keep their stale anchor and the
//     retry fails — the fuzzy correction never reaches non-replace ops.
//
// Each `it` logs its observed values (actual anchors, corrections, edited
// lines) so the captured test output contains the reproduction evidence.

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── Helpers ────────────────────────────────────────────────────────────────

type RawEdit = {
  op?: "replace" | "append" | "prepend";
  pos?: string;
  end?: string;
  lines?: string | string[] | null;
};

async function newTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Read through the real tool; return version + line→hash map. */
async function readState(filePath: string): Promise<{ version: string; hashByLine: Map<number, string> }> {
  const out = String(await createHashlineReadTool().execute({ filePath }));
  const version = out.match(/^version: (\S+)$/m)?.[1] ?? "";
  const hashByLine = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (m) hashByLine.set(parseInt(m[1], 10), m[2]);
  }
  return { version, hashByLine };
}

async function runEdit(filePath: string, version: string, edits: RawEdit[]): Promise<string> {
  return String(await createHashlineEditTool().execute({ files: [{ filePath, version, edits }] }));
}

function anchorFor(hashByLine: Map<number, string>, line: number): string {
  return `${line}#${hashByLine.get(line)}`;
}

/** Parse the tool's `reanchored:` section: `line N: oldAnchor → newAnchor`. "(deleted)" = newAnchor "". */
function parseReanchored(out: string): Array<{ line: number; oldAnchor: string; newAnchor: string }> {
  const entries: Array<{ line: number; oldAnchor: string; newAnchor: string }> = [];
  for (const m of out.matchAll(/line (\d+): (\S+) → (\S+)/g)) {
    entries.push({ line: parseInt(m[1], 10), oldAnchor: m[2], newAnchor: m[3] });
  }
  return entries;
}

/** Parse the tool's `corrections_applied:` section. */
function parseCorrections(out: string): string[] {
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => l.includes("corrections_applied:"));
  if (idx === -1) return [];
  const res: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{4}(\d+#\S+) -> (\d+#\S+)/);
    if (m) res.push(`${m[1]} -> ${m[2]}`);
    else if (lines[i].trim() !== "") break;
  }
  return res;
}

// ── (a) content-line insertion: oldAnchor must equal the pre-edit anchor ──
//
// Insert a content line "beta" after line 1 of a file whose line 2 is EMPTY.
// The insert lands on the empty line, so the phantom "" oldAnchor (seeded
// with the insert position) coincides with the real pre-edit anchor of that
// empty line → the contract HOLDS (PASS).

describe("(a) content-line insertion — reanchor oldAnchor vs pre-edit read", () => {
  it("oldAnchor === pre-edit read anchor at the reported line (contract holds)", async () => {
    const tmp = await newTmp("adversarial-reanchor-a-");
    const filePath = join(tmp, "a.txt");
    // line 2 is an empty line
    await writeFile(filePath, "alpha\n\nomega\n", "utf-8");

    const pre = await readState(filePath);
    const out = await runEdit(filePath, pre.version, [
      { op: "append", pos: anchorFor(pre.hashByLine, 1), lines: "beta" },
    ]);
    expect(out).not.toContain("Error:");

    const entries = parseReanchored(out);
    const ins = entries.find((e) => e.newAnchor !== "(deleted)");
    expect(ins).toBeDefined();

    console.log(`[a] map entry: line ${ins!.line}: ${ins!.oldAnchor} → ${ins!.newAnchor}`);
    console.log(`[a] pre-edit read hash@${ins!.line} = ${pre.hashByLine.get(ins!.line)}`);
    console.log(`[a] oldAnchor === pre-edit read anchor? ${ins!.oldAnchor === pre.hashByLine.get(ins!.line)}`);

    // CONTRACT: the insert entry's oldAnchor is the anchor a pre-edit read
    // produced at that line (the caller's old reference stays valid).
    expect(ins!.oldAnchor).toBe(pre.hashByLine.get(ins!.line));

    // Consistency cross-check: the newAnchor must equal a post-edit fresh
    // read hash at the same line (holds for content lines — no seeding).
    const post = await readState(filePath);
    expect(ins!.newAnchor).toBe(post.hashByLine.get(ins!.line));
  });
});

// ── (b) symbol-line insertion: oldAnchor must equal the pre-edit anchor ──
//
// Insert a symbol line "}" after line 1 of a file whose line 2 is ALSO "}".
// Myers aligns the existing "}" as equal, so the insert lands at line 3 —
// over old line 3 ("omega"). The insert entry's oldAnchor is the phantom
// "" hash seeded with the new line number (diff.ts:41-45), which cannot
// equal the pre-edit anchor of "omega" → contract VIOLATED (D6b reproduced).

describe("(b) symbol-line insertion — reanchor oldAnchor vs pre-edit read (D6b)", () => {
  it("oldAnchor === pre-edit read anchor at the reported line (FAILS today: D6b)", async () => {
    const tmp = await newTmp("adversarial-reanchor-b-");
    const filePath = join(tmp, "b.txt");
    // line 2 is a symbol-only line "}"
    await writeFile(filePath, "alpha\n}\nomega\n", "utf-8");

    const pre = await readState(filePath);
    const out = await runEdit(filePath, pre.version, [
      { op: "append", pos: anchorFor(pre.hashByLine, 1), lines: "}" },
    ]);
    expect(out).not.toContain("Error:");

    const entries = parseReanchored(out);
    const ins = entries.find((e) => e.newAnchor !== "(deleted)");
    expect(ins).toBeDefined();

    console.log(`[b] map entry: line ${ins!.line}: ${ins!.oldAnchor} → ${ins!.newAnchor}`);
    console.log(`[b] pre-edit read hash@${ins!.line} = ${pre.hashByLine.get(ins!.line)}`);
    console.log(`[b] oldAnchor === pre-edit read anchor? ${ins!.oldAnchor === pre.hashByLine.get(ins!.line)}`);

    // CONTRACT: same assertion as (a) — oldAnchor must be the pre-edit read
    // anchor at the reported line. FAILS today: diff.ts:45 seeds the phantom
    // "" old content with entry.newLine, so for any non-empty old line at the
    // insert position the phantom hash diverges from the real anchor.
    expect(ins!.oldAnchor).toBe(pre.hashByLine.get(ins!.line));

    // The newAnchor side stays consistent with a fresh read — this isolates
    // the defect to the oldAnchor computation (D6b), not the new side.
    const post = await readState(filePath);
    expect(ins!.newAnchor).toBe(post.hashByLine.get(ins!.line));
  });
});

// ── (c) deletion: newAnchor must be empty ──
//
// Replace line 2 ("b") with an empty string. The diff produces a delete
// entry whose newAnchor is "" (rendered "(deleted)" in the tool output).

describe("(c) deletion — reanchor newAnchor is empty", () => {
  it("deleted line maps to newAnchor === '' (rendered '(deleted)')", async () => {
    const tmp = await newTmp("adversarial-reanchor-c-");
    const filePath = join(tmp, "c.txt");
    await writeFile(filePath, "a\nb\nc\n", "utf-8");

    const pre = await readState(filePath);
    const out = await runEdit(filePath, pre.version, [
      { pos: anchorFor(pre.hashByLine, 2), lines: "" },
    ]);
    expect(out).not.toContain("Error:");

    const entries = parseReanchored(out);
    const del = entries.find((e) => e.newAnchor === "(deleted)");
    expect(del).toBeDefined();

    console.log(`[c] map entries: ${JSON.stringify(entries)}`);
    console.log(`[c] delete entry found for line ${del!.line}: oldAnchor=${del!.oldAnchor} newAnchor=${del!.newAnchor} ('' == '(deleted)')`);

    // CONTRACT: a deleted line reports an empty newAnchor (the tool renders
    // newAnchor || "(deleted)"). PASSES today.
    expect(del!.newAnchor).toBe("(deleted)");
    expect(await readFile(filePath, "utf-8")).not.toContain("b");
  });
});

// ── (d) multi-round edits: edit2 chained after edit1 ──
//
// (d.a/d.b) Literal chain: edit2 uses edit1's reanchored newAnchor with a
// FRESH-READ version. Both content and symbol inserted lines chain cleanly —
// the map's newAnchor is always hash(new content, actual new position), so
// it agrees with a fresh read even for seeded symbol lines. (Recorded: the
// expected symbol failure does NOT reproduce on this path.)
//
// (d.c) Stale-anchor chain: edit1 inserts a line ABOVE the caller's target,
// and edit2 re-targets the (shifted) line using its PRE-EDIT anchor. A
// content target self-corrects via fuzzy matching (unseeded hash is
// position-independent) — PASS. A symbol target cannot be fuzzy-matched
// because its seeded hash changed with the line number — FAIL (D7(ii)).

describe("(d) multi-round edits — reanchor map vs fresh read consistency", () => {
  it("(d.a) content insert chain: edit2 succeeds with map newAnchor + fresh-read version (PASS)", async () => {
    const tmp = await newTmp("adversarial-reanchor-d-a-");
    const filePath = join(tmp, "da.txt");
    await writeFile(filePath, "a\nb\nc\n", "utf-8");

    const pre = await readState(filePath);
    const edit1 = await runEdit(filePath, pre.version, [
      { op: "append", pos: anchorFor(pre.hashByLine, 1), lines: "NEWLINE" },
    ]);
    const ins = parseReanchored(edit1).find((e) => e.newAnchor !== "(deleted)");
    expect(ins).toBeDefined();

    const fresh = await readState(filePath);
    const pos = `${ins!.line}#${ins!.newAnchor}`;
    console.log(`[d.a] edit1 map: line ${ins!.line} → ${ins!.newAnchor}; fresh read hash@${ins!.line} = ${fresh.hashByLine.get(ins!.line)}`);

    const edit2 = await runEdit(filePath, fresh.version, [{ pos, lines: "CHANGED" }]);
    console.log(`[d.a] edit2 pos=${pos} success=${!edit2.includes("Error:")}`);
    expect(edit2).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toContain("CHANGED");
  });

  it("(d.b) symbol insert chain: edit2 succeeds with map newAnchor + fresh-read version (recorded PASS)", async () => {
    const tmp = await newTmp("adversarial-reanchor-d-b-");
    const filePath = join(tmp, "db.txt");
    await writeFile(filePath, "a\nb\nc\n", "utf-8");

    const pre = await readState(filePath);
    const edit1 = await runEdit(filePath, pre.version, [
      { op: "append", pos: anchorFor(pre.hashByLine, 1), lines: "}" },
    ]);
    const ins = parseReanchored(edit1).find((e) => e.newAnchor !== "(deleted)");
    expect(ins).toBeDefined();

    const fresh = await readState(filePath);
    const pos = `${ins!.line}#${ins!.newAnchor}`;
    console.log(`[d.b] edit1 map: line ${ins!.line} → ${ins!.newAnchor}; fresh read hash@${ins!.line} = ${fresh.hashByLine.get(ins!.line)}`);
    console.log(`[d.b] map newAnchor consistent with fresh read (symbol line)? ${ins!.newAnchor === fresh.hashByLine.get(ins!.line)}`);

    const edit2 = await runEdit(filePath, fresh.version, [{ pos, lines: "CHANGED" }]);
    console.log(`[d.b] edit2 pos=${pos} success=${!edit2.includes("Error:")}`);
    expect(edit2).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toContain("CHANGED");
  });

  it("(d.c) stale-anchor chain after an insert: content target self-corrects, symbol target FAILS (D7)", async () => {
    // ── content target: "bb" shifted down by the insert — fuzzy self-corrects ──
    const tmp = await newTmp("adversarial-reanchor-d-c-");
    const contentFile = join(tmp, "dc-content.txt");
    await writeFile(contentFile, "alpha\nbb\nomega\n", "utf-8");
    const preC = await readState(contentFile);
    const staleAnchor2 = anchorFor(preC.hashByLine, 2); // "bb" at line 2 (pre-edit)
    await runEdit(contentFile, preC.version, [
      { op: "append", pos: anchorFor(preC.hashByLine, 1), lines: "NEWLINE" },
    ]);
    const freshC = await readState(contentFile); // "bb" is now at line 3
    const edit2C = await runEdit(contentFile, freshC.version, [{ pos: staleAnchor2, lines: "CHANGED" }]);
    console.log(`[d.c] content: stale ${staleAnchor2} → success=${!edit2C.includes("Error:")} corrections=${JSON.stringify(parseCorrections(edit2C))}`);
    expect(edit2C).not.toContain("Error:");
    const diskC = (await readFile(contentFile, "utf-8")).split("\n");
    console.log(`[d.c] content: 'CHANGED' landed at line ${diskC.indexOf("CHANGED") + 1} (expected 3)`);
    expect(diskC.indexOf("CHANGED") + 1).toBe(3);

    // ── symbol target: "}" shifted down by the insert — seeded hash unfindable ──
    const symbolFile = join(tmp, "dc-symbol.txt");
    await writeFile(symbolFile, "alpha\n}\nomega\n", "utf-8");
    const preS = await readState(symbolFile);
    const staleAnchorS = anchorFor(preS.hashByLine, 2); // "}" at line 2 (pre-edit)
    await runEdit(symbolFile, preS.version, [
      { op: "append", pos: anchorFor(preS.hashByLine, 1), lines: "NEWLINE" },
    ]);
    const freshS = await readState(symbolFile); // "}" is now at line 3
    const edit2S = await runEdit(symbolFile, freshS.version, [{ pos: staleAnchorS, lines: "CHANGED" }]);
    console.log(`[d.c] symbol: stale ${staleAnchorS} → success=${!edit2S.includes("Error:")} corrections=${JSON.stringify(parseCorrections(edit2S))}`);
    console.log(`[d.c] symbol error tail: ${edit2S.split("\n").filter((l) => l.includes("expected hash") || l.includes("not found")).join(" | ")}`);

    // CONTRACT: a shifted symbol line must be re-anchorable the same way a
    // shifted content line is. FAILS today: hash.ts:63-66 seeds symbol-only
    // lines with their line number, so the stale anchor hash("}", 2) never
    // matches the shifted position hash("}", 3) and findNearbyMatch
    // (fuzzy.ts:11-31) returns null → no correction → edit fails.
    expect(edit2S).not.toContain("Error:");
    expect(await readFile(symbolFile, "utf-8")).toContain("CHANGED");
  });
});

// ── (e) duplicate content lines + stale anchor offset +1 ──
//
// Current file ["DUP","x","DUP","DUP","y"]. The caller's anchor `2#hash(DUP)`
// was captured against ["pre","DUP","x","DUP","DUP","y"] — their intended
// target, the FIRST DUP, sat at line 2 and now sits at line 1 (a line was
// removed above it). The mismatch at line 2 ("x") is ambiguous: "DUP" exists
// at line 1 (above, the correct remap) and at lines 3/4 (below, wrong).
// findNearbyMatch searches below-first (fuzzy.ts:18-23), so the correction
// resolves to line 3 — the WRONG duplicate (D7(i)).

describe("(e) duplicate content lines + anchor offset +1 — corrected edit must hit the intended line (D7)", () => {
  it("correction lands on line 1 (the caller's first DUP) — FAILS today: D7 prefers the duplicate below", async () => {
    const tmp = await newTmp("adversarial-reanchor-e-");
    const filePath = join(tmp, "e.txt");
    await writeFile(filePath, "DUP\nx\nDUP\nDUP\ny\n", "utf-8");

    const pre = await readState(filePath);
    const hashDup = pre.hashByLine.get(1)!;
    const staleAnchor = `2#${hashDup}`; // offset +1 vs the true position (line 1)
    console.log(`[e] anchors: ${JSON.stringify([...pre.hashByLine.entries()])}`);
    console.log(`[e] stale anchor: ${staleAnchor} (intended target = first DUP at line 1)`);

    const out = await runEdit(filePath, pre.version, [{ pos: staleAnchor, lines: "REPLACED" }]);
    const corrections = parseCorrections(out);
    const disk = (await readFile(filePath, "utf-8")).split("\n");
    const editedLine = disk.indexOf("REPLACED") + 1;
    console.log(`[e] corrections_applied: ${JSON.stringify(corrections)}`);
    console.log(`[e] 'REPLACED' actually landed at line ${editedLine} (contract: 1)`);

    // CONTRACT: the corrected edit must land on the caller's intended line 1.
    // FAILS today: the correction maps 2# → 3# (below-first), so the WRONG
    // duplicate is replaced.
    expect(editedLine).toBe(1);
    expect(corrections.some((c) => c.startsWith(`2#${hashDup} -> 1#`))).toBe(true);
  });
});

// ── (f) brace-dense file + uniform anchor offset +1 ──
//
// The caller's V1 anchors (["{","}","{","}","body","{","}"]) are applied to
// V2 (["X","{","}","{","}","body","{","}"]) where a line was inserted at the
// top — every anchor is uniformly offset +1. All three anchors mismatch;
// detectUniformOffset must find the uniform +1 shift and remap the edits.
// FAILS today: the "{"/"}" anchors are line-number-seeded (hash.ts:63-66), so
// findNearbyMatch cannot match the shifted symbol lines (expected hash seeded
// with the OLD line number never equals a hash computed at the NEW position)
// → detectUniformOffset aborts → edit fails (D7(ii)).

describe("(f) brace-dense file + uniform anchor offset — detectUniformOffset must apply (D7)", () => {
  it("uniform +1 offset is detected and the edit succeeds — FAILS today: seeding defeats findNearbyMatch", async () => {
    const tmp = await newTmp("adversarial-reanchor-f-");
    const v1Path = join(tmp, "f-v1.txt");
    await writeFile(v1Path, ["{", "}", "{", "}", "body", "{", "}"].join("\n") + "\n", "utf-8");
    const v1 = await readState(v1Path);

    const v2Path = join(tmp, "f-v2.txt");
    const v2Lines = ["X", "{", "}", "{", "}", "body", "{", "}"];
    await writeFile(v2Path, v2Lines.join("\n") + "\n", "utf-8");
    const v2 = await readState(v2Path);

    const staleAnchors = [3, 5, 7].map((n) => anchorFor(v1.hashByLine, n));
    console.log(`[f] v1 anchors: ${JSON.stringify([...v1.hashByLine.entries()])}`);
    console.log(`[f] v2 anchors: ${JSON.stringify([...v2.hashByLine.entries()])}`);
    console.log(`[f] stale anchors (uniform +1): ${JSON.stringify(staleAnchors)}`);

    const out = await runEdit(
      v2Path,
      v2.version,
      staleAnchors.map((pos) => ({ pos, lines: "R" })),
    );
    const corrections = parseCorrections(out);
    console.log(`[f] corrections_applied: ${JSON.stringify(corrections)}`);
    console.log(`[f] error tail: ${out.split("\n").filter((l) => l.includes("expected hash") || l.includes("not found") || l.includes("Error")).join(" | ")}`);
    console.log(`[f] success=${!out.includes("Error:")}`);

    // CONTRACT: a uniform +1 offset across all anchors is exactly the case
    // detectUniformOffset is designed for (fuzzy.ts:67-101) — the edits must
    // be remapped and applied. FAILS today.
    expect(out).not.toContain("Error:");
    expect(corrections.length).toBeGreaterThan(0);
  });

  it("(f.control) content-dense file with the same uniform offset — correction succeeds (isolates seeding as the cause)", async () => {
    const tmp = await newTmp("adversarial-reanchor-fc-");
    const v1Path = join(tmp, "fc-v1.txt");
    const v1Lines = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta"];
    await writeFile(v1Path, v1Lines.join("\n") + "\n", "utf-8");
    const v1 = await readState(v1Path);

    const v2Path = join(tmp, "fc-v2.txt");
    await writeFile(v2Path, ["XX", ...v1Lines].join("\n") + "\n", "utf-8");
    const v2 = await readState(v2Path);

    const staleAnchors = [3, 5].map((n) => anchorFor(v1.hashByLine, n));
    const out = await runEdit(
      v2Path,
      v2.version,
      staleAnchors.map((pos) => ({ pos, lines: "R" })),
    );
    const corrections = parseCorrections(out);
    console.log(`[f.control] stale anchors: ${JSON.stringify(staleAnchors)}`);
    console.log(`[f.control] corrections_applied: ${JSON.stringify(corrections)}`);
    console.log(`[f.control] success=${!out.includes("Error:")}`);
    console.log(`[f.control] disk: ${JSON.stringify(await readFile(v2Path, "utf-8"))}`);

    // Control: content lines are unseeded, so findNearbyMatch matches them at
    // the shifted position and the uniform +1 offset is detected.
    expect(out).not.toContain("Error:");
    expect(corrections.length).toBeGreaterThan(0);
  });
});

// ── (g) append-with-pos with a stale anchor ──
//
// File ["a","b","c"]; the caller's stale append anchor `3#hash("b")` (offset
// +1: they believe "b" is at line 3). Validation fails at line 3, fuzzy finds
// "b" at line 2 and builds a correction — but remapEditAnchors
// (hashline-edit.ts:52-60) only rewrites edits with op === "replace", so the
// append keeps its stale anchor and the retry fails (D-g).

describe("(g) append-with-pos with a stale anchor — fuzzy correction must reach non-replace ops (D-g)", () => {
  it("stale append anchor is fuzzy-corrected and the append succeeds — FAILS today: remapEditAnchors only remaps replace", async () => {
    const tmp = await newTmp("adversarial-reanchor-g-");
    const filePath = join(tmp, "g.txt");
    await writeFile(filePath, "a\nb\nc\n", "utf-8");

    const pre = await readState(filePath);
    const staleAnchor = `3#${pre.hashByLine.get(2)!}`; // "b" is really at line 2
    console.log(`[g] anchors: ${JSON.stringify([...pre.hashByLine.entries()])}`);
    console.log(`[g] stale append anchor: ${staleAnchor}`);

    const out = await runEdit(filePath, pre.version, [
      { op: "append", pos: staleAnchor, lines: "INS" },
    ]);
    const corrections = parseCorrections(out);
    console.log(`[g] corrections_applied: ${JSON.stringify(corrections)}`);
    console.log(`[g] suggestion tail: ${out.split("\n").filter((l) => l.includes("Did you mean") || l.includes("not found") || l.includes("Error")).join(" | ")}`);
    console.log(`[g] success=${!out.includes("Error:")}`);

    // CONTRACT: a stale anchor on an append-with-pos must be corrected the
    // same way a replace anchor is (the suggestion is even produced). FAILS
    // today: remapEditAnchors returns non-replace edits untouched.
    expect(out).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toContain("INS");
  });
});
