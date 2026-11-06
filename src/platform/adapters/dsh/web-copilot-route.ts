/**
 * DshCopilotSuggestWebRoute — structural HTTP adapter for the composer draft
 * suggester.
 *
 * This is NOT its own prefix registration. The dsh host webserver rejects a
 * duplicate `prefix /rolebox`, so the route is composed into the plugin's ONE
 * existing `/rolebox` registration and is only consulted when it
 * {@link DshCopilotSuggestWebRoute.owns the request}:
 *
 *   let handled = false;
 *   webServer.register({
 *     kind: "prefix", path: "/rolebox",
 *     handler: (req, res) => suggestRoute.owns(req)
 *       ? suggestRoute.handle(req, res)
 *       : roleSwitchRoute.handle(req, res),
 *   });
 *
 * REST contract:
 *
 *   - `POST /rolebox/copilot/suggest` — body `{ session: string }`.
 *       `200 { ok: true, status: "suggested", text, model, ms }`
 *       `200 { ok: true, status: "none" }`
 *       `200 { ok: true, status: "disabled", reason }`
 *       `400 { ok: false, error }` — malformed JSON / missing or empty session
 *       `404 { ok: false, error }` — unknown session (from the suggester)
 *       `405 { ok: false, error }` — known path, non-POST method
 *       `413 { ok: false, error }` — body over 8192 bytes
 *       `500 { ok: false, error }` — unexpected failure
 *
 * Operational notes:
 *   - The request body is capped at 8192 bytes and drained when oversized, so
 *     an oversized body is never buffered.
 *   - The in-flight suggestion is cancelled when the client goes away. A
 *     `req` `close` event fires for NORMAL completed requests too, so it only
 *     aborts when the request is incomplete; a `res` close before the response
 *     is finished aborts as well. Both drive one AbortController.
 *   - No branch writes after `res.writableEnded`.
 *
 * Not a `@deepseek-ai/*` consumer: the web-server surface is consumed
 * structurally and the module never value-imports a host package.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { CopilotSuggester } from "./copilot-suggest.ts";

/** Exact path owned by this route under the composed `/rolebox` prefix. */
export const COPILOT_SUGGEST_ROUTE_PATH = "/rolebox/copilot/suggest";

/** Fixed request-body cap for the suggestion route (8 KiB). */
export const COPILOT_SUGGEST_MAX_BODY_BYTES = 8192;

/** Stable error shape for every non-2xx JSON response. */
export interface CopilotSuggestErrorBody {
  ok: false;
  error: string;
}

/** Optional construction tuning. */
export interface DshCopilotSuggestRouteOptions {
  /** Request-body cap in bytes (default {@link COPILOT_SUGGEST_MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
  /** Sub-logger name override (default `"dsh-copilot-suggest-route"`). */
  loggerName?: string;
}

/**
 * Route adapter for the composer draft suggestion endpoint.
 *
 * The handler is exposed directly as {@link handle} (for the composed
 * `/rolebox` registration and for tests) and {@link owns} lets the composition
 * point choose it without a second prefix registration.
 */
export class DshCopilotSuggestWebRoute {
  private readonly suggest: CopilotSuggester;
  private readonly maxBodyBytes: number;
  private readonly _log;

  /**
   * @param suggest - The bound suggestion function (`createCopilotSuggester`).
   * @param options - Optional body cap / logger name.
   */
  constructor(
    suggest: CopilotSuggester,
    options: DshCopilotSuggestRouteOptions = {},
  ) {
    this.suggest = suggest;
    this.maxBodyBytes = options.maxBodyBytes ?? COPILOT_SUGGEST_MAX_BODY_BYTES;
    this._log = createSubLogger(
      options.loggerName ?? "dsh-copilot-suggest-route",
    );
  }

  /**
   * True for the exact suggestion path, whatever the method. Used by the
   * composed `/rolebox` handler; never throws.
   *
   * The method is deliberately NOT part of the predicate: a non-POST request
   * on this known path must reach {@link handle} so its `405` branch answers,
   * instead of falling through to the role-switch delegate (which would
   * answer `404` for an unknown sub-path).
   */
  owns(req: IncomingMessage): boolean {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      return url.pathname === COPILOT_SUGGEST_ROUTE_PATH;
    } catch {
      return false;
    }
  }

  /**
   * Answer one owned request (or a 404 for a path this route does not serve).
   * Never rejects: every branch is guarded into a stable JSON error.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (url.pathname !== COPILOT_SUGGEST_ROUTE_PATH) {
        return sendJson(res, 404, errorBody("Not found"));
      }
      if (method !== "POST") {
        return sendJson(res, 405, errorBody("Method not allowed"));
      }

      const body = await readBody(req, this.maxBodyBytes);
      if (body.aborted) return; // client is gone; nothing can be written
      if (body.tooLarge) {
        return sendJson(res, 413, errorBody("Request body too large"));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return sendJson(res, 400, errorBody("Invalid JSON body"));
      }
      if (
        !isRecord(parsed) ||
        typeof parsed.session !== "string" ||
        parsed.session.trim().length === 0
      ) {
        return sendJson(res, 400, errorBody("Missing or invalid 'session' field"));
      }

      const controller = new AbortController();
      const onRequestClose = (): void => {
        // `req` close ALSO fires after a normal, fully received request; only
        // an incomplete request means the client went away mid-request.
        if (!req.complete) controller.abort();
      };
      const onResponseClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("close", onRequestClose);
      if (typeof res.on === "function") res.on("close", onResponseClose);

      try {
        const result = await this.suggest(parsed.session, controller.signal);
        if (res.writableEnded) return;

        if (result.status === "unknown-session") {
          return sendJson(res, 404, errorBody("Unknown session"));
        }
        if (result.status === "disabled") {
          this._log.debug("Copilot draft suggestions disabled", {
            session: parsed.session,
            reason: result.reason,
          });
          return sendJson(res, 200, {
            ok: true,
            status: "disabled",
            reason: result.reason,
          });
        }
        if (result.status === "none") {
          this._log.debug("Copilot draft suggestion found nothing", {
            session: parsed.session,
            reason: result.reason,
          });
          return sendJson(res, 200, { ok: true, status: "none" });
        }
        return sendJson(res, 200, {
          ok: true,
          status: "suggested",
          text: result.text,
          model: result.model,
          ms: result.ms,
        });
      } finally {
        removeListener(req, "close", onRequestClose);
        if (typeof res.off === "function") res.off("close", onResponseClose);
      }
    } catch (err) {
      this._log.error("Copilot suggest route handler failed", {
        error: formatError(err),
      });
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      return sendJson(res, 500, errorBody("Internal server error"));
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** One body-read result; `aborted` means the client left before `end`. */
interface ReadBodyResult {
  text: string;
  tooLarge: boolean;
  aborted: boolean;
}

/**
 * Read the request body up to `maxBytes`. Oversized bodies are drained and
 * discarded (never buffered). A premature client close resolves as `aborted`
 * so the caller can stop without writing.
 */
function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({
        text: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
        tooLarge,
        aborted,
      });
    };

    req.on("data", (chunk: Buffer) => {
      if (settled || tooLarge) return; // keep draining, discard
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(false));
    req.on("error", () => settle(true));
    req.on("close", () => {
      if (!req.complete) settle(true);
    });
  });
}

/** Remove a listener when the emitter exposes the modern API. */
function removeListener(
  req: IncomingMessage,
  event: string,
  listener: () => void,
): void {
  if (typeof req.off === "function") {
    req.off(event, listener);
  } else if (typeof req.removeListener === "function") {
    req.removeListener(event, listener);
  }
}

/** Stable error body for every non-2xx response. */
function errorBody(message: string): CopilotSuggestErrorBody {
  return { ok: false, error: message };
}

/** Send a JSON response unless the response is already finished. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
