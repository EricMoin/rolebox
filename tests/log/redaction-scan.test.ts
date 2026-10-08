/**
 * THE REDACTION REGRESSION SCAN: NO EVENT MAY CALL A SECRET A FIELD.
 *
 * `src/log/redact.ts` withholds the VALUE of any field whose KEY names a
 * credential, and it is the LAST line of the privacy rule — by then the record
 * has already been built from a call site that decided that key was a normal
 * field. This scan checks the decision instead of the consequence, on all three
 * places the decision is written down:
 *
 * 1. THE TABLE'S DECLARED FIELDS. Every registry entry documents the field keys
 *    its callers pass (`Fields: …`). A declared key that the sensitive-term rule
 *    matches means the entry was DESIGNED around a secret travelling as data.
 * 2. THE CALL SITES. Every `logEvent("<code>", { … })` and
 *    `…event("<code>", { … })` object literal in src/** is scanned for its
 *    top-level keys, so a call site added tomorrow is covered without anyone
 *    remembering this file exists.
 * 3. THE TWO HALVES OF THE RULE. A key built from each term of
 *    `SENSITIVE_KEY_TERMS` is shown to be withheld by `redactFields`, so the scan
 *    and the runtime cannot drift apart.
 *
 * A failure names the code and the key (and the file and line for a call site),
 * because "some event somewhere uses a sensitive key" is not actionable.
 *
 * The scan is static by design: it must work on a call site that is never
 * executed by the suite, which is exactly where a leaked credential would sit.
 * Keys behind a variable or a spread cannot be read statically and are counted
 * and reported in the test's own summary instead of being guessed at.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { LOG_EVENTS } from "../../src/log/index.ts";
import { SENSITIVE_KEY_TERMS, isSensitiveFieldKey, redactFields } from "../../src/log/redact.ts";

/** The repository's src/ tree, resolved from this file. */
const SRC_DIR = join(import.meta.dir, "..", "..", "src");

/** The registry's own source: the declared `Fields:` keys live in its comments. */
const REGISTRY_PATH = join(SRC_DIR, "log", "registry.ts");

/** One `logEvent`/`.event` call site found in the tree. */
interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly keys: readonly string[];
  /** True when the literal could not be read statically (a spread, a variable). */
  readonly opaque: boolean;
}

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The line number (1-based) of an offset in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") line += 1;
  return line;
}

/**
 * The top-level keys of the object literal starting at `start` (which must point
 * at `{`), with the offset just past its closing brace. Strings, template
 * literals and nested objects/arrays are skipped, so a key is only ever read at
 * depth one.
 */
function objectLiteralKeys(text: string, start: number): { keys: string[]; end: number; opaque: boolean } {
  const keys: string[] = [];
  let opaque = false;
  let depth = 0;
  let index = start;
  let tokenStart = -1;
  const pushToken = (endIndex: number): void => {
    if (tokenStart < 0) return;
    const token = text.slice(tokenStart, endIndex).trim();
    tokenStart = -1;
    if (token.length === 0) return;
    if (token.startsWith("...")) {
      opaque = true;
      return;
    }
    const colon = token.indexOf(":");
    const key = (colon < 0 ? token : token.slice(0, colon)).trim().replace(/^["'`]|["'`]$/g, "");
    if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
    else opaque = true;
  };

  for (; index < text.length; index++) {
    const char = text[index] ?? "";
    if (depth === 0) {
      if (char === "{") {
        depth = 1;
        continue;
      }
      break;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      if (depth === 1) pushToken(index);
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        pushToken(index);
        return { keys, end: index + 1, opaque };
      }
      continue;
    }
    if (char === "," && depth === 1) {
      pushToken(index);
      continue;
    }
    if (depth === 1 && tokenStart < 0 && !/\s/.test(char)) tokenStart = index;
  }
  return { keys, end: index, opaque };
}

/** Every registered code, for resolving a literal `logEvent("<code>", …)`. */
const REGISTERED = new Set(Object.keys(LOG_EVENTS));

/** All `logEvent`/`.event` call sites in src/** that pass a literal code. */
function callSites(): { sites: CallSite[]; variableCode: number; noFields: number } {
  const sites: CallSite[] = [];
  let variableCode = 0;
  let noFields = 0;
  const pattern = /(?:logEvent|\.event)\(\s*(?:"([^"]+)"|'([^']+)')?\s*(?:,\s*)?/g;
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const code = match[1] ?? match[2];
      if (code === undefined) {
        variableCode += 1;
        continue;
      }
      const rest = match.index + match[0].length;
      if ((text[rest] ?? "") !== "{") {
        noFields += 1;
        continue;
      }
      const { keys, opaque } = objectLiteralKeys(text, rest);
      sites.push({ file: relative(SRC_DIR, file), line: lineAt(text, match.index), code, keys, opaque });
    }
  }
  return { sites, variableCode, noFields };
}

/** The `Fields:` keys each registry entry declares, parsed from its comment. */
function declaredFields(): Map<string, string[]> {
  const text = readFileSync(REGISTRY_PATH, "utf8");
  const declared = new Map<string, string[]>();
  const lines = text.split("\n");
  let comment: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/**")) {
      comment.push(trimmed.replace(/^\/\*\*/, "").replace(/^\*/, ""));
      continue;
    }
    const entry = /^\s*"([^"]+)":\s*\{/.exec(line);
    if (entry !== null && entry[1] !== undefined) {
      declared.set(entry[1], fieldsFromComment(comment));
      comment = [];
      continue;
    }
    if (trimmed.length > 0) comment = [];
  }
  return declared;
}

/**
 * The backticked keys in one comment block's `Fields:` sentence. The tag may
 * open its own line (`Fields: \`a\`.`) or share one with `Scope:`
 * (`Scope: \`graphId\`. Fields: \`a\`, \`b\`.`), and the sentence may wrap
 * onto the following lines until the next tag (`Caller:`, `THROTTLED:`).
 */
function fieldsFromComment(comment: readonly string[]): string[] {
  const keys: string[] = [];
  let inside = false;
  for (const raw of comment) {
    const line = raw.trim();
    if (!inside) {
      const marker = line.indexOf("Fields:");
      if (marker < 0) continue;
      inside = true;
      collectKeys(line.slice(marker + "Fields:".length), keys);
      continue;
    }
    if (/^(Caller|THROTTLED|Scope):/.test(line)) break;
    collectKeys(line, keys);
  }
  return keys;
}

/** Every `\`key\`` in a fragment, in order and without repeats. */
function collectKeys(fragment: string, into: string[]): void {
  for (const match of fragment.matchAll(/`([^`]+)`/g)) {
    const key = match[1] ?? "";
    if (/^[A-Za-z_$][\w$]*$/.test(key) && !into.includes(key)) into.push(key);
  }
}

/**
 * THE ONE KNOWN FALSE POSITIVE, PINNED RATHER THAN IGNORED.
 *
 * `estimatedTokens` is a COUNT (roughly how many tokens a large tool output
 * holds) and the containment rule reads "token" in its name, so the runtime
 * withholds the count: the record carries `"estimatedTokens": "[redacted]"` and
 * the number the monitor's follow-up decision is made from never reaches an
 * operator. It is a false positive in the SAFE direction — nothing leaks — and
 * the fix is a RENAME of the field key at its call site
 * (src/recovery/builtin/context-monitor) and in the registry comment, neither of
 * which is inside this node's write scope. It is therefore recorded here by
 * exact code + key + file, asserted to be the ONLY offence, and asserted to be
 * STILL an offence: whoever renames the key makes this list stale and the test
 * fails until the entry is deleted, so the exception cannot outlive the defect.
 */
const KNOWN_FALSE_POSITIVES: ReadonlyArray<{ code: string; key: string; file: string }> = [
  {
    code: "context-window.large-output",
    key: "estimatedTokens",
    file: "recovery/builtin/context-window-monitor.ts",
  },
];

/** True when an offence is the documented false positive rather than a new one. */
function isKnownFalsePositive(code: string, key: string): boolean {
  return KNOWN_FALSE_POSITIVES.some((entry) => entry.code === code && entry.key === key);
}

describe("redaction scan: registered events never deal in sensitive keys", () => {
  it("declares no field whose key the sensitive-term rule matches", () => {
    const declared = declaredFields();
    expect(declared.size).toBeGreaterThan(50);

    const offences: string[] = [];
    for (const [code, keys] of declared) {
      for (const key of keys) {
        if (isSensitiveFieldKey(key)) offences.push(`${code}: declared field \`${key}\` is a sensitive key`);
      }
    }
    const unexpected = offences.filter((offence) => !KNOWN_FALSE_POSITIVES.some((entry) => offence.startsWith(`${entry.code}:`) && offence.includes(`\`${entry.key}\``)));
    expect(unexpected, "a declared field key must not be a sensitive key").toEqual([]);
    // The exception has to still BE one: a repaired entry makes this fail.
    expect(offences.length).toBe(KNOWN_FALSE_POSITIVES.filter((entry) => declared.get(entry.code)?.includes(entry.key)).length);
  });

  it("passes no sensitive top-level field key at any logEvent call site in src/**", () => {
    const { sites, variableCode, noFields } = callSites();
    // Sanity: the scan must actually see the tree.
    expect(sites.length).toBeGreaterThan(50);
    expect(variableCode + noFields).toBeGreaterThanOrEqual(0);

    const offences: { text: string; code: string; key: string }[] = [];
    for (const site of sites) {
      for (const key of site.keys) {
        if (isSensitiveFieldKey(key)) {
          offences.push({
            text: `${site.code} at ${site.file}:${site.line} passes field \`${key}\` — a sensitive key`,
            code: site.code,
            key,
          });
        }
      }
    }
    const unexpected = offences.filter((offence) => !isKnownFalsePositive(offence.code, offence.key));
    expect(unexpected.map((offence) => offence.text), "a call site must not pass a sensitive field key").toEqual([]);

    // Every documented exception must still exist, and exist where it is
    // documented: that is what makes the entry a pin rather than a blanket
    // permission for this code.
    for (const entry of KNOWN_FALSE_POSITIVES) {
      const found = sites.find((site) => site.code === entry.code && site.keys.includes(entry.key));
      expect(found, `${entry.code} no longer passes \`${entry.key}\` — delete the exception`).toBeDefined();
      expect(found?.file, `${entry.code} moved: update the exception`).toBe(entry.file);
    }
  });

  it("withholds the value of the documented false positive, which is why it is safe to record", () => {
    expect(isSensitiveFieldKey("estimatedTokens")).toBe(true);
    expect(redactFields({ estimatedTokens: 12_345 }).estimatedTokens).toBe("[redacted]");
  });

  it("only sees field keys of codes the table registers", () => {
    const { sites } = callSites();
    const unknown = sites.filter((site) => !REGISTERED.has(site.code)).map((site) => `${site.code} at ${site.file}:${site.line}`);
    expect(unknown).toEqual([]);
  });

  it("withholds a value for a key built from every sensitive term, which is the rule the scan applies", () => {
    for (const term of SENSITIVE_KEY_TERMS) {
      const key = `${term}_value`;
      expect(isSensitiveFieldKey(key), `${term} must be a sensitive term`).toBe(true);
      expect(redactFields({ [key]: "leak" })[key]).toBe("[redacted]");
    }
    // The other half of the same rule: an id is NOT a secret.
    expect(isSensitiveFieldKey("executionId")).toBe(false);
    expect(redactFields({ executionId: "exec-1" }).executionId).toBe("exec-1");
  });
});
