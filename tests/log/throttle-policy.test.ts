/**
 * WHICH ENTRIES MAY BE THROTTLED, AND WHICH MAY NEVER BE.
 *
 * `throttleMs` is the one field in the registry that DELETES diagnostics, so the
 * set that carries it is pinned here twice over:
 *
 * 1. AS A SET. Every throttled code and its window is listed explicitly, so
 *    adding a window to an entry is a deliberate edit to this file — not a
 *    one-word change somewhere in a 1300-line table. The evidence behind each
 *    window (records, burst sizes, repeated fields, how many records the window
 *    lets through) is in the entry's own comment and is reproducible with
 *    `bun scripts/log-event-density.ts`.
 * 2. AS A RULE. The entries whose whole value is "this just broke" are named and
 *    asserted to carry NO window: a first failure must stay visible, and because
 *    the gate is keyed by (channel, code) rather than by graph or attempt, a
 *    suppression can hide a DIFFERENT subject's first report.
 * 3. AS A SUBJECT. A window that a first report about ANOTHER subject could fall
 *    into is only allowed when the entry names the thing that must stay
 *    separable — `throttleBy`, a FIELD its callers actually pass, whose string
 *    value becomes the third part of the window key. Entries whose records all
 *    describe one subject keep the plain (channel, code) window. The name is
 *    read back out of the sources the records are built in (the registry's
 *    `Fields:` line and the call sites' own object literals), so a misspelling
 *    cannot silently drop the subject back to the empty string and re-create the
 *    very cross-subject suppression this file exists to prevent.
 *
 * The last cases drive the real pipeline with an injected clock, so the claim
 * "a burst collapses and the loss is counted" is shown on the same code path
 * production uses.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { LOG_EVENTS, configureLogging, logEvent } from "../../src/log/index.ts";
import type { LogEventDefinition } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { logThrottleKey, logThrottleSubject } from "../../src/log/throttle.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { __setLogClockForTest } from "../../src/log/index.ts";

/** The registry's own source: the declared `Fields:` keys live in its comments. */
const REGISTRY_PATH = join(import.meta.dir, "..", "..", "src", "log", "registry.ts");
/** The runtime's own source: the unknown-code report is built there, inline. */
const RUNTIME_PATH = join(import.meta.dir, "..", "..", "src", "log", "runtime.ts");
/** The `src/` tree: the call sites that actually PASS a subject field live there. */
const SRC_DIR = join(import.meta.dir, "..", "..", "src");

/**
 * Every entry that declares a window, with the window it declares, IN TABLE
 * ORDER (the platform's four head entries, then the engine sections, then the
 * `log:compat` section last) — the order is part of the assertion, so a window
 * added to an entry shows up in this diff.
 */
const THROTTLED: ReadonlyArray<readonly [string, number]> = [
  ["log.event.unknown-code", 60_000],
  ["sweep.summary", 10_000],
  ["dispatch.unclaimed-confirmation", 60_000],
  ["tool.control-continuation", 60_000],
  ["tool.cancel-delivery", 60_000],
  ["log.field.narrowed", 60_000],
];

/**
 * The first-failure events. Each one reports something that has NOT happened —
 * a write that failed, a delivery with no proof, a definition that never reached
 * the store — and every occurrence may be the first one about a different
 * subject, so none of them may be suppressed.
 */
const NEVER_THROTTLED: readonly string[] = [
  "log.sink.failed",
  "log.file.write-failed",
  "log.file.rotate-failed",
  "sweep.store-blocked",
  "watch.unwatched-executions",
  "watch.announcement-unconfirmed",
  "dispatch.delivery-unproven",
  "dispatch.binding-failed",
  "index.confirmation-refused",
  "index.release-unproven",
  "declare.persistence-failed",
  "tool.control-follow-up-threw",
  "plugin-core.init-failed",
  "service-supervisor.permanently-degraded",
  "health-monitor.service-degraded",
];

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

/**
 * The top-level keys of the object literal that starts at `start` (which must
 * point at `{`), with the offset just past its closing brace — the same
 * source-adjacent read tests/log/redaction-scan.test.ts does, and for the same
 * reason: a call site that stops passing a field must be able to fail a test
 * without anyone executing it.
 */
function literalKeys(text: string, start: number): { keys: string[]; end: number } {
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let token = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote.length > 0) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      if (depth === 1 && keys.length === 0) continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return { keys, end: index };
      continue;
    }
    if (depth === 1 && char === ",") {
      const key = token.split(":")[0]?.trim().replace(/^["'`]|["'`]$/g, "") ?? "";
      if (key.length > 0 && !keys.includes(key)) keys.push(key);
      token = "";
      continue;
    }
    if (depth === 1) token += char;
  }
  return { keys, end: text.length };
}

/** The field keys every `logEvent("<code>", { … })` call site passes. */
function callSiteFields(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /(?:logEvent|\.event)\(\s*(?:"([^"]+)"|'([^']+)')\s*,\s*/g;
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const code = match[1] ?? match[2] ?? "";
      const brace = text.indexOf("{", (match.index ?? 0) + match[0].length);
      if (brace < 0) continue;
      const { keys } = literalKeys(text, brace);
      const existing = found.get(code) ?? [];
      for (const key of keys) if (!existing.includes(key)) existing.push(key);
      found.set(code, existing);
    }
  }
  return found;
}

/** The table entry for a code, or `undefined`. */
function entryOf(code: string): LogEventDefinition | undefined {
  return (LOG_EVENTS as Record<string, LogEventDefinition>)[code];
}

/**
 * Parse ONE entry block's `Fields:` declaration out of its comment. The block
 * arrives as `*`-prefixed source lines. The declaration opens at the `Fields:`
 * line, wraps onto the following lines ("and an optional bounded `detail`.",
 * "`arg1`, `arg2`, …") and ends at the next tag line — `Scope:`, `Caller:`,
 * `Code:`, `THROTTLED:` — because that tag's prose may name fields again
 * (`Code:` really does: "the egress and latch codes"). A parse that read those
 * mentions as declarations would accept a typo, which is the one thing this
 * check exists to catch, so the declaration stops where the next tag starts.
 */
function fieldsFromBlock(lines: readonly string[]): string[] {
  const keys: string[] = [];
  let inFields = false;
  for (const line of lines) {
    const body = line.trim().replace(/^\/\/ ?/, "").replace(/^\*+\/?\s?/, "").trim();
    const declaration = body.match(/^Fields:\s*(.*)$/);
    if (declaration !== null) {
      inFields = true;
      addKeys(keys, declaration[1] ?? "");
      continue;
    }
    if (!inFields) continue;
    // The declaration ends at the next tag: a `Scope:`/`Caller:`/`Code:`/
    // `THROTTLED:` line opens a different section, and a line that BEGINS with a
    // backticked token whose key is already declared is the sentence that
    // follows the keys ("`keys` — the dropped key names …"), not more keys.
    if (/^[A-Z][A-Za-z]*:/.test(body)) {
      inFields = false;
      continue;
    }
    // A WRAPPED declaration continues with a lower-case connective ("and an
    // optional bounded `detail`.", "`arg1`, `arg2`, …"). Anything else is the
    // entry's prose, which names fields again while explaining them — reading
    // those mentions as declarations is what would let a key dropped from the
    // declaration itself pass this check.
    const wrapped = keys.length > 0 && /^(?:and|or|plus|then)\b/.test(body);
    const bullet = body.startsWith("`");
    if (!wrapped && !bullet) {
      inFields = false;
      continue;
    }
    if (bullet) {
      const lead = body.match(/^`([^`]+)`/);
      if (lead !== null && keys.includes(lead[1] ?? "")) {
        inFields = false;
        continue;
      }
    }
    addKeys(keys, body);
  }
  return keys;
}

/** Every backticked `` `key` `` in a fragment, in order and de-duplicated. */
function addKeys(keys: string[], fragment: string): void {
  for (const match of fragment.matchAll(/`([^`]+)`/g)) {
    const key = match[1] ?? "";
    if (!keys.includes(key)) keys.push(key);
  }
}

/** The table entry for a code, or `undefined`. */
function entryOf(code: string): LogEventDefinition | undefined {
  return (LOG_EVENTS as Record<string, LogEventDefinition>)[code];
}

/**
 * Parse ONE entry block's `Fields:` declaration out of its comment. The block
 * arrives as `*`-prefixed source lines. The declaration opens at the `Fields:`
 * line, wraps onto the following lines ("and an optional bounded `detail`.",
 * "`arg1`, `arg2`, …") and ends at the next tag line — `Scope:`, `Caller:`,
 * `Code:`, `THROTTLED:` — because that tag's prose may name fields again
 * (`Code:` really does: "the egress and latch codes"). A parse that read those
 * mentions as declarations would accept a typo, which is the one thing this
 * check exists to catch, so the declaration stops where the next tag starts.
 */
function fieldsFromBlock(lines: readonly string[]): string[] {
  const keys: string[] = [];
  let inFields = false;
  for (const line of lines) {
    const body = line.trim().replace(/^\/\/ ?/, "").replace(/^\*+\/?\s?/, "").trim();
    // Only the DECLARATION sentence counts: the prose that follows it — in the
    // same line or in a wrapped one — names fields again ("the dropped code",
    // "`Code:` really does"), and reading those mentions as declarations is
    // exactly what would let a key removed from the declaration pass this check.
    const declaration = body.match(/^Fields:\s*(.*)$/);
    if (declaration !== null) {
      inFields = true;
      addKeys(keys, firstSentence(declaration[1] ?? ""));
      if (firstSentence(declaration[1] ?? "") === (declaration[1] ?? "")) continue;
      inFields = false;
      continue;
    }
    if (!inFields) continue;
    // A tag line (`Scope:`, `Caller:`, `Code:`, `THROTTLED:`) and the prose
    // sentence that follows the keys both end the declaration: the first by
    // opening a new section, the second by finishing the sentence — and that
    // sentence may wrap onto a line that BEGINS with a backticked key
    // ("`arg1`, `arg2`, …"), which is why only a `.` + capital ends it.
    if (/^[A-Z][A-Za-z]*:/.test(body) || body.startsWith("`")) {
      inFields = false;
      continue;
    }
    addKeys(keys, firstSentence(body));
    if (firstSentence(body) !== body) inFields = false;
  }
  return keys;
}

/**
 * The first SENTENCE of a fragment. A full stop only ends one when a capital
 * follows it: a file name (`registry.ts`), an identifier and an abbreviation all
 * contain stops that are not sentence ends, and stopping at those would truncate
 * a wrapped declaration (which is why the same rule cannot be "split on `.`").
 */
function firstSentence(text: string): string {
  const stop = /\.\s+[A-Z]/.exec(text);
  return stop === null ? text : text.slice(0, stop.index + 1);
}

/** Every backticked `` `key` `` in a fragment, in order and de-duplicated. */
function addKeys(keys: string[], fragment: string): void {
  for (const match of fragment.matchAll(/`([^`]+)`/g)) {
    const key = match[1] ?? "";
    if (!keys.includes(key)) keys.push(key);
  }
}

/**
 * The `Fields:` keys EVERY entry declares, read out of the registry's own
 * comment blocks — the block that precedes the entry's code line (the same
 * order tests/log/redaction-scan.test.ts relies on). The parse is asserted
 * non-empty for the subject-keyed entries below, so a parse that silently
 * returned nothing fails the check instead of passing it.
 */
function declaredFields(text: string): Map<string, string[]> {
  const lines = text.split("\n");
  const declared = new Map<string, string[]>();
  let comment: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/**")) {
      comment.push(line);
      continue;
    }
    const code = trimmed.match(/^"([^"]+)":\s*\{/)?.[1];
    if (code !== undefined) {
      declared.set(code, fieldsFromBlock(comment));
      comment = [];
      continue;
    }
    if (trimmed.length > 0) comment = [];
  }
  return declared;
}

describe("throttle policy", () => {
  it("throttles exactly the entries the density evidence names, with these windows", () => {
    const throttled = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => (entry as LogEventDefinition).throttleMs !== undefined)
      .map(([code, entry]) => [code, (entry as LogEventDefinition).throttleMs]);
    expect(throttled).toEqual(THROTTLED.map(([code, window]) => [code, window]));
  });

  it("leaves every first-failure event unthrottled", () => {
    for (const code of NEVER_THROTTLED) {
      const entry = entryOf(code);
      expect(entry, `${code} must stay registered`).toBeDefined();
      expect(entry?.throttleMs, `${code} reports a first failure and must never be throttled`).toBeUndefined();
    }
  });

  it("keeps each window a positive whole number of milliseconds", () => {
    for (const [code, window] of THROTTLED) {
      expect(Number.isInteger(window), `${code} window must be a whole number`).toBe(true);
      expect(window, `${code} window must be positive`).toBeGreaterThan(0);
      expect(entryOf(code)?.throttleMs, `${code} window must match the table`).toBe(window);
    }
  });

  it("keys every window that could hide another subject's first report by SUBJECT", () => {
    // The two entries whose records describe a subject that VARIES: an unknown
    // code (every drifted code is its own subject) and the narrowing report
    // (every caller channel is). A (channel, code) window would let the first
    // subject swallow every other subject's first report for a whole minute.
    expect(entryOf("log.event.unknown-code")?.throttleBy).toBe("code");
    expect(entryOf("log.field.narrowed")?.throttleBy).toBe("channel");
  });

  it("validates every `throttleBy` against what the entry's callers actually pass", () => {
    const registry = readFileSync(REGISTRY_PATH, "utf8");
    const declared = declaredFields(registry);
    const subjectKeyed = Object.entries(LOG_EVENTS).filter(
      ([, entry]) => (entry as LogEventDefinition).throttleBy !== undefined,
    );
    // The check has entries to check: a table that lost every `throttleBy` would
    // otherwise pass this case by having nothing to verify.
    expect(subjectKeyed.map(([code]) => code)).toEqual([
      "log.event.unknown-code",
      "log.field.narrowed",
    ]);

    // WHERE EACH ENTRY'S RECORD IS BUILT. A registered event's record comes from
    // a `logEvent("<code>", { … })` call site; the unknown-code report is built
    // inline in the runtime's own branch, so its literal is read there. Both are
    // literal object keys: a typo in `throttleBy` names a key no record carries,
    // and the check below fails rather than letting the subject silently become
    // the empty string (one window per channel+code, i.e. the cross-subject
    // suppression this whole file is about).
    const atCallSites = callSiteFields();
    const runtime = readFileSync(RUNTIME_PATH, "utf8");
    const emitted = (code: string): string[] => {
      if (code !== "log.event.unknown-code") return atCallSites.get(code) ?? [];
      const branch = runtime.slice(runtime.indexOf("state.unknownCodes += 1"));
      const brace = branch.indexOf("{");
      return brace < 0 ? [] : literalKeys(branch, brace).keys;
    };

    for (const [code, entry] of subjectKeyed) {
      const field = (entry as LogEventDefinition).throttleBy as string;
      const fields = emitted(code);
      expect(fields.length, `${code} must be emitted with fields this check can read`).toBeGreaterThan(0);
      expect(
        fields,
        `${code} throttles by \`${field}\`, which no call site of it passes`,
      ).toContain(field);
      // The subject read itself: a string field becomes the subject, anything
      // else (missing, non-string) is the empty subject rather than a throw.
      expect(logThrottleSubject({ [field]: "subject-value" }, field)).toBe("subject-value");
      expect(logThrottleSubject({ [field]: 7 }, field)).toBe("");
    }

    // The entry's `Fields:` line is held to its emission too, so a field the
    // record carries and the documentation drops is reported. This half is
    // documentation, not proof: a field named in the same sentence's prose while
    // being explained still reads as declared, which is exactly why the
    // call-site check above — the literal the record is built from — is the one
    // that pins the SUBJECT's name.
    const declaredUnknown = declared.get("log.event.unknown-code") ?? [];
    expect(declaredUnknown.length, "the unknown-code entry must document Fields:").toBeGreaterThan(0);
    for (const key of emitted("log.event.unknown-code")) {
      expect(declaredUnknown, `the unknown-code entry emits \`${key}\` but does not declare it`).toContain(key);
    }
    // The other subject-keyed entry documents the field its window is keyed by.
    expect(declared.get("log.field.narrowed") ?? []).toContain("channel");
  });

  it("separates one (channel, code) by subject, and degrades safely without one", () => {
    const plain = logThrottleKey("log", "log.event.unknown-code");
    expect(logThrottleKey("log", "log.event.unknown-code", "code-a")).not.toBe(plain);
    expect(logThrottleKey("log", "log.event.unknown-code", "code-b")).not.toBe(
      logThrottleKey("log", "log.event.unknown-code", "code-a"),
    );
    // No subject === the pre-subject key, which is how an entry without
    // `throttleBy` keeps behaving exactly as it did before.
    expect(logThrottleKey("log", "log.event.unknown-code", "")).toBe(plain);

    // A broken subject read degrades to the empty subject: it never throws and
    // never invents a subject from another field's value.
    expect(logThrottleSubject(undefined, "code")).toBe("");
    expect(logThrottleSubject({ code: "drifted" }, undefined)).toBe("");
  });
});

describe("throttle policy in the pipeline", () => {
  let state: { env: Record<string, string | undefined>; dir: string };
  let memory: MemorySink;
  let now = 0;

  beforeEach(() => {
    state = beginLogTest();
    memory = createMemorySink({ capacity: 50 });
    now = 1_000;
    __setLogClockForTest(() => now);
    configureLogging({ sinks: [memory], level: "debug" });
  });

  afterEach(() => {
    endLogTest(state);
  });

  it("collapses a burst of sweeps and reports the suppressed count on the next window", () => {
    logEvent("sweep.summary", { started: [] });
    now = 1_100;
    logEvent("sweep.summary", { started: ["a"] });
    now = 9_000;
    logEvent("sweep.summary", { started: ["b"] });

    // Three sweeps inside the 10s window, one line: the burst is one observation
    // repeated, and the first sweep's own fields are what survives.
    expect(memory.size).toBe(1);
    expect(memory.last()?.fields).toEqual({ started: [] });

    now = 11_000;
    logEvent("sweep.summary", { started: ["c"] });

    expect(memory.size).toBe(2);
    expect(memory.last()?.fields).toEqual({ started: ["c"], suppressed: 2 });
  });

  it("keeps the first failure of a throttled code visible", () => {
    logEvent("dispatch.unclaimed-confirmation", { executionId: "e1", verdict: "fenced" });
    expect(memory.size).toBe(1);
    expect(memory.last()?.fields).toEqual({ executionId: "e1", verdict: "fenced" });
  });

  it("never suppresses a first-failure event, however fast it repeats", () => {
    for (let index = 0; index < 3; index++) {
      now = 1_000 + index;
      logEvent("sweep.store-blocked", { reason: "storage " + index });
    }
    expect(memory.size).toBe(3);
    expect(memory.records().every((record) => record.fields.suppressed === undefined)).toBe(true);
  });
});
