/// <reference types="bun-types" />

/**
 * DshRoleboxLogsWebRoute tests — the structural adapter exposing the rolebox
 * log VIEW as a `prefix` route on the host web server.
 *
 * Like the monitor-route tests, the adapter is driven against a FAKE registrar
 * double (the registered route is captured and its handler invoked with mock
 * req/res — no `node:http` server is ever created) and against a REAL fixture
 * log directory: the tests write the writer's own JSON lines with
 * `appendFileSync` and let the real read/view layer scan them, so the suite
 * exercises the wire between the route and the files, not a stub of it.
 *
 * Verifies the documented contract:
 *   - register() captures exactly one prefix route at `/rolebox/logs`
 *     (a DISTINCT registration from the monitor route's `/rolebox`) and the
 *     returned disposer unregisters it
 *   - GET /rolebox/logs → 200 with EXACTLY the five view keys
 *     (`records` / `cursor` / `source` / `truncated` / `skippedLines`), with
 *     `source` naming the directory (or the single file) that was read
 *   - the cursor is a usable watermark: a second request with `?cursor=` adds
 *     only what was appended after the first answer
 *   - every filter parameter (`level` / `channel` / `code` / `graph` /
 *     `session` / `text`) narrows the answer, and they AND together
 *   - a missing or empty directory is `200` with an empty set; malformed lines
 *     are COUNTED in `skippedLines`, never fatal
 *   - an illegible parameter is `400` with a readable message (never `500`),
 *     an unknown sub-path is `404`, a known path with the wrong method `405`
 *   - the source is FIXED at construction: `?logDir=` / `?logFile=` in the
 *     query string change nothing, and nothing the request carried (query
 *     values, credentials, headers) is echoed back
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DshRoleboxLogsWebRoute,
  DEFAULT_LOGS_ROUTE_LIMIT,
  LOGS_ROUTE_PARAMS,
  ROLEBOX_LOGS_ROUTE_PREFIX,
  parseLogsRouteQuery,
  type RoleboxLogsViewBody,
} from "../../src/platform/adapters/dsh/web-rolebox-logs-route.ts";
import { ROLE_SWITCH_ROUTE_PREFIX } from "../../src/platform/adapters/dsh/web-role-switch-route.ts";
import type {
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "../../src/platform/adapters/dsh/web-role-switch-route.ts";
import type { LogRecord } from "../../src/log/index.ts";

// ── Mock req/res (no node:http server is created) ───────────────────────────

/** Minimal IncomingMessage double: url/method + data/end listeners. */
class MockReq {
  url: string;
  method: string;
  private readonly listeners = new Map<string, Array<(chunk?: unknown) => void>>();

  constructor(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  on(event: string, cb: (chunk?: unknown) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  finish(): void {
    for (const cb of this.listeners.get("end") ?? []) cb();
  }
}

/** Minimal ServerResponse double: records status/headers/body. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(text = "") {
    this.body = text;
    return this;
  }
}

/** Invoke a route handler with a mock req/res and await completion. */
async function invoke(
  handler: DshWebRouteLike["handler"],
  method: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  req.finish();
  if (pending) await pending;
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

/** Parse a JSON response body, or fail loudly if it isn't JSON. */
function json<T = any>(result: { text: string }): T {
  return JSON.parse(result.text) as T;
}

/** Fake registrar double — captures registered routes, returns disposers. */
function createFakeWebServer() {
  const registered: DshWebRouteLike[] = [];
  const webServer: DshWebServerRouteRegistrar = {
    register(route: DshWebRouteLike): () => void {
      registered.push(route);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const idx = registered.indexOf(route);
        if (idx >= 0) registered.splice(idx, 1);
      };
    },
  };
  return { webServer, registered };
}

// ── Fixture log files ───────────────────────────────────────────────────────

/** One writer-shaped JSON line: fields and scope separate, nothing nested. */
function recordLine(overrides: Partial<LogRecord> & { time: number }): string {
  const record = {
    level: "info",
    channel: "graph:host",
    message: "something happened",
    fields: {},
    scope: {},
    process: { pid: 4242, role: "host" },
    ...overrides,
  };
  return JSON.stringify(record) + "\n";
}

/** Append lines to one channel file in the fixture directory. */
function appendLines(dir: string, channel: string, lines: readonly string[]): void {
  appendFileSync(join(dir, `${channel}.log`), lines.join(""));
}

/** The record times every fixture uses: distinct milliseconds, ascending. */
const T0 = 1_791_450_000_000;

/** Six records across two channels, four levels, codes and scopes. */
const SIX_RECORDS: readonly string[] = [
  recordLine({
    time: T0,
    level: "debug",
    channel: "web-ui",
    message: "panel mounted",
    fields: { nodeId: "n0" },
    scope: { graphId: "g-other", sessionId: "s-other" },
  }),
  recordLine({
    time: T0 + 1_000,
    level: "info",
    channel: "graph:host",
    code: "graph.advance",
    message: "Graph g1 advanced",
    scope: { graphId: "g1", sessionId: "s1" },
  }),
  recordLine({
    time: T0 + 2_000,
    level: "warn",
    channel: "graph:host",
    code: "sweep.store-blocked",
    message: "Store blocked by lock",
    fields: { reason: "lock" },
    scope: { graphId: "g1", sessionId: "s1" },
  }),
  recordLine({
    time: T0 + 3_000,
    level: "error",
    channel: "dispatch",
    code: "dispatch.failed",
    message: "Dispatch failed",
    fields: { attemptId: "a2", count: 3 },
    scope: { sessionId: "s2" },
  }),
  recordLine({
    time: T0 + 4_000,
    level: "warn",
    channel: "web-ui",
    message: "Slow poll",
    scope: { sessionId: "s2" },
  }),
  recordLine({
    time: T0 + 5_000,
    level: "fatal",
    channel: "graph:host",
    code: "process.fatal",
    message: "Process cannot go on",
    scope: { graphId: "g1" },
  }),
];

/** A fresh fixture directory per test, removed afterwards. */
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "dsh-logs-route-"));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** A route over the current fixture directory (explicit read-side source). */
function makeRoute(options: { logDir?: string; logFile?: string } = {}) {
  return new DshRoleboxLogsWebRoute({ logDir: fixtureDir, ...options });
}

/** GET the route root and parse the body. */
async function get(
  route: DshRoleboxLogsWebRoute,
  query = "",
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return invoke(
    (req, res) => route.handle(req, res),
    "GET",
    ROLEBOX_LOGS_ROUTE_PREFIX + query,
  );
}

/** GET the route root, expecting a 200 view body. */
async function getView(
  route: DshRoleboxLogsWebRoute,
  query = "",
): Promise<RoleboxLogsViewBody> {
  const result = await get(route, query);
  expect(result.status).toBe(200);
  return json<RoleboxLogsViewBody>(result);
}

// ── Registration ────────────────────────────────────────────────────────────

describe("DshRoleboxLogsWebRoute registration", () => {
  it("register() captures exactly one prefix route at /rolebox/logs with a handler", () => {
    const route = makeRoute();
    const { webServer, registered } = createFakeWebServer();

    route.register(webServer);

    expect(registered).toHaveLength(1);
    expect(registered[0]!.kind).toBe("prefix");
    expect(registered[0]!.path).toBe("/rolebox/logs");
    expect(registered[0]!.path).toBe(ROLEBOX_LOGS_ROUTE_PREFIX);
    expect(typeof registered[0]!.handler).toBe("function");
  });

  it("mounts under the shared /rolebox prefix without claiming it", () => {
    // The host resolves by longest prefix and refuses duplicate (kind, path)
    // pairs, so the logs route is a DIFFERENT registration from the monitor
    // route's /rolebox — that is what keeps the monitor route untouched.
    expect(ROLEBOX_LOGS_ROUTE_PREFIX).toBe(`${ROLE_SWITCH_ROUTE_PREFIX}/logs`);
    expect(ROLEBOX_LOGS_ROUTE_PREFIX).not.toBe(ROLE_SWITCH_ROUTE_PREFIX);
  });

  it("the returned disposer unregisters the route", () => {
    const route = makeRoute();
    const { webServer, registered } = createFakeWebServer();

    const dispose = route.register(webServer);
    expect(registered).toHaveLength(1);

    dispose();
    expect(registered).toHaveLength(0);
  });
});

// ── GET /rolebox/logs — the view answer ─────────────────────────────────────

describe("DshRoleboxLogsWebRoute GET /rolebox/logs", () => {
  it("answers 200 with exactly the five view keys", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const result = await get(makeRoute());

    expect(result.status).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(Number(result.headers["Content-Length"])).toBeGreaterThan(0);
    expect(Object.keys(json(result)).sort()).toEqual([
      "cursor",
      "records",
      "skippedLines",
      "source",
      "truncated",
    ]);
  });

  it("reports the source it actually read (an explicit directory)", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const view = await getView(makeRoute());

    expect(view.source).toEqual({ kind: "dir", path: fixtureDir });
    expect(view.records).toHaveLength(6);
    expect(view.skippedLines).toBe(0);
    expect(view.truncated).toBe(false);
  });

  it("reads the channel file's records back in the reader's order", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const view = await getView(makeRoute());

    expect(view.records.map((r) => r.time)).toEqual([
      T0,
      T0 + 1_000,
      T0 + 2_000,
      T0 + 3_000,
      T0 + 4_000,
      T0 + 5_000,
    ]);
    // Wire fidelity: the kernel record shape survives the trip.
    expect(view.records[2]).toMatchObject({
      time: T0 + 2_000,
      level: "warn",
      channel: "graph:host",
      code: "sweep.store-blocked",
      message: "Store blocked by lock",
      fields: { reason: "lock" },
      scope: { graphId: "g1", sessionId: "s1" },
    });
  });

  it("returns a cursor that continues where the answer stopped", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS.slice(0, 3));
    const route = makeRoute();
    const first = await getView(route, "?limit=2");

    // The first paint is the NEWEST window (group-complete), so the oldest
    // record is reported as truncated history behind it.
    expect(first.records.map((r) => r.time)).toEqual([T0 + 1_000, T0 + 2_000]);
    expect(first.truncated).toBe(true);
    expect(typeof first.cursor).toBe("string");
    expect(first.cursor.length).toBeGreaterThan(0);

    // Nothing new yet: the poll is empty and the cursor does NOT move.
    const idle = await getView(route, `?limit=2&cursor=${encodeURIComponent(first.cursor)}`);
    expect(idle.records).toEqual([]);
    expect(idle.cursor).toBe(first.cursor);

    // Append two records after the watermark and poll: exactly those two.
    appendLines(fixtureDir, "graph-host", [
      recordLine({ time: T0 + 10_000, level: "warn", message: "late one" }),
      recordLine({ time: T0 + 11_000, level: "error", message: "late two" }),
    ]);
    const next = await getView(route, `?limit=2&cursor=${encodeURIComponent(first.cursor)}`);
    expect(next.records.map((r) => r.message)).toEqual(["late one", "late two"]);
    expect(next.truncated).toBe(false);
    expect(next.cursor).not.toBe(first.cursor);
  });

  it("spells the cursor exactly as the live-view docs' example does", async () => {
    // docs/logging.md prints its example cursor beside a record stamped
    // 1791450000000, and that example is THIS build's spelling — a reader who
    // copies it lands on that record instead of in 1970 (review#3 R3: the docs
    // used to show a spelling no answer ever produced).
    expect(T0).toBe(1_791_450_000_000);
    appendLines(fixtureDir, "graph-host", [
      recordLine({
        time: T0,
        level: "warn",
        channel: "graph:host",
        code: "sweep.store-blocked",
        message: "Store blocked by lock",
        fields: { reason: "lock" },
        scope: { graphId: "g1" },
      }),
    ]);

    const view = await getView(makeRoute(), "?limit=10");
    expect(view.records.map((r) => r.time)).toEqual([T0]);

    // The assertion reads the DOC, not a copy of it: the example printed in the
    // live-view section must be the spelling this build answers with, so editing
    // the docs to something no answer produces fails here (review#3 R3).
    const docs = readFileSync(resolve(import.meta.dir, "../../docs/logging.md"), "utf8");
    const section = docs.slice(docs.indexOf("### The route: `GET /rolebox/logs`"));
    const documented = /"cursor":\s*"([^"]+)"/.exec(section)?.[1] ?? "";
    expect(documented).not.toBe("");
    expect(view.cursor).toBe(documented);

    // And it is a real watermark: handed back (URL-escaped, as the panel sends
    // it) it continues rather than restarting.
    const roundTrip = await getView(
      makeRoute(),
      `?cursor=${encodeURIComponent(view.cursor)}`,
    );
    expect(roundTrip.records).toEqual([]);
    expect(roundTrip.cursor).toBe(view.cursor);
  });

  it("treats an unreadable cursor as absent instead of failing", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const result = await get(makeRoute(), "?cursor=not-a-cursor");
    const view = json<RoleboxLogsViewBody>(result);

    expect(result.status).toBe(200);
    expect(view.records).toHaveLength(6);
    expect(view.cursor).not.toBe("not-a-cursor");
  });

  it("caps the answer at ?limit and reports truncation", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const view = await getView(makeRoute(), "?limit=2");

    expect(view.records).toHaveLength(2);
    expect(view.records.map((r) => r.time)).toEqual([T0 + 4_000, T0 + 5_000]);
    expect(view.truncated).toBe(true);
  });

  it("answers limit=0 with no records, never with a default window", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const view = await getView(makeRoute(), "?limit=0");

    expect(view.records).toEqual([]);
    expect(view.truncated).toBe(true);
  });

  it("serves the prefix with and without the trailing slash", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const withSlash = await invoke(
      (req, res) => makeRoute().handle(req, res),
      "GET",
      ROLEBOX_LOGS_ROUTE_PREFIX + "/",
    );
    expect(withSlash.status).toBe(200);
    expect(json<RoleboxLogsViewBody>(withSlash).records).toHaveLength(6);
  });

  it("exposes the documented default window", () => {
    expect(DEFAULT_LOGS_ROUTE_LIMIT).toBe(1000);
  });

  it("exposes exactly the documented parameter list", () => {
    expect([...LOGS_ROUTE_PARAMS]).toEqual([
      "cursor",
      "limit",
      "level",
      "channel",
      "code",
      "graph",
      "session",
      "text",
    ]);
  });
});

// ── Filters ─────────────────────────────────────────────────────────────────

describe("DshRoleboxLogsWebRoute filters", () => {
  beforeEach(() => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
  });

  it("level is a MINIMUM (warn keeps warn, error and fatal)", async () => {
    const view = await getView(makeRoute(), "?level=warn");
    expect(view.records.map((r) => r.level)).toEqual(["warn", "error", "warn", "fatal"]);
  });

  it("level is case-insensitive and rejects a level the kernel does not know", async () => {
    const ok = await getView(makeRoute(), "?level=WARN");
    expect(ok.records).toHaveLength(4);

    const bad = await get(makeRoute(), "?level=verbose");
    expect(bad.status).toBe(400);
    expect(json<{ error: string }>(bad).error).toContain("level must be one of");
  });

  it("channel filters on the record's exact channel, comma list and repetition alike", async () => {
    const one = await getView(makeRoute(), "?channel=web-ui");
    expect(one.records.map((r) => r.message)).toEqual(["panel mounted", "Slow poll"]);

    const comma = await getView(makeRoute(), "?channel=web-ui,dispatch");
    expect(comma.records).toHaveLength(3);

    const repeated = await getView(makeRoute(), "?channel=web-ui&channel=dispatch");
    expect(repeated.records).toHaveLength(3);
  });

  it("code filters on the event code; a record without one never matches", async () => {
    const view = await getView(makeRoute(), "?code=graph.advance");
    expect(view.records.map((r) => r.code)).toEqual(["graph.advance"]);

    const none = await getView(makeRoute(), "?code=sweep.store-blocked");
    expect(none.records).toHaveLength(1);
    expect(none.records[0]!.message).toBe("Store blocked by lock");
  });

  it("graph and session filter on the record's scope", async () => {
    const graph = await getView(makeRoute(), "?graph=g1");
    expect(graph.records.map((r) => r.time)).toEqual([T0 + 1_000, T0 + 2_000, T0 + 5_000]);

    const session = await getView(makeRoute(), "?session=s2");
    expect(session.records.map((r) => r.time)).toEqual([T0 + 3_000, T0 + 4_000]);
  });

  it("text is a case-insensitive substring over message, channel, code and fields", async () => {
    const message = await getView(makeRoute(), "?text=blocked");
    expect(message.records.map((r) => r.code)).toEqual(["sweep.store-blocked"]);

    const channel = await getView(makeRoute(), "?text=WEB-UI");
    expect(channel.records).toHaveLength(2);

    const field = await getView(makeRoute(), "?text=a2");
    expect(field.records.map((r) => r.message)).toEqual(["Dispatch failed"]);
  });

  it("combines every filter with AND", async () => {
    const view = await getView(makeRoute(), "?level=warn&channel=graph:host&graph=g1&text=store");
    expect(view.records.map((r) => r.time)).toEqual([T0 + 2_000]);
  });

  it("filters do not change the reported source", async () => {
    const view = await getView(makeRoute(), "?channel=web-ui&text=nomatch-anywhere");
    expect(view.records).toEqual([]);
    expect(view.source).toEqual({ kind: "dir", path: fixtureDir });
  });
});

// ── Empty, missing and malformed sources ────────────────────────────────────

describe("DshRoleboxLogsWebRoute source edges", () => {
  it("answers 200 with an empty set for an empty directory", async () => {
    const view = await getView(makeRoute());
    expect(view.records).toEqual([]);
    expect(view.truncated).toBe(false);
    expect(view.skippedLines).toBe(0);
    expect(view.source).toEqual({ kind: "dir", path: fixtureDir });
    // The cursor is still usable, so a viewer can keep polling the empty source.
    expect(typeof view.cursor).toBe("string");
  });

  it("answers 200 with an empty set for a directory that does not exist", async () => {
    const missing = join(tmpdir(), "dsh-logs-route-missing-" + process.pid + "-" + Date.now());
    const route = new DshRoleboxLogsWebRoute({ logDir: missing });
    const view = await getView(route);

    expect(view.records).toEqual([]);
    expect(view.source).toEqual({ kind: "dir", path: missing });
  });

  it("counts malformed lines and keeps serving the readable ones", async () => {
    appendLines(fixtureDir, "graph-host", [
      SIX_RECORDS[1]!,
      "{not json at all\n",
      '{"foo":1}\n',
      "\n", // a blank line is structural, not malformed
      "[]\n", // JSON, but not a record
    ]);
    const view = await getView(makeRoute());

    expect(view.records).toHaveLength(1);
    expect(view.records[0]!.message).toBe("Graph g1 advanced");
    expect(view.skippedLines).toBe(3);
  });

  it("reads legacy single-file mode with source.kind 'file'", async () => {
    const file = join(fixtureDir, "rolebox.log");
    writeFileSync(file, SIX_RECORDS.join(""));
    const route = new DshRoleboxLogsWebRoute({ logFile: file });
    const view = await getView(route);

    expect(view.source).toEqual({ kind: "file", path: file });
    expect(view.records).toHaveLength(6);
  });

  it("uses the writer's chain when the route names no source", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS.slice(0, 2));
    const previous = process.env.ROLEBOX_LOG_DIR;
    const previousFile = process.env.ROLEBOX_LOG_FILE;
    delete process.env.ROLEBOX_LOG_FILE;
    process.env.ROLEBOX_LOG_DIR = fixtureDir;
    try {
      const view = await getView(new DshRoleboxLogsWebRoute());
      expect(view.source).toEqual({ kind: "dir", path: fixtureDir });
      expect(view.records).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.ROLEBOX_LOG_DIR;
      else process.env.ROLEBOX_LOG_DIR = previous;
      if (previousFile === undefined) delete process.env.ROLEBOX_LOG_FILE;
      else process.env.ROLEBOX_LOG_FILE = previousFile;
    }
  });
});

// ── Illegible parameters are 400, never 500 ─────────────────────────────────

describe("DshRoleboxLogsWebRoute parameter validation", () => {
  const bad: Array<[string, string]> = [
    ["?limit=abc", "limit must be a whole number"],
    ["?limit=-1", "limit must be a whole number"],
    ["?limit=1.5", "limit must be a whole number"],
    ["?limit=", "limit must be a whole number"],
    ["?level=verbose", "level must be one of debug, info, warn, error, fatal"],
    ["?level=", "level must be one of"],
    ["?channel=", "channel needs at least one value"],
    ["?channel=,", "channel needs at least one value"],
    ["?code=", "code needs at least one value"],
    ["?graph=", "graph needs a value"],
    ["?session=", "session needs a value"],
    ["?text=", "text needs a value"],
  ];

  for (const [query, expected] of bad) {
    it(`answers 400 with a readable message for ${query}`, async () => {
      appendLines(fixtureDir, "graph-host", SIX_RECORDS);
      const result = await get(makeRoute(), query);

      expect(result.status).toBe(400);
      const body = json<{ ok: boolean; error: string }>(result);
      expect(body.ok).toBe(false);
      expect(body.error).toContain(expected);
      // A rejected query is never answered with a view body.
      expect(Object.keys(body).sort()).toEqual(["error", "ok"]);
    });
  }

  it("rejects an illegible query BEFORE reading, so a typo cannot look empty", async () => {
    // The directory holds records; a 400 proves the read never ran.
    appendLines(fixtureDir, "graph-host", SIX_RECORDS);
    const result = await get(makeRoute(), "?limit=abc");
    expect(result.status).toBe(400);
    // The answer is the error body alone — no view keys, so no reader ran.
    expect(result.text).not.toContain("skippedLines");
    expect(result.text).not.toContain("truncated");
  });

  it("parseLogsRouteQuery is total: every result is either a query or an error", () => {
    const ok = parseLogsRouteQuery(new URLSearchParams("limit=5&level=warn&channel=a,b"));
    expect(ok).toEqual({
      ok: true,
      query: { limit: 5, minLevel: "warn", channels: ["a", "b"] },
    });

    const bad = parseLogsRouteQuery(new URLSearchParams("limit=x"));
    expect(bad.ok).toBe(false);

    // The source is the CALLER's, never the query string's.
    const sourced = parseLogsRouteQuery(
      new URLSearchParams("logDir=/tmp/elsewhere&limit=1"),
      { logDir: "/tmp/fixture" },
    );
    expect(sourced).toEqual({ ok: true, query: { logDir: "/tmp/fixture", limit: 1 } });
  });
});

// ── Routing: 404 / 405 / delegate, and no source from the request ───────────

describe("DshRoleboxLogsWebRoute routing", () => {
  it("answers 404 for an unknown sub-path", async () => {
    const result = await get(makeRoute(), "/files");
    expect(result.status).toBe(404);
    expect(json<{ ok: boolean; error: string }>(result)).toEqual({
      ok: false,
      error: "Not found",
    });
  });

  it("answers 404 for a path outside the prefix", async () => {
    const result = await invoke(
      (req, res) => makeRoute().handle(req, res),
      "GET",
      "/rolebox/status",
    );
    expect(result.status).toBe(404);
  });

  it("answers 405 for a known path with another method", async () => {
    const result = await invoke(
      (req, res) => makeRoute().handle(req, res),
      "POST",
      ROLEBOX_LOGS_ROUTE_PREFIX,
    );
    expect(result.status).toBe(405);
    expect(json<{ ok: boolean }>(result).ok).toBe(false);
  });

  it("falls through to the delegate for sub-paths it does not own", async () => {
    const seen: string[] = [];
    const route = new DshRoleboxLogsWebRoute({
      logDir: fixtureDir,
      delegate: (req, res) => {
        seen.push(req.url ?? "");
        (res as unknown as MockRes).writeHead(200, {});
        (res as unknown as MockRes).end("delegated");
      },
    });

    const result = await invoke((req, res) => route.handle(req, res), "GET", "/rolebox/logs/files");
    expect(seen).toEqual(["/rolebox/logs/files"]);
    expect(result.status).toBe(200);
    expect(result.text).toBe("delegated");
  });

  it("never rejects: a request whose URL cannot be parsed is a stable 500", async () => {
    const result = await invoke(
      (req, res) => makeRoute().handle(req, res),
      "GET",
      "http://[",
    );
    expect(result.status).toBe(500);
    expect(json<{ ok: boolean; error: string }>(result).ok).toBe(false);
  });
});

// ── The route adds no source of bytes ───────────────────────────────────────

describe("DshRoleboxLogsWebRoute exposure", () => {
  it("ignores source parameters in the request", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS.slice(0, 2));
    const result = await get(
      makeRoute(),
      "?logDir=/tmp/somewhere-else&logFile=/tmp/elsewhere.log&files=/tmp/x.log",
    );
    const view = json<RoleboxLogsViewBody>(result);

    expect(result.status).toBe(200);
    expect(view.source).toEqual({ kind: "dir", path: fixtureDir });
    expect(view.records).toHaveLength(2);
    expect(result.text).not.toContain("somewhere-else");
    expect(result.text).not.toContain("elsewhere.log");
  });

  it("echoes nothing the request carried and no credential-shaped value", async () => {
    appendLines(fixtureDir, "graph-host", SIX_RECORDS.slice(0, 1));
    const result = await get(
      makeRoute(),
      "?credential=SECRET-TOKEN&token=SECRET-TOKEN&authorization=SECRET-TOKEN&nonsense=SECRET-TOKEN",
    );

    expect(result.status).toBe(200);
    expect(result.text).not.toContain("SECRET-TOKEN");
    // The answer is the view body alone: no request echo, no envelope.
    expect(Object.keys(json(result)).sort()).toEqual([
      "cursor",
      "records",
      "skippedLines",
      "source",
      "truncated",
    ]);
  });

  it("serves only records the kernel wrote (fields pass through unmodified)", async () => {
    appendLines(fixtureDir, "graph-host", [
      recordLine({
        time: T0,
        fields: { reason: "lock", count: 2, flags: ["a", "b"], ok: true },
      }),
    ]);
    const view = await getView(makeRoute());

    expect(view.records[0]!.fields).toEqual({
      reason: "lock",
      count: 2,
      flags: ["a", "b"],
      ok: true,
    });
  });
});
