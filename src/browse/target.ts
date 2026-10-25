/**
 * The target syntax a model may pass to every `browse_*` element action.
 *
 * One string is parsed into exactly one {@link TargetPlan}; nothing is guessed.
 * The grammar is deliberately small and textual because it is what the model
 * writes in a tool argument:
 *
 * - `e12` or `@e12` — a ref from the latest `browse_snapshot`;
 * - `css=<selector>` — a raw CSS selector;
 * - `text=<text>` — visible text (a bare string is also text);
 * - `role=<role>` with an optional `[name="<name>"]`, where escaped quotes are
 *   allowed and the role is compared case-insensitively;
 * - `label=`, `placeholder=`, `alt=`, `title=`, `testid=`.
 *
 * An empty target, an empty value and an unrecognized prefix are all
 * `invalid_target`: silently treating a mistyped `href=` as text would click
 * something the model never named. {@link describeTarget} renders a plan back
 * into the same grammar so a result can echo exactly what was targeted.
 */

import { browseError, type TargetPlan } from "./types.ts";

/** The full syntax, repeated in every `invalid_target` hint. */
export const TARGET_SYNTAX =
  'Use eN or @eN from browse_snapshot, or one of css=<selector>, text=<text>, role=<role>[name="<name>"], label=<text>, placeholder=<text>, alt=<text>, title=<text> or testid=<id>.';

/** A normalized ref (`e12`), as stored in a snapshot and in a target plan. */
export const BROWSE_REF_PATTERN = /^e\d+$/;

/** The user-facing ref forms: `e12` and `@e12`, case-insensitively. */
const REF_INPUT_PATTERN = /^@?e(\d+)$/i;

/** A `name=value` prefix candidate, used to reject unknown prefixes by name. */
const PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)=/;

/** `role` plus an optional quoted name, where `\"` and `\\` may be escaped. */
const ROLE_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)\s*(?:\[\s*name\s*=\s*"((?:[^"\\]|\\.)*)"\s*\])?$/;

/** The value prefixes this parser understands. */
const KNOWN_PREFIXES = [
  "css",
  "text",
  "role",
  "label",
  "placeholder",
  "alt",
  "title",
  "testid",
] as const;

/**
 * Parse one target string.
 *
 * Whitespace around the whole target and around a prefixed value is ignored; a
 * bare string with no known prefix is text. Throws `invalid_target` with the
 * syntax in the hint for every unusable form.
 */
export function parseTarget(input: string): TargetPlan {
  const target = input.trim();
  if (target === "") {
    throw browseError("invalid_target", "the target is empty", TARGET_SYNTAX);
  }

  const refMatch = REF_INPUT_PATTERN.exec(target);
  if (refMatch !== null) {
    return { kind: "ref", ref: `e${refMatch[1]}` };
  }

  const prefixMatch = PREFIX_PATTERN.exec(target);
  if (prefixMatch === null) {
    return { kind: "text", text: target };
  }

  const prefix = prefixMatch[1].toLowerCase();
  const value = target.slice(prefixMatch[0].length).trim();
  if (value === "") {
    throw browseError(
      "invalid_target",
      `the ${prefix}= target has no value`,
      TARGET_SYNTAX,
    );
  }

  switch (prefix) {
    case "css":
      return { kind: "css", selector: value };
    case "text":
      return { kind: "text", text: value };
    case "role":
      return parseRoleTarget(value);
    case "label":
      return { kind: "label", text: value };
    case "placeholder":
      return { kind: "placeholder", text: value };
    case "alt":
      return { kind: "alt", text: value };
    case "title":
      return { kind: "title", text: value };
    case "testid":
      return { kind: "testid", testId: value };
    default:
      throw browseError(
        "invalid_target",
        `unknown target prefix "${prefix}=" (supported: ${KNOWN_PREFIXES.join(", ")})`,
        TARGET_SYNTAX,
      );
  }
}

/** Parse the role form's value: `button` or `button[name="Save"]`. */
function parseRoleTarget(value: string): TargetPlan {
  const match = ROLE_PATTERN.exec(value);
  if (match === null) {
    throw browseError(
      "invalid_target",
      `the role target "${value}" is malformed`,
      'Write role=<role> with an optional quoted name, for example role=button[name="Save"].',
    );
  }
  const role = match[1].toLowerCase();
  if (match[2] === undefined) return { kind: "role", role };
  const name = unescapeQuoted(match[2]);
  if (name === "") {
    throw browseError(
      "invalid_target",
      "the role target has an empty name",
      'Omit [name="..."] to match by role alone, or provide a non-empty name.',
    );
  }
  return { kind: "role", role, name };
}

/** Render a plan back into the target grammar for results and error text. */
export function describeTarget(plan: TargetPlan): string {
  switch (plan.kind) {
    case "ref":
      return `ref=${plan.ref}`;
    case "css":
      return `css=${plan.selector}`;
    case "text":
      return `text=${plan.text}`;
    case "role":
      return plan.name === undefined
        ? `role=${plan.role}`
        : `role=${plan.role}[name="${escapeQuoted(plan.name)}"]`;
    case "label":
      return `label=${plan.text}`;
    case "placeholder":
      return `placeholder=${plan.text}`;
    case "alt":
      return `alt=${plan.text}`;
    case "title":
      return `title=${plan.text}`;
    case "testid":
      return `testid=${plan.testId}`;
  }
}

/** Whether a plan is a snapshot ref, which the session validates before use. */
export function isRefTarget(plan: TargetPlan): plan is { kind: "ref"; ref: string } {
  return plan.kind === "ref";
}

/** Undo the quoting a role name may carry: `\"` and `\\`. */
function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

/** Quote a value for the target grammar; the inverse of {@link unescapeQuoted}. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
