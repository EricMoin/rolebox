// ── Last-line key-name redaction ────────────────────────────────────────────
//
// THE FIELD NAMES ARE THE RULE. Before a record leaves the pipeline, every
// field whose KEY names a credential is replaced with "[redacted]". The
// structure never changes: no key is added, removed or reordered, and only the
// VALUE of a matching key is exchanged, so a reader can still tell that the
// field was there and was withheld on purpose.
//
// WHY THIS STAGE MATCHES NAMES AND NOT VALUES
//   A value-shaped heuristic (looks like a JWT, looks like a UUID, high
//   entropy) cannot tell an attempt credential from an execution id, and
//   redacting the ids this log exists to carry would destroy the diagnostic
//   value of the whole pipeline. Name matching has no such ambiguity: a key
//   called `credential`, `accessToken` or `api_key` is a secret by contract,
//   and `executionId` is not.
//
// WHY CONTAINMENT RATHER THAN EQUALITY
//   Call sites spell the same secret in different shapes: `token`, `accessToken`,
//   `refresh_token`, `attemptCredential`, `apiKey`, `api_key`, `API_KEY`. An
//   equality rule against the listed words would miss every prefixed form — the
//   exact forms a credential actually travels under — so the comparison is made
//   on the key with its separators removed and case folded, and a key that
//   CONTAINS one of the sensitive terms is redacted. The cost of the wider rule
//   is a false positive (`tokenCount` is withheld too); the cost of the narrow
//   rule is a leaked credential. This stage deliberately pays the first.
//
// This is the LAST line, not the only one: the privacy rule (fields carry ids,
// states, reasons and counts only) is enforced at the call site and by the
// narrow LogFieldValue type in ./types.ts.

import type { LogFieldValue, LogFields } from "./types.ts";

/** What a withheld value is replaced with. */
export const REDACTED_VALUE = "[redacted]";

/**
 * The sensitive key terms, already in their comparison form: lowercase with
 * separators removed (`api_key` → `apikey`).
 */
export const SENSITIVE_KEY_TERMS: readonly string[] = [
  "credential",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "apikey",
  "cookie",
  "bearer",
];

/** The comparison form of a key: lowercase, separators removed. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a field with this key must have its value withheld. */
export function isSensitiveFieldKey(key: string): boolean {
  if (typeof key !== "string") return false;
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  return SENSITIVE_KEY_TERMS.some((term) => normalized.includes(term));
}

/**
 * Return the fields with every sensitive value withheld.
 *
 * The keys, their order and the shape of every value are preserved; a key whose
 * value is `undefined` stays present and undefined (the record builder drops it
 * later, exactly as it drops any other undefined field).
 */
export function redactFields(fields: LogFields): LogFields {
  const redacted: Record<string, LogFieldValue | undefined> = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    redacted[key] = isSensitiveFieldKey(key) && value !== undefined ? REDACTED_VALUE : value;
  }
  return redacted;
}
