/**
 * KEY-NAME REDACTION: the last line of the privacy rule.
 *
 * Three things have to be true at once:
 *
 * 1. EVERY LISTED KEY IS WITHHELD, in any spelling a call site uses —
 *    `credential`, `attemptCredential`, `api_key`, `API_KEY`, `accessToken`.
 *    Containment (not equality) is what catches the prefixed forms a credential
 *    actually travels under.
 * 2. THE IDS SURVIVE. `executionId`, `attemptId` and friends are exactly what
 *    this log exists to carry, and no value-shaped heuristic may touch them —
 *    which is why stage 1 matches names only.
 * 3. THE SHAPE IS UNTOUCHED. Keys, their order, the value shapes and even an
 *    undefined value stay exactly as the caller wrote them; only the value of a
 *    matching key is replaced.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { __resetLoggingForTest, configureLogging, createLogger, withLogScope } from "../../src/log/index.ts";
import { REDACTED_VALUE, SENSITIVE_KEY_TERMS, isSensitiveFieldKey, redactFields } from "../../src/log/redact.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** The words the brief lists as sensitive key names. */
const LISTED_TERMS: readonly string[] = [
  "credential",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "api_key",
  "apikey",
  "cookie",
  "bearer",
];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 20 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  __resetLoggingForTest();
  endLogTest(state);
});

describe("key-name redaction", () => {
  it("covers every listed term, in the terms table and in a lookup", () => {
    for (const term of LISTED_TERMS) {
      expect(isSensitiveFieldKey(term)).toBe(true);
      expect(SENSITIVE_KEY_TERMS).toContain(term.replace(/[^a-z0-9]/g, ""));
    }
  });

  it("withholds a listed key whatever its case or separators", () => {
    for (const key of ["credential", "CREDENTIAL", "token", "Token", "api_key", "API_KEY", "apiKey", "apikey", "Authorization", "cookie", "Bearer", "passwd", "PASSWORD", "secret"]) {
      expect(isSensitiveFieldKey(key)).toBe(true);
      expect(redactFields({ [key]: "sk-live-do-not-log" })).toEqual({ [key]: REDACTED_VALUE });
    }
  });

  it("withholds the prefixed and suffixed forms a credential actually travels under", () => {
    for (const key of [
      "attemptCredential",
      "accessToken",
      "refresh_token",
      "authToken",
      "bearerToken",
      "userPassword",
      "authorizationHeader",
      "sessionCookie",
      "clientSecret",
      "credentialId",
    ]) {
      expect(isSensitiveFieldKey(key)).toBe(true);
    }
  });

  it("does not withhold the ids and states this log exists to carry", () => {
    for (const key of [
      "executionId",
      "sessionId",
      "graphId",
      "runId",
      "nodeId",
      "attemptId",
      "effectId",
      "tool",
      "reason",
      "status",
      "count",
      "message",
      "id",
      "channel",
    ]) {
      expect(isSensitiveFieldKey(key)).toBe(false);
    }
  });

  it("ignores a key with nothing to compare", () => {
    expect(isSensitiveFieldKey("")).toBe(false);
    expect(isSensitiveFieldKey("---")).toBe(false);
  });

  it("preserves keys, order, value shapes and undefined values", () => {
    const fields = {
      reason: "denied",
      credential: "sk-live-do-not-log",
      count: 2,
      ids: ["g1", "g2"],
      missing: undefined,
    };
    const redacted = redactFields(fields);

    expect(Object.keys(redacted)).toEqual(["reason", "credential", "count", "ids", "missing"]);
    expect(redacted.reason).toBe("denied");
    expect(redacted.credential).toBe(REDACTED_VALUE);
    expect(redacted.count).toBe(2);
    expect(redacted.ids).toEqual(["g1", "g2"]);
    expect("missing" in redacted).toBe(true);
    expect(redacted.missing).toBeUndefined();
  });

  it("returns a new object and never mutates the caller's fields", () => {
    const fields = { credential: "sk-live-do-not-log", reason: "denied" };
    const redacted = redactFields(fields);
    expect(redacted).not.toBe(fields);
    expect(fields.credential).toBe("sk-live-do-not-log");
    expect(redacted.credential).toBe(REDACTED_VALUE);
  });

  it("redacts on the way out of the pipeline, whatever sink is watching", async () => {
    await withLogScope({ attemptId: "a1" }, async () => {
      createLogger("dispatch").warn("delivery failed", {
        attemptCredential: "sk-live-do-not-log",
        authorization: "Bearer sk-live-do-not-log",
        executionId: "3f2a-9c11",
        reason: "unknown",
      });
    });

    const fields = memory.last()?.fields;
    expect(fields?.attemptCredential).toBe(REDACTED_VALUE);
    expect(fields?.authorization).toBe(REDACTED_VALUE);
    expect(fields?.executionId).toBe("3f2a-9c11");
    expect(fields?.reason).toBe("unknown");
    // Identity is not a field at all, so it cannot be redacted away.
    expect(memory.last()?.scope).toEqual({ attemptId: "a1" });
  });

  it("redacts a failure report's own fields without touching the sink name", () => {
    const boom = (): never => {
      throw new Error("sink exploded");
    };
    configureLogging({ sinks: [boom, memory] });
    createLogger("dispatch").warn("anything");

    const report = memory.records().find((record) => record.code === "log.sink.failed");
    expect(report?.fields.sink).toBe("sink#0");
    expect(report?.fields.error).toBe("Error");
  });
});
