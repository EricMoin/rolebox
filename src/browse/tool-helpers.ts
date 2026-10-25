/**
 * Shared plumbing for the `browse_*` tool family.
 *
 * Every tool in the family is written against the same four helpers:
 *
 * - the argument vocabulary (`page`, `timeout`, target, URL) so the schemas and
 *   their descriptions stay identical across 22 tools;
 * - {@link defineBrowseTool}, the one wrapper that parses arguments and turns
 *   any thrown value into the canonical `Error:` tool result — a browse tool
 *   never rejects;
 * - {@link runOnPage}, which resolves the session's manager, binds the call to
 *   one named page, races the operation against `context.abort` and fills the
 *   result context (`session`, `page`, `url`, `title`) on both paths;
 * - path and URL validation, so a screenshot cannot escape the worktree and a
 *   navigation target is an absolute URL with a scheme a browser can load.
 *
 * The manager is per worktree: `createBrowseTools()` without an injected
 * manager creates one `BrowseSessionManager` per worktree on first use, which
 * is what the process-wide tool surface needs. Tests inject a manager backed by
 * the fake driver port instead.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import type { CanonicalToolContext, ToolResult } from "../platform/types.ts";
import { browseErrorResult, type BrowseResultContext } from "./results.ts";
import type { BrowseSessionPage, BrowseSessionSettings } from "./session.ts";
import { BrowseSessionManager } from "./session.ts";
import { browseError, type BrowseError, type BrowseViewport } from "./types.ts";
import { checkedArtifactPath } from "./artifact-path.ts";

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Per-action time limit when a caller names none. */
export const BROWSE_ACTION_TIMEOUT_MS = 15_000;

/** Navigation and history time limit when a caller names none. */
export const BROWSE_NAVIGATION_TIMEOUT_MS = 30_000;

/** `browse_wait` time limit when a caller names none. */
export const BROWSE_WAIT_TIMEOUT_MS = 5_000;

/** Screenshot time limit when a caller names none. */
export const BROWSE_SCREENSHOT_TIMEOUT_MS = 30_000;

/** The ceiling every `timeout_ms` argument shares. */
export const BROWSE_MAX_TIMEOUT_MS = 120_000;

/** The viewport a new browser gets when `browse_open` names none. */
export const BROWSE_DEFAULT_VIEWPORT: BrowseViewport = { width: 1440, height: 900 };

/** How many console or network entries one read returns when it names no limit. */
export const BROWSE_READ_LIMIT_DEFAULT = 100;

/** The largest number of buffered entries one read may return. */
export const BROWSE_READ_LIMIT_MAX = 1_000;

/** The wheel step `browse_scroll` uses when it names no delta. */
export const BROWSE_SCROLL_STEP = 600;

/** The URL schemes a browse navigation may load. */
const NAVIGATION_SCHEMES = ["http:", "https:", "file:", "about:", "data:"] as const;

// ── Argument vocabulary ──────────────────────────────────────────────────────

/** The named-page argument every page-bound tool shares. */
export const BROWSE_PAGE_ARG = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe("Named page to act on (default: the session's active page, initially main)");

/** An element target in the snapshot grammar. */
export const BROWSE_TARGET_ARG = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe(
    "Element target: a ref from the latest browse_snapshot (e12 or @e12), css=<selector>, text=<text>, "
      + 'role=<role>[name="<name>"], label=<text>, placeholder=<text>, alt=<text>, title=<text> or testid=<id>',
  );

/** A per-tool `timeout_ms` argument carrying this tool's default in its description. */
export function timeoutArg(defaultMs: number, maximumMs: number = BROWSE_MAX_TIMEOUT_MS) {
  return z
    .number()
    .int()
    .min(1)
    .max(maximumMs)
    .optional()
    .describe(`Time limit in milliseconds (default ${defaultMs}, maximum ${maximumMs})`);
}

// ── Runtime ──────────────────────────────────────────────────────────────────

/** Construction options for the tool family. */
export interface BrowseToolsOptions {
  /**
   * A manager to bind every tool to. When omitted, one manager per worktree is
   * created on first use, so a host with several worktrees never shares a
   * browser session across them.
   */
  manager?: BrowseSessionManager;
}

/** How a tool reaches a session manager. */
export interface BrowseRuntime {
  manager(worktree: string): BrowseSessionManager;
}

const managersByWorktree = new Map<string, BrowseSessionManager>();

/** Build the manager resolver one tool record shares. */
export function createBrowseRuntime(options: BrowseToolsOptions = {}): BrowseRuntime {
  const injected = options.manager;
  if (injected !== undefined) {
    return { manager: () => injected };
  }
  return {
    manager(worktree: string) {
      const key = worktree.trim() === "" ? process.cwd() : worktree;
      let manager = managersByWorktree.get(key);
      if (manager === undefined) {
        // Same viewport default as browse_open, so a session whose first call is
        // browse_tabs action=new gets the documented 1440x900 frame.
        manager = new BrowseSessionManager({ worktree: key, viewport: BROWSE_DEFAULT_VIEWPORT });
        managersByWorktree.set(key, manager);
      }
      return manager;
    },
  };
}

/** The session key a call uses: the host session id, or `default` when it is empty. */
export function browseSessionKey(context: CanonicalToolContext): string {
  const key = typeof context.sessionID === "string" ? context.sessionID.trim() : "";
  return key === "" ? "default" : key;
}

// ── Result context ───────────────────────────────────────────────────────────

/** The page facts a result reports. */
export interface BrowseResultState {
  page: string | null;
  url: string;
  title: string;
}

/** Build the `{action, session, page, url, title}` context results.ts renders. */
export function browseResultContext(
  action: string,
  session: string,
  state: Partial<BrowseResultState> = {},
): BrowseResultContext {
  return {
    action,
    session,
    page: state.page ?? "",
    url: state.url ?? "",
    title: state.title ?? "",
  };
}

// ── One call, one page ───────────────────────────────────────────────────────

/** Everything one tool call needs to reach its page. */
export interface BrowseCall {
  readonly action: string;
  readonly session: string;
  readonly page?: string;
  readonly manager: BrowseSessionManager;
  readonly settings: BrowseSessionSettings;
}

/** Bind one tool call to the worktree manager and the requested page. */
export function browseCall(input: {
  runtime: BrowseRuntime;
  action: string;
  context: CanonicalToolContext;
  page?: string;
  settings?: BrowseSessionSettings;
}): BrowseCall {
  const { runtime, action, context, page, settings } = input;
  return {
    action,
    session: browseSessionKey(context),
    ...(page === undefined ? {} : { page }),
    manager: runtime.manager(context.worktree),
    settings: { ...settings, signal: context.abort, ...(page === undefined ? {} : { page }) },
  };
}

/**
 * Run one operation on the call's page.
 *
 * The operation receives the page handle and a `resultContext(state)` builder: a
 * success calls it with the url/title the action returned, and a failure after
 * that point still reports the last known page, so an error names where it
 * happened. `context.abort` is raced against the queued operation; an aborted
 * turn returns `cancelled` without waiting for the page.
 */
export async function runOnPage(
  call: BrowseCall,
  context: CanonicalToolContext,
  operation: (
    page: BrowseSessionPage,
    resultContext: (state?: Partial<BrowseResultState>) => BrowseResultContext,
  ) => Promise<ToolResult>,
): Promise<ToolResult> {
  let state: BrowseResultState = { page: call.page ?? null, url: "", title: "" };
  let pageHandle: BrowseSessionPage | null = null;
  try {
    return await abortable(context.abort, call.manager.run(call.session, async page => {
      pageHandle = page;
      state = { page: page.name, url: page.url, title: "" };
      const resultContext = (extra: Partial<BrowseResultState> = {}): BrowseResultContext => {
        state = {
          page: extra.page ?? page.name,
          url: extra.url ?? page.url,
          title: extra.title ?? state.title,
        };
        return browseResultContext(call.action, call.session, state);
      };
      return operation(page, resultContext);
    }, call.settings));
  } catch (error) {
    return browseErrorResult(
      browseResultContext(call.action, call.session, {
        ...state,
        url: state.url === "" ? safePageUrl(pageHandle) : state.url,
      }),
      error,
    );
  }
}

function safePageUrl(page: BrowseSessionPage | null): string {
  if (page === null) return "";
  try {
    return page.url;
  } catch {
    return "";
  }
}

// ── Abort ────────────────────────────────────────────────────────────────────

/**
 * Race an operation against an abort signal.
 *
 * The tool returns immediately. The session queue also checks the signal before
 * starting work; an action already delivered to the browser cannot be undone.
 */
export async function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => undefined);
    throw browseError(
      "cancelled",
      "the browse call was cancelled before it ran",
      "Retry once the host turn is active again.",
    );
  }
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(browseError(
      "cancelled",
      "the browse call was cancelled by the host turn",
      "Retry once the host turn is active again.",
    ));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    operation.catch(() => undefined);
  }
}

// ── Tool wrapper ─────────────────────────────────────────────────────────────

/** The failure a malformed tool call gets, naming the arguments that failed. */
export function invalidArgumentsError(action: string, detail: string): BrowseError {
  return browseError(
    "invalid_arguments",
    `${action} received invalid arguments (${detail})`,
    "Correct the named arguments and call the tool again.",
  );
}

function invalidSchemaError(action: string, error: z.ZodError): BrowseError {
  const detail = error.issues
    .map(issue => `${issue.path.length === 0 ? "arguments" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return invalidArgumentsError(action, detail);
}

/** Resolve an optional timeout argument against its tool default. */
export function resolveTimeout(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

/**
 * Wrap one tool definition with the family's shared contract.
 *
 * Argument parsing happens here, so a model that passes the wrong shape gets
 * `invalid_arguments` instead of a thrown zod error; anything a definition
 * throws becomes the canonical one-sentence `Error:` result. The wrapper is the
 * backstop — page-bound tools additionally catch inside {@link runOnPage} to
 * name the page and URL in the failure metadata.
 */
export function defineBrowseTool<Args extends z.ZodRawShape>(
  action: string,
  definition: CanonicalToolDef<Args>,
): CanonicalToolDef<Args> {
  const schema = z.object(definition.args);
  return defineTool({
    ...definition,
    async execute(input, context) {
      const requestedPage = typeof input === "object" && input !== null
        && typeof (input as { page?: unknown }).page === "string"
        ? (input as { page: string }).page
        : undefined;
      const base = browseResultContext(action, browseSessionKey(context), {
        page: requestedPage ?? "",
      });
      try {
        const parsed = schema.safeParse(input ?? {});
        if (!parsed.success) return browseErrorResult(base, invalidSchemaError(action, parsed.error));
        // Refuse before a definition can launch a browser for a turn that is
        // already over. A mid-call abort is still caught by `abortable`.
        if (context.abort.aborted) {
          return browseErrorResult(base, browseError(
            "cancelled",
            `${action} was cancelled before it ran`,
            "Retry once the host turn is active again.",
          ));
        }
        return await definition.execute(parsed.data, context);
      } catch (error) {
        return browseErrorResult(base, error);
      }
    },
  });
}

// ── Validation and formatting ────────────────────────────────────────────────

/** Validate an absolute navigation URL and return it trimmed. */
export function validateNavigationUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw browseError(
      "invalid_arguments",
      `the URL "${trimmed}" is not absolute`,
      "Pass an absolute URL such as https://example.com/page.",
    );
  }
  if (!(NAVIGATION_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw browseError(
      "invalid_arguments",
      `the URL "${trimmed}" uses the ${parsed.protocol} scheme`,
      "Use an http, https, file, about or data URL.",
    );
  }
  return trimmed;
}

/** Validate an http(s) URL, as cookie scoping requires. */
export function validateHttpUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw browseError(
      "invalid_arguments",
      `the URL "${trimmed}" is not absolute`,
      "Pass an absolute http or https URL such as https://example.com/.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw browseError(
      "invalid_arguments",
      `the URL "${trimmed}" is not http or https`,
      "Pass an absolute http or https URL such as https://example.com/.",
    );
  }
  return trimmed;
}

/**
 * Resolve a worktree-relative path, refusing one that escapes the worktree.
 *
 * Screenshot paths are relative by contract: an absolute path or a `..` escape
 * would let a page-driven tool write anywhere the process can write.
 */
export function resolveWorktreePath(worktree: string, path: string, hint: string): string {
  const trimmed = path.trim();
  if (trimmed === "") throw browseError("invalid_arguments", "the path is empty", hint);
  if (isAbsolute(trimmed)) {
    throw browseError(
      "invalid_arguments",
      `the path "${trimmed}" is absolute`,
      hint,
    );
  }
  const resolved = resolve(worktree, trimmed);
  const inside = relative(worktree, resolved);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw browseError(
      "invalid_arguments",
      `the path "${trimmed}" escapes the worktree`,
      hint,
    );
  }
  return checkedArtifactPath(worktree, resolved);
}

/**
 * Resolve an upload path: relative paths resolve against the worktree, and an
 * absolute path is used as given.
 */
export function resolveUploadPath(worktree: string, path: string, hint: string): string {
  const trimmed = path.trim();
  if (trimmed === "") throw browseError("invalid_arguments", "a file path is empty", hint);
  return isAbsolute(trimmed) ? trimmed : resolve(worktree, trimmed);
}

/** Collapse whitespace and clip a value for a one-line summary. */
export function oneLine(value: string, limit = 200): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}

/** Quote a value for prose output, keeping it on one line. */
export function quote(value: string, limit = 200): string {
  return JSON.stringify(oneLine(value, limit));
}
