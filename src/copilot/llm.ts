/**
 * LLM-role verdict invocation for the copilot turn-end decision pipeline.
 *
 * This module is the LLM BRANCH of the decision pipeline (used when a
 * copilot rule has not already short-circuited the decision). It asks a
 * configured role for a { advance, replyText } verdict on whether to inject
 * a user message into an idle session, or hand control back to the human.
 *
 * The exchange happens on a FRESH CHILD SESSION (parentID = origin sid) —
 * the loop-worker precedent at src/loop/dispatch-adapter.ts:88-107. The
 * origin session's transcript is NEVER touched: `prompt`/`promptSync` are
 * only ever called on the child session id.
 *
 * Failure contract: returns null on ANY failure (unknown role, launch
 * failure, timeout, empty/non-text response, unparseable or type-invalid
 * JSON). Null means "skip this idle" — cheaper heuristic sources already
 * declined, and a failed LLM ask must never block the pipeline.
 *
 * No guardrail / pattern-enforcement logic lives here (user decision: the
 * role acts freely). No retry loops — a single attempt per idle.
 */

import type { ISessionClient } from "../platform/ports/session-client.ts";
import { withTimeout } from "../utils/timeout.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("copilot-llm");

// ── Types ──────────────────────────────────────────────────────────────

/** Dependencies for the verdict invocation. */
export interface VerdictDeps {
  /** Platform session client (OpenCode SDK, Pi process spawn, etc.). */
  client: ISessionClient;
  /**
   * Resolved subagent registry keyed by subagent id — the map built by
   * `buildSubagentLineage` (src/dispatch/factory.ts:78-113). The configured
   * `llm.role` must be a key of this map to be invocable.
   */
  resolvedSubagents: Map<string, { parentFullId: string }>;
  /** Working directory used when creating the fresh child session. */
  directory: string;
}

/** Parameters for a single verdict request. */
export interface VerdictRequestOptions {
  /** Origin session id — used ONLY as the child's parentID, never prompted. */
  sid: string;
  /** Configured `llm.role` id; must be a resolved subagent. */
  roleId: string;
  /** Assembled verdict-request prompt (src/copilot/prompt.ts). */
  prompt: string;
  /** Hard timeout in ms (`max_verdict_timeout_ms` from the copilot config). */
  timeoutMs: number;
}

/** A successfully parsed LLM verdict. */
export interface Verdict {
  /** true -> inject `replyText` into the origin session; false -> hand control back. */
  advance: boolean;
  /** User-message text to inject when `advance` is true. */
  replyText: string;
}

// ── Unknown-role warn-once guard ───────────────────────────────────────

/** Role ids already warned as unknown, so repeated idles don't spam logs. */
const warnedUnknownRoles = new Set<string>();

function warnUnknownRoleOnce(roleId: string): void {
  if (warnedUnknownRoles.has(roleId)) return;
  warnedUnknownRoles.add(roleId);
  log.warn(
    `Copilot llm.role "${roleId}" is not a resolved subagent; skipping LLM verdict`,
  );
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Ask the configured LLM role for a turn-end verdict.
 *
 * Flow:
 *   1. Resolve `roleId` against `resolvedSubagents` — unknown role warns
 *      once (per role id) and returns null.
 *   2. Create a FRESH child session (`client.create({ directory, agent,
 *      parentID: sid })`), then `client.promptSync(childSid, …)` with an
 *      AbortSignal that fires after `timeoutMs`. The agent is forwarded on
 *      promptSync because the OpenCode adapter does not carry `agent` on
 *      create (src/platform/adapters/opencode/session.ts:271-282).
 *   3. Parse the verdict from the LAST text part of the response: exactly
 *      one JSON object `{ "advance": boolean, "replyText": string }`,
 *      possibly wrapped in a fenced block or surrounding text.
 *   4. Returns `{ advance, replyText }` on success; null on ANY failure
 *      (timeout, launch failure, empty/non-text response, unparseable or
 *      type-invalid JSON). The child session is aborted best-effort in all
 *      cases.
 */
export async function requestVerdict(
  deps: VerdictDeps,
  opts: VerdictRequestOptions,
): Promise<Verdict | null> {
  const { sid, roleId, prompt, timeoutMs } = opts;

  // 1. Role resolution — must be a resolved subagent.
  if (!deps.resolvedSubagents.has(roleId)) {
    warnUnknownRoleOnce(roleId);
    return null;
  }

  let childSid: string | undefined;
  try {
    // 2a. Create a fresh child session (parentID = origin sid; origin itself
    // is never prompted — the verdict exchange lives on the child).
    const created = await withTimeout(
      deps.client.create({
        directory: deps.directory,
        agent: roleId,
        parentID: sid,
      }),
      timeoutMs,
      "copilot.verdict.create",
      log,
    );
    if (!created?.id) return null;
    childSid = created.id;

    // 2b. Prompt synchronously with an AbortSignal timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await withTimeout(
        deps.client.promptSync(childSid, {
          agent: roleId,
          parts: [{ type: "text", text: prompt }],
          signal: controller.signal,
        }),
        timeoutMs,
        "copilot.verdict.promptSync",
        log,
      );
      if (result === null) return null;

      // 3. Parse the verdict from the response's last text part.
      return parseVerdictResponse(result.parts);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Launch failure (create threw, e.g. transport error), abort-induced
    // rejection, or any unexpected error — all collapse to "skip this idle".
    return null;
  } finally {
    // Clean up the child session best-effort (codebase abort pattern,
    // src/dispatch/core/sync-executor.ts:129).
    if (childSid !== undefined) {
      void deps.client.abort(childSid).catch(() => {});
    }
  }
}

// ── Response parsing ───────────────────────────────────────────────────

/**
 * Parse a verdict from the response's LAST text part.
 * Returns null when there is no text part, the JSON is unparseable, or the
 * parsed object fails strict type validation.
 */
function parseVerdictResponse(
  parts: Array<{ type: string; text?: string }>,
): Verdict | null {
  const lastTextPart = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .pop();
  if (!lastTextPart || typeof lastTextPart.text !== "string") return null;

  const obj = extractFirstJsonObject(lastTextPart.text);
  if (obj === null) return null;

  // Strict type validation.
  if (typeof obj.advance !== "boolean") return null;
  if (typeof obj.replyText !== "string") return null;

  return { advance: obj.advance, replyText: obj.replyText };
}

/**
 * Extract the first well-formed JSON object from arbitrary text.
 *
 * Tolerates fenced blocks (```json … ```) and surrounding prose by scanning
 * for each `{`, matching its closing brace (string- and nesting-aware), and
 * attempting JSON.parse on the slice. Returns the first object that parses;
 * null when none does.
 */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Fall through to the next '{'.
          }
          break;
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}
