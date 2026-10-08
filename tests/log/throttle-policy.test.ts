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
import type { LogEventCode, LogEventDefinition } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { logThrottleKey, logThrottleSubject } from "../../src/log/throttle.ts";
import { createSubLogger } from "../../src/logger.ts";
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
 * The value SOURCE of every top-level key of the object literal that starts at
 * `start` (which must point at `{`), read out of the call site itself. The VALUE
 * is what a `throttleBy` has to be checked against: `keys: "a"` and
 * `keys: ["a"]` pass the same key and only one of them can become a subject. A
 * shorthand property (`{ channel }`) writes no value of its own — the binding IS
 * the value — so the key is returned as its own source. This is the same
 * source-adjacent read tests/log/redaction-scan.test.ts does, and for the same
 * reason: a call site that stops passing a string must be able to fail a test
 * without anyone executing it.
 */
function literalValueSources(text: string, start: number): Map<string, string> {
  const values = new Map<string, string>();
  let depth = 0;
  let quote = "";
  let raw = "";
  let colon = -1;
  const record = (): void => {
    const key = (colon < 0 ? raw : raw.slice(0, colon)).trim().replace(/^["'`]|["'`]$/g, "");
    const source = colon < 0 ? key : raw.slice(colon + 1).trim();
    if (key.length > 0 && !values.has(key)) values.set(key, source);
    raw = "";
    colon = -1;
  };
  for (let index = start; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote.length > 0) {
      raw += char;
      if (char === "\\") {
        raw += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      raw += char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      if (depth > 0) raw += char;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        record();
        return values;
      }
      raw += char;
      continue;
    }
    if (char === "," && depth === 1) {
      record();
      continue;
    }
    if (char === ":" && depth === 1 && colon < 0) colon = raw.length;
    if (depth >= 1) raw += char;
  }
  record();
  return values;
}

/** A string literal, a template with no interpolation, or a `String(…)` call. */
function isStringForm(source: string): boolean {
  return (
    /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/s.test(source) ||
    /^`[^`$\\]*`$/s.test(source) ||
    /^String\s*\(/.test(source)
  );
}

/**
 * Every identifier `file` binds to a string: an explicit `name: string` (a
 * parameter, a property or a variable), or a declaration initialised from a
 * string form or from another binding. The pass repeats because a binding may be
 * written in terms of another one: `const dropped = String(code)` — the
 * runtime's own case — needs no second pass, but `const a = b` does.
 */
function stringBindings(file: string): Set<string> {
  const bound = new Set<string>();
  for (const match of file.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*string\b/g)) bound.add(match[1] ?? "");
  const declarations = [...file.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)];
  for (let pass = 0; pass < 4; pass++) {
    const before = bound.size;
    for (const [, name = "", initialiser = ""] of declarations) {
      if (bound.has(name)) continue;
      const source = initialiser.trim();
      if (isStringForm(source) || (/^[A-Za-z_$][\w$]*$/.test(source) && bound.has(source))) bound.add(name);
    }
    if (bound.size === before) break;
  }
  return bound;
}

/**
 * True when the source `expression`, read in the file it was written in,
 * PROVABLY produces a string — the only shape `logThrottleSubject` turns into a
 * subject: a string form, or a bare identifier that file binds to a string. A
 * member expression (`state.unknownCodes`), an array (`[…new Set(narrowed)]`), a
 * number and a boolean are all NOT strings, and that is the point: a
 * `throttleBy` naming a field its call site passes but does not fill with a
 * string would silently degrade every report to the empty subject, and this is
 * what makes that fail a test instead of shipping.
 */
function isStringValueSource(expression: string, file: string): boolean {
  const source = expression.trim();
  if (isStringForm(source)) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(source)) return false;
  return stringBindings(file).has(source);
}

/**
 * One object literal a call site passes: the TEXT of the file it was read out of
 * (a value source is only readable where its bindings live), its top-level keys
 * in source order, and each key's value source (`{ channel }` gives `channel` →
 * `channel`).
 */
interface CallSiteLiteral {
  readonly fileText: string;
  readonly keys: string[];
  readonly values: Map<string, string>;
}

/** Every call site's literal, per event code. */
function callSiteFields(): Map<string, CallSiteLiteral[]> {
  const found = new Map<string, CallSiteLiteral[]>();
  const pattern = /(?:logEvent|\.event)\(\s*(?:"([^"]+)"|'([^']+)')\s*,\s*/g;
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const code = match[1] ?? match[2] ?? "";
      const brace = text.indexOf("{", (match.index ?? 0) + match[0].length);
      if (brace < 0) continue;
      const values = literalValueSources(text, brace);
      const sites = found.get(code) ?? [];
      sites.push({ fileText: text, keys: [...values.keys()], values });
      found.set(code, sites);
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
    const emitted = (code: string): CallSiteLiteral[] => {
      if (code !== "log.event.unknown-code") return atCallSites.get(code) ?? [];
      // The unknown-code report is built inline in the runtime's own branch.
      const branch = runtime.slice(runtime.indexOf("state.unknownCodes += 1"));
      const brace = branch.indexOf("{");
      if (brace < 0) return [];
      const values = literalValueSources(branch, brace);
      return [{ fileText: runtime, keys: [...values.keys()], values }];
    };

    for (const [code, entry] of subjectKeyed) {
      const field = (entry as LogEventDefinition).throttleBy as string;
      const sites = emitted(code);
      const fields = [...new Set(sites.flatMap((site) => site.keys))];
      expect(fields.length, `${code} must be emitted with fields this check can read`).toBeGreaterThan(0);
      expect(
        fields,
        `${code} throttles by \`${field}\`, which no call site of it passes`,
      ).toContain(field);
      // AND ITS VALUE, NOT ONLY ITS NAME. `logThrottleSubject` turns a STRING
      // into a subject and everything else into the EMPTY one, so a `throttleBy`
      // naming a field the record fills with a count (`dropped`) or an array
      // (`keys`) would silently collapse every report about this entry onto one
      // window — the cross-subject suppression this file exists to prevent, with
      // nothing failing. Every call site that passes the field must pass a
      // string.
      for (const site of sites) {
        const source = site.values.get(field);
        if (source === undefined) continue;
        expect(
          isStringValueSource(source, site.fileText),
          `${code} throttles by \`${field}\`, but its call site passes \`${source}\` — not a string, so the subject would silently be empty`,
        ).toBe(true);
      }
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
    for (const key of [...new Set(emitted("log.event.unknown-code").flatMap((site) => site.keys))]) {
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

  it("reads a non-empty subject out of the record each subject-keyed entry really emits", () => {
    // THE LAST WORD ON `throttleBy`: not what the field is CALLED but what the
    // record carries under it. Each row below drives the entry's OWN call site —
    // the runtime's inline literal for a drifted code, the compatibility shell's
    // for a narrowed field — and hands the real record back to the pipeline's own
    // reader. A field that is present but not a string (`dropped`, `count`, an
    // array of keys) reads as the empty subject here and fails, which is exactly
    // the silent degradation the source check above cannot see.
    const site: Record<string, () => void> = {
      "log.event.unknown-code": () => logEvent("polish.drifted.code" as LogEventCode, {}),
      "log.field.narrowed": () =>
        createSubLogger("polish:subject-probe").warn("probe", { payload: { nested: true } }),
    };
    for (const [code, entry] of Object.entries(LOG_EVENTS)) {
      const throttleBy = (entry as LogEventDefinition).throttleBy;
      if (throttleBy === undefined) continue;
      const emit = site[code];
      expect(emit, `${code} throttles by \`${throttleBy}\` and must have a call site this check can drive`).toBeDefined();
      emit?.();
      const record = memory.records().find((entry) => entry.code === code);
      expect(record, `${code} must emit a record under this probe`).toBeDefined();
      expect(
        logThrottleSubject(record?.fields, throttleBy),
        `${code} throttles by \`${throttleBy}\`, which its own record does not carry as a non-empty string`,
      ).not.toBe("");
    }
  });
});
