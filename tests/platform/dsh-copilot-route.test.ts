/**
 * DshCopilotSuggestWebRoute tests — the structural HTTP adapter for the
 * composer draft suggester.
 *
 * The route is composed into the plugin's single `/rolebox` prefix
 * registration, so these tests drive `handle` directly with mock req/res (no
 * `node:http` server) and separately assert the `owns` predicate the
 * composition point uses.
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  COPILOT_SUGGEST_MAX_BODY_BYTES,
  COPILOT_SUGGEST_ROUTE_PATH,
  DshCopilotSuggestWebRoute,
} from "../../src/platform/adapters/dsh/web-copilot-route.ts";
import type {
  CopilotSuggestOutcome,
  CopilotSuggester,
} from "../../src/platform/adapters/dsh/copilot-suggest.ts";

// ── Mock req/res (no node:http server is created) ───────────────────────────

/** Minimal IncomingMessage double: url/method + data/end/close listeners. */
class MockReq {
  url: string;
  method: string;
  complete = false;
  private listeners = new Map<string, Array<(chunk?: unknown) => void>>();

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

  off(event: string, cb: (chunk?: unknown) => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== cb),
    );
    return this;
  }

  /** Emit a body chunk to registered `data` listeners. */
  push(chunk: string | Buffer): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const cb of this.listeners.get("data") ?? []) cb(buf);
  }

  /** Emit `end` as a normally completed request. */
  finish(): void {
    this.complete = true;
    for (const cb of this.listeners.get("end") ?? []) cb();
  }

  /** Emit `close` as a client that went away mid-request. */
  disconnect(): void {
    this.complete = false;
    for (const cb of this.listeners.get("close") ?? []) cb();
  }
}

/** Minimal ServerResponse double: records status/headers/body. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  private listeners = new Map<string, Array<() => void>>();

  on(event: string, cb: () => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  off(event: string, cb: () => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== cb),
    );
    return this;
  }

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(text = "") {
    this.body = text;
    this.writableEnded = true;
    return this;
  }
}

/** Invoke one composed handler with a mock req/res and await completion. */
async function invokeHandler(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  if (body !== undefined) req.push(body);
  req.finish();
  await pending;
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

/** Invoke the route directly with a mock req/res and await completion. */
async function invoke(
  route: DshCopilotSuggestWebRoute,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return invokeHandler(
    (req, res) => route.handle(req, res),
    method,
    path,
    body,
  );
}

function json<T = unknown>(result: { text: string }): T {
  return JSON.parse(result.text) as T;
}

/** Suggester double returning one fixed outcome. */
function returning(outcome: CopilotSuggestOutcome): CopilotSuggester {
  return async () => outcome;
}

/** A route over a fixed success outcome. */
function makeRoute(
  outcome: CopilotSuggestOutcome = { status: "none", reason: "empty-draft" },
): DshCopilotSuggestWebRoute {
  return new DshCopilotSuggestWebRoute(returning(outcome));
}

// ── owns ────────────────────────────────────────────────────────────────────

describe("DshCopilotSuggestWebRoute — owns", () => {
  const route = makeRoute();

  it("owns the exact suggestion path for every method", () => {
    for (const method of ["POST", "GET", "PUT", "DELETE"]) {
      expect(
        route.owns(
          new MockReq(method, COPILOT_SUGGEST_ROUTE_PATH) as unknown as IncomingMessage,
        ),
      ).toBe(true);
    }
  });

  it("does not own other paths", () => {
    expect(
      route.owns(
        new MockReq("POST", "/rolebox/roles/switch") as unknown as IncomingMessage,
      ),
    ).toBe(false);
    expect(
      route.owns(
        new MockReq("POST", "/rolebox/copilot") as unknown as IncomingMessage,
      ),
    ).toBe(false);
    expect(
      route.owns(
        new MockReq("GET", "/rolebox/copilot/suggest/extra") as unknown as IncomingMessage,
      ),
    ).toBe(false);
  });
});

// ── Production composition ──────────────────────────────────────────────────

describe("DshCopilotSuggestWebRoute — composed /rolebox delegate", () => {
  /**
   * Compose exactly like entries/dsh.ts: the suggester answers its own path,
   * every other request falls through to the role-switch handler. Before the
   * `owns` fix a non-POST on the suggestion path fell through here and the
   * role-switch route answered 404 instead of the documented 405.
   */
  function compose(
    route: DshCopilotSuggestWebRoute,
    fallback: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>,
  ) {
    return (req: IncomingMessage, res: ServerResponse) =>
      route.owns(req) ? route.handle(req, res) : fallback(req, res);
  }

  /** Role-switch stand-in: records the fallthrough and answers its own 404. */
  function fallbackRecorder(): {
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      handler: (req, res) => {
        calls.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
      },
    };
  }

  it("answers 405 for a non-POST on the suggestion path through the delegate", async () => {
    const fallback = fallbackRecorder();
    const handler = compose(makeRoute(), fallback.handler);

    const res = await invokeHandler(
      handler,
      "GET",
      COPILOT_SUGGEST_ROUTE_PATH,
    );

    expect(res.status).toBe(405);
    expect(json<{ ok: false; error: string }>(res)).toEqual({
      ok: false,
      error: "Method not allowed",
    });
    expect(fallback.calls).toEqual([]);
  });

  it("still answers a POST on the suggestion path through the delegate", async () => {
    const fallback = fallbackRecorder();
    const handler = compose(
      makeRoute({ status: "none", reason: "empty-draft" }),
      fallback.handler,
    );

    const res = await invokeHandler(
      handler,
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "s1" }),
    );

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, status: "none" });
    expect(fallback.calls).toEqual([]);
  });

  it("falls through to the role-switch handler for every other path", async () => {
    const fallback = fallbackRecorder();
    const handler = compose(makeRoute(), fallback.handler);

    const res = await invokeHandler(handler, "GET", "/rolebox/roles");

    expect(res.status).toBe(404);
    expect(fallback.calls).toEqual(["GET /rolebox/roles"]);
  });
});

// ── Success shapes ──────────────────────────────────────────────────────────

describe("DshCopilotSuggestWebRoute — success", () => {
  it("returns 200 with the suggested draft, model and duration", async () => {
    const res = await invoke(
      makeRoute({
        status: "suggested",
        text: "Run the tests",
        model: "test-model",
        ms: 42,
      }),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "s1" }),
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({
      ok: true,
      status: "suggested",
      text: "Run the tests",
      model: "test-model",
      ms: 42,
    });
  });

  it("returns 200 status none without leaking the internal reason", async () => {
    const res = await invoke(
      makeRoute({ status: "none", reason: "timeout" }),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "s1" }),
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, status: "none" });
  });

  it("returns 200 status disabled with its stable reason", async () => {
    const res = await invoke(
      makeRoute({ status: "disabled", reason: "model-not-configured" }),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "s1" }),
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({
      ok: true,
      status: "disabled",
      reason: "model-not-configured",
    });
  });

  it("forwards the session id to the suggester", async () => {
    let seen: string | undefined;
    const route = new DshCopilotSuggestWebRoute(async (sessionId) => {
      seen = sessionId;
      return { status: "none", reason: "empty-draft" };
    });
    await invoke(
      route,
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "session-9" }),
    );
    expect(seen).toBe("session-9");
  });
});

// ── Error contract ──────────────────────────────────────────────────────────

describe("DshCopilotSuggestWebRoute — errors", () => {
  it("answers 400 for invalid JSON", async () => {
    const res = await invoke(
      makeRoute(),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      "{not json",
    );
    expect(res.status).toBe(400);
    expect(json<{ ok: false; error: string }>(res).ok).toBe(false);
  });

  it("answers 400 for a missing, non-string or empty session", async () => {
    for (const body of [
      "{}",
      JSON.stringify({ session: 42 }),
      JSON.stringify({ session: "" }),
      JSON.stringify({ session: "   " }),
    ]) {
      const res = await invoke(makeRoute(), "POST", COPILOT_SUGGEST_ROUTE_PATH, body);
      expect(res.status).toBe(400);
      expect(json<{ ok: false }>(res).ok).toBe(false);
    }
  });

  it("answers 404 for an unknown session", async () => {
    const res = await invoke(
      makeRoute({ status: "unknown-session" }),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "missing" }),
    );
    expect(res.status).toBe(404);
    expect(json<{ ok: false }>(res).ok).toBe(false);
  });

  it("answers 405 for the known path with the wrong method", async () => {
    const res = await invoke(makeRoute(), "GET", COPILOT_SUGGEST_ROUTE_PATH);
    expect(res.status).toBe(405);
    expect(json<{ ok: false; error: string }>(res).ok).toBe(false);
  });

  it("answers 404 for a path it does not own", async () => {
    const res = await invoke(
      makeRoute(),
      "POST",
      "/rolebox/roles/switch",
      JSON.stringify({ session: "s1" }),
    );
    expect(res.status).toBe(404);
  });

  it("answers 413 for an oversized body", async () => {
    const res = await invoke(
      makeRoute(),
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      "x".repeat(COPILOT_SUGGEST_MAX_BODY_BYTES + 1),
    );
    expect(res.status).toBe(413);
    expect(json<{ ok: false; error: string }>(res).ok).toBe(false);
  });

  it("answers 500 when the suggester throws", async () => {
    const route = new DshCopilotSuggestWebRoute(async () => {
      throw new Error("boom");
    });
    const res = await invoke(
      route,
      "POST",
      COPILOT_SUGGEST_ROUTE_PATH,
      JSON.stringify({ session: "s1" }),
    );
    expect(res.status).toBe(500);
    expect(json<{ ok: false }>(res).ok).toBe(false);
  });
});

// ── Client cancellation ─────────────────────────────────────────────────────

describe("DshCopilotSuggestWebRoute — cancellation", () => {
  it("aborts the in-flight suggestion when the client closes the request", async () => {
    let seenSignal: AbortSignal | undefined;
    const route = new DshCopilotSuggestWebRoute((sessionId, signal) => {
      seenSignal = signal;
      return new Promise<CopilotSuggestOutcome>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ status: "none", reason: "aborted" }),
          { once: true },
        );
      });
    });

    const req = new MockReq("POST", COPILOT_SUGGEST_ROUTE_PATH);
    const res = new MockRes();
    const pending = route.handle(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    req.push(JSON.stringify({ session: "s1" }));
    req.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seenSignal?.aborted).toBe(false);
    req.disconnect();
    expect(seenSignal?.aborted).toBe(true);
    await pending;

    expect(res.statusCode).toBe(200);
    expect(json({ text: res.body })).toEqual({ ok: true, status: "none" });
  });
});
