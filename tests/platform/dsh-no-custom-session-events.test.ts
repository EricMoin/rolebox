/// <reference types="bun-types" />

/**
 * Guard — rolebox MUST NOT append custom (non-catalog) session event types to
 * the dsh session log.
 *
 * ## Why this guard exists
 *
 * rolebox is a downstream, out-of-repo dsh plugin. rc.6 persistence refuses to
 * interpret a session log that contains an event type outside the harness's own
 * `KNOWN_SESSION_EVENT_TYPES` unless the envelope carries `ignorable: true`
 * (`dsh-session-persistence/lib/index.js:1119`), and there is no public
 * `append()` option to set that marker
 * (`dsh-session/lib/types/types.d.ts:438`). The former `rolebox/active-role`
 * event therefore produced a session the harness could not reload. The 
 * remedy moved active-role durability into a rolebox-owned sidecar
 * (`active-role-store.ts`) and forbade rolebox from extending the harness
 * session-event vocabulary. This test is the mechanical enforcement of that
 * boundary — see `docs/dsh-plugin-contract.md` §4.1.1.
 *
 * ## What it scans
 *
 * Every `.ts`/`.tsx` file under `src/platform/adapters/dsh/` plus
 * `src/dsh-plugin.ts`. For each session-like `.append(type, …)` call site it
 * resolves the `type` argument — a string literal, a same-file (or cross-file,
 * within the scan set) string constant, or a template literal without
 * interpolation — and asserts membership in `KNOWN_SESSION_EVENT_TYPES`
 * imported from the installed `@deepseek-ai/dsh-session`.
 *
 * A `type` argument that cannot be resolved statically is reported as a
 * violation: the boundary rule admits only catalog-declared types, so a
 * dynamic type cannot be proven safe. Comments are blanked (length-preserving)
 * before matching so documentation examples never count; non-session receivers
 * (e.g. `artifacts.append("run.json")`) are ignored.
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";

/** Repo root, resolved from this test file (`tests/platform/`). */
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Directories scanned recursively for session-event appends. */
const SCAN_DIRS = [join(REPO_ROOT, "src/platform/adapters/dsh")];

/** Individual files scanned in addition to {@link SCAN_DIRS}. */
const SCAN_FILES = [join(REPO_ROOT, "src/dsh-plugin.ts")];

/** A detected `.append(type, …)` call whose `type` is not catalog-declared. */
interface Violation {
  file: string;
  line: number;
  receiver: string;
  type: string;
  reason: string;
}

/**
 * Recursively list source files under `dir`, skipping `*.test.*` and `*.d.ts`.
 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out `//` line comments and `/* … *​/` block comments while preserving
 * the source length exactly (every input character maps to one output
 * character, newlines survive), so byte offsets stay aligned with the original
 * for line-number reporting. String and template literals are copied verbatim
 * and never treated as comments.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];

    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      out.push(c);
      i++;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out.push(c);
      } else {
        out.push(" ");
      }
      i++;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    // String / template literal: copy verbatim, honoring escapes.
    out.push(c);
    if (c === "\\") {
      out.push(n ?? "");
      i += 2;
      continue;
    }
    if (mode === "single" && c === "'") mode = "code";
    else if (mode === "double" && c === '"') mode = "code";
    else if (mode === "template" && c === "`") mode = "code";
    i++;
  }

  return out.join("");
}

/**
 * Collect `const NAME = "literal"` string bindings (top-level or not) into a
 * name → value map, resolving the historical shape where the event type was
 * a named constant (`export const ACTIVE_ROLE_EVENT = "rolebox/active-role"`)
 * rather than an inline literal.
 */
function collectStringConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(['"])([^'"\\\n]*)\2/g;
  for (const match of source.matchAll(re)) out.set(match[1], match[3]);
  return out;
}

/**
 * Extract the raw text of the first argument of a call whose `(` is at
 * `openParen`, respecting nested parens and string literals.
 */
function firstArgumentText(code: string, openParen: number): string {
  let depth = 0;
  let i = openParen;
  let text = "";
  let mode: "code" | "single" | "double" | "template" = "code";

  while (i < code.length) {
    const c = code[i];

    if (mode === "code") {
      if (c === "(") {
        depth++;
        if (depth > 1) text += c;
        i++;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 0) break;
        text += c;
        i++;
        continue;
      }
      if (c === "," && depth === 1) break;
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      text += c;
      i++;
      continue;
    }

    text += c;
    if (c === "\\") {
      text += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (mode === "single" && c === "'") mode = "code";
    else if (mode === "double" && c === '"') mode = "code";
    else if (mode === "template" && c === "`") mode = "code";
    i++;
  }

  return text.trim();
}

/** Classify a resolved first argument as a literal, an identifier, or dynamic. */
function classifyArgument(
  argText: string,
): { kind: "string" | "identifier" | "dynamic"; value?: string } {
  const stringLiteral = /^(['"])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(argText);
  if (stringLiteral) {
    return { kind: "string", value: stringLiteral[2].replace(/\\(.)/g, "$1") };
  }
  if (
    argText.startsWith("`") &&
    argText.endsWith("`") &&
    !argText.includes("${")
  ) {
    return { kind: "string", value: argText.slice(1, -1) };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(argText)) {
    return { kind: "identifier", value: argText };
  }
  return { kind: "dynamic" };
}

/** True when `receiver` names a session (e.g. `session`, `this.session`, `ctx.sessions`). */
function isSessionReceiver(receiver: string): boolean {
  const last = receiver.split(".").pop()?.trim() ?? "";
  return /session/i.test(last);
}

/** 1-based line number of `index` in `source`. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Receiver chain immediately preceding an `.append(` call. */
const APPEND_CALL_RE =
  /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*append\s*\(/g;

/**
 * Scan one source file for session-event appends of non-catalog types.
 *
 * @param source   - file contents
 * @param file     - absolute path (for violation reporting)
 * @param globals  - cross-file string constants, used as a resolution fallback
 */
function scanSource(
  source: string,
  file: string,
  globals: ReadonlyMap<string, string> = new Map(),
): Violation[] {
  const code = stripComments(source);
  const constants = collectStringConstants(code);
  const violations: Violation[] = [];

  for (const match of code.matchAll(APPEND_CALL_RE)) {
    const receiver = match[1].replace(/\s+/g, "");
    if (!isSessionReceiver(receiver)) continue;

    const openParen = (match.index ?? 0) + match[0].length - 1;
    const argText = firstArgumentText(code, openParen);
    const classified = classifyArgument(argText);
    const line = lineAt(source, match.index ?? 0);

    if (classified.kind === "dynamic") {
      violations.push({
        file,
        line,
        receiver,
        type: argText || "<empty>",
        reason: "unresolved/dynamic event type — only catalog-declared types may be written",
      });
      continue;
    }

    const type =
      classified.kind === "string"
        ? classified.value!
        : (constants.get(classified.value!) ?? globals.get(classified.value!));

    if (type === undefined) {
      violations.push({
        file,
        line,
        receiver,
        type: argText,
        reason: "unresolved constant — only catalog-declared types may be written",
      });
      continue;
    }

    if (!KNOWN_SESSION_EVENT_TYPES.has(type)) {
      violations.push({
        file,
        line,
        receiver,
        type,
        reason: "type is not in KNOWN_SESSION_EVENT_TYPES (rolebox must not extend the harness event vocabulary)",
      });
    }
  }

  return violations;
}

/** Render violations for an assertion message; empty string when there are none. */
function formatViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return "";
  return violations
    .map(
      (v) =>
        `  ${relative(REPO_ROOT, v.file)}:${v.line}  ${v.receiver}.append(${JSON.stringify(v.type)})  — ${v.reason}`,
    )
    .join("\n");
}

/** All scanned files (recursive dirs + explicit files). */
function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap((dir) => (existsSync(dir) ? listSourceFiles(dir) : []));
  for (const file of SCAN_FILES) {
    if (existsSync(file)) files.push(file);
  }
  return files;
}

describe("dsh session-event write boundary", () => {
  it("scans the expected dsh sources (guards against a stale path)", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(join("adapters", "dsh", "session.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith("dsh-plugin.ts"))).toBe(true);
  });

  it("no rolebox source appends a non-catalog session event type", () => {
    const files = scannedFiles();
    const globals = new Map<string, string>();
    for (const file of files) {
      for (const [name, value] of collectStringConstants(readFileSync(file, "utf-8"))) {
        globals.set(name, value);
      }
    }

    const violations = files.flatMap((file) =>
      scanSource(readFileSync(file, "utf-8"), file, globals),
    );

    expect(formatViolations(violations)).toBe("");
  });

  describe("scanner positive controls", () => {
    it("flags an inline custom event type (the literal reintroduction shape)", () => {
      const source = [
        "const session = getSession();",
        'session.append("rolebox/active-role", { id: "tester" }, {});',
      ].join("\n");
      const violations = scanSource(source, "fixture.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe("rolebox/active-role");
    });

    it("flags a custom event type held in a named constant (the historical shape)", () => {
      const source = [
        'export const ACTIVE_ROLE_EVENT = "rolebox/active-role";',
        "session.append(ACTIVE_ROLE_EVENT, { id }, {});",
      ].join("\n");
      const violations = scanSource(source, "fixture.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe("rolebox/active-role");
    });

    it("flags an unresolvable/dynamic event type", () => {
      const source = "session.append(computeType(), {});";
      const violations = scanSource(source, "fixture.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toContain("dynamic");
    });

    it("allows a catalog event type (inline literal and named constant)", () => {
      const source = [
        'const TODO_WRITE = "todo/write";',
        'session.append("user/message", msg, { surfaceOp: "append" });',
        "session.append(TODO_WRITE, { todos: [] });",
      ].join("\n");
      expect(scanSource(source, "fixture.ts")).toEqual([]);
    });

    it("ignores non-session receivers and commented-out examples", () => {
      const source = [
        'artifacts.append("run.json", body);',
        '// session.append("rolebox/active-role", { id }, {});',
        '/* session.append("rolebox/active-role", { id }, {}); */',
      ].join("\n");
      expect(scanSource(source, "fixture.ts")).toEqual([]);
    });
  });
});
