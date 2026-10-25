/**
 * Interaction tools: `browse_click`, `browse_type`, `browse_press`,
 * `browse_select`, `browse_hover`, `browse_scroll`, `browse_upload`,
 * `browse_dialog` and `browse_cookies`.
 *
 * Every element tool takes the same target grammar and resolves it through the
 * core parser: a ref is validated against the page's current snapshot map (a
 * stale ref fails before Playwright is called), while text, role, label,
 * placeholder, alt, title and testid are strict Playwright locators, so two
 * matching elements are `ambiguous_target` rather than a silent first match.
 *
 * The tool layer adds argument-level guarantees the driver leaves open: a mouse
 * button, click count and modifier set on a click; a clear-or-append choice on
 * typing; an explicit exclusive choice between scrolling to an element and
 * wheeling; worktree-relative upload paths checked before the browser sees them;
 * one pending dialog at a time; and cookies scoped by url or by domain+path.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import { browseResult } from "./results.ts";
import { describeTarget, parseTarget } from "./target.ts";
import type { ActionResult, CookieInput, CookieRecord } from "./types.ts";
import { browseError } from "./types.ts";
import {
  BROWSE_ACTION_TIMEOUT_MS,
  BROWSE_PAGE_ARG,
  BROWSE_SCROLL_STEP,
  BROWSE_TARGET_ARG,
  browseCall,
  defineBrowseTool,
  invalidArgumentsError,
  oneLine,
  quote,
  resolveTimeout,
  resolveUploadPath,
  runOnPage,
  timeoutArg,
  validateHttpUrl,
  type BrowseRuntime,
} from "./tool-helpers.ts";

/** The mouse buttons a click may use. */
const CLICK_BUTTONS = ["left", "right", "middle"] as const;

/** The modifier keys a click may hold down. */
const MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;

/** The one-line gesture a click result reports. */
function describeClick(button: string, clickCount: number, modifiers: readonly string[]): string {
  const gesture = clickCount === 2 ? "double-click" : "click";
  const held = modifiers.length === 0 ? "" : ` holding ${modifiers.join("+")}`;
  return `${button} ${gesture}${held}`;
}

/** `browse_click` — click an element with a chosen button, count and modifiers. */
export function createBrowseClickTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_click", {
    description:
      "Click one element. target is a ref from the latest browse_snapshot (e12 or @e12), css=<selector>, text=<text>, " +
      'role=<role>[name="<name>"], label=<text>, placeholder=<text>, alt=<text>, title=<text> or testid=<id>. ' +
      "Refs are validated against the current snapshot and a stale ref is refused; a text or role target that matches several " +
      "elements is ambiguous_target, so snapshot and use a ref instead. " +
      "button defaults to left, click_count to 1, and modifiers is a subset of Alt, Control, Meta and Shift. " +
      "A successful click does not prove the page changed: call browse_snapshot afterwards when the next step depends on it.",
    args: {
      target: BROWSE_TARGET_ARG,
      page: BROWSE_PAGE_ARG,
      button: z.enum(CLICK_BUTTONS).optional().default("left").describe("Mouse button (default left)"),
      click_count: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .default(1)
        .describe("Click count: 1 for a click, 2 for a double-click (default 1)"),
      modifiers: z
        .array(z.enum(MODIFIERS))
        .max(4)
        .optional()
        .describe("Modifier keys held during the click, a subset of Alt, Control, Meta and Shift"),
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
      force: z.boolean().optional().describe("Skip actionability checks and click even if another element covers the target"),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = parseTarget(args.target);
      const modifiers = args.modifiers ?? [];
      const call = browseCall({ runtime, action: "browse_click", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const result = await page.click(plan, {
          timeoutMs,
          force: args.force === true,
          button: args.button,
          clickCount: args.click_count,
          modifiers,
        });
        const where = result.url === "" ? "" : `; the page is at ${result.url}`;
        return browseResult({
          title: `Clicked ${describeTarget(plan)}`,
          output: `Clicked ${describeTarget(plan)} with a ${describeClick(args.button, args.click_count, modifiers)}${where}. Call browse_snapshot if the click changed the page.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: {
            target: result.target,
            ref: plan.kind === "ref" ? plan.ref : null,
            button: args.button,
            click_count: args.click_count,
            modifiers,
            force: args.force === true,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}

/** `browse_type` — clear or append text in an element, optionally submitting. */
export function createBrowseTypeTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_type", {
    description:
      "Type text into an input, textarea or contenteditable element. " +
      "clear defaults to true and replaces the field's content; clear=false appends to it. " +
      "submit presses Enter on the same element afterwards. " +
      "The text is never echoed in the result, so a password typed here stays out of the transcript. " +
      "Use browse_click first when a field must be focused before typing.",
    args: {
      target: BROWSE_TARGET_ARG,
      text: z.string().max(20_000).describe("Text to enter; an empty string clears the field when clear is true"),
      page: BROWSE_PAGE_ARG,
      clear: z.boolean().optional().default(true).describe("Replace the field's content instead of appending (default true)"),
      submit: z.boolean().optional().default(false).describe("Press Enter on the element after typing (default false)"),
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = parseTarget(args.target);
      const options = { timeoutMs };
      const call = browseCall({ runtime, action: "browse_type", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        let result: ActionResult = args.clear
          ? await page.fill(plan, args.text, options)
          : await page.type(plan, args.text, options);
        if (args.submit) result = await page.press("Enter", plan, options);
        const action = `${args.clear ? "Typed" : "Appended"} ${args.text.length} character(s) into ${describeTarget(plan)}`;
        const submitted = args.submit ? " and pressed Enter" : "";
        return browseResult({
          title: `Typed into ${describeTarget(plan)}`,
          output: `${action}${submitted}; the page is at ${result.url}.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: {
            target: result.target,
            characters: args.text.length,
            cleared: args.clear,
            submitted: args.submit,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}

/** `browse_press` — press one key, optionally on a named element. */
export function createBrowsePressTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_press", {
    description:
      "Press one key, for example Enter, Tab, Escape, ArrowDown or Control+A. " +
      "With a target the key is pressed on that element (which focuses it); without one it goes to the focused element. " +
      "Use it for keyboard shortcuts and for submitting a form after browse_type.",
    args: {
      key: z.string().trim().min(1).max(100).describe("Key or key combination to press, for example Enter or Control+A"),
      target: BROWSE_TARGET_ARG.optional().describe("Optional element to press the key on; default is the focused element"),
      page: BROWSE_PAGE_ARG,
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = args.target === undefined ? undefined : parseTarget(args.target);
      const call = browseCall({ runtime, action: "browse_press", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const result = await page.press(args.key, plan, { timeoutMs });
        const where = plan === undefined ? "" : ` on ${describeTarget(plan)}`;
        return browseResult({
          title: `Pressed ${oneLine(args.key, 40)}`,
          output: `Pressed ${quote(args.key)}${where}; the page is at ${result.url}.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: {
            key: args.key,
            target: result.target,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}

/** `browse_select` — choose one or more options in a select element. */
export function createBrowseSelectTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_select", {
    description:
      "Select options in a <select> element by their value or label. " +
      "values must be a non-empty list of option values; for a multi-select pass every option that should be selected. " +
      "Use browse_snapshot to find the select element's ref first.",
    args: {
      target: BROWSE_TARGET_ARG,
      values: z
        .array(z.string().max(1_000))
        .min(1)
        .max(50)
        .describe("Non-empty list of option values (or labels for a label-based select)"),
      page: BROWSE_PAGE_ARG,
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = parseTarget(args.target);
      const call = browseCall({ runtime, action: "browse_select", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const result = await page.select(plan, args.values, { timeoutMs });
        const selected = result.values ?? args.values;
        return browseResult({
          title: `Selected ${describeTarget(plan)}`,
          output: `Selected ${selected.length} option(s) on ${describeTarget(plan)}: ${selected.map(value => quote(value, 80)).join(", ")}.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: {
            target: result.target,
            values: selected,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}

/** `browse_hover` — move the pointer over an element. */
export function createBrowseHoverTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_hover", {
    description:
      "Move the pointer over an element, which reveals hover menus and tooltips. " +
      "Take the target from the latest browse_snapshot; a hover that opened a menu usually needs a second snapshot to see its items.",
    args: {
      target: BROWSE_TARGET_ARG,
      page: BROWSE_PAGE_ARG,
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = parseTarget(args.target);
      const call = browseCall({ runtime, action: "browse_hover", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const result = await page.hover(plan, { timeoutMs });
        return browseResult({
          title: `Hovered ${describeTarget(plan)}`,
          output: `Hovered ${describeTarget(plan)}; the page is at ${result.url}. Call browse_snapshot if the hover revealed new elements.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: { target: result.target, timeout_ms: timeoutMs },
        });
      });
    },
  });
}

/** `browse_scroll` — scroll an element into view or wheel the page. */
export function createBrowseScrollTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_scroll", {
    description:
      "Scroll either to an element or by a wheel delta, never both. " +
      "With target, the element is scrolled into view. Without a target, the page is wheeled by delta_x (default 0) and delta_y (default 600); " +
      "use a negative delta to scroll up. Pass exactly one of target or a non-zero delta pair, and re-snapshot after scrolling if new content appeared.",
    args: {
      page: BROWSE_PAGE_ARG,
      target: BROWSE_TARGET_ARG.optional().describe("Element to scroll into view; excludes delta_x and delta_y"),
      delta_x: z.number().int().min(-100_000).max(100_000).optional().describe("Horizontal wheel delta in CSS pixels (default 0)"),
      delta_y: z.number().int().min(-100_000).max(100_000).optional().describe(`Vertical wheel delta in CSS pixels (default ${BROWSE_SCROLL_STEP})`),
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS);
      const plan = args.target === undefined ? undefined : parseTarget(args.target);
      if (plan !== undefined && (args.delta_x !== undefined || args.delta_y !== undefined)) {
        throw invalidArgumentsError("browse_scroll", "delta_x and delta_y apply only when no target is given");
      }
      const deltaX = plan === undefined ? args.delta_x ?? 0 : 0;
      const deltaY = plan === undefined ? args.delta_y ?? BROWSE_SCROLL_STEP : 0;
      if (plan === undefined && deltaX === 0 && deltaY === 0) {
        throw invalidArgumentsError("browse_scroll", "delta_x and delta_y are both 0, so nothing would scroll");
      }
      const call = browseCall({ runtime, action: "browse_scroll", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        if (plan !== undefined) {
          await page.scroll({ target: plan, timeoutMs });
          return browseResult({
            title: `Scrolled to ${describeTarget(plan)}`,
            output: `Scrolled ${describeTarget(plan)} into view; the page is at ${page.url}.`,
            context: resultContext({ url: page.url }),
            metadata: { target: describeTarget(plan), delta_x: 0, delta_y: 0, timeout_ms: timeoutMs },
          });
        }
        await page.scroll({ deltaX, deltaY, timeoutMs });
        return browseResult({
          title: "Scrolled the page",
          output: `Scrolled the page by dx=${deltaX}, dy=${deltaY}; it is now at ${page.url}.`,
          context: resultContext({ url: page.url }),
          metadata: { target: null, delta_x: deltaX, delta_y: deltaY, timeout_ms: timeoutMs },
        });
      });
    },
  });
}

/** Refuse a path that is not an existing regular file, before the browser sees it. */
function assertUploadFile(file: string): void {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    throw browseError(
      "file_not_found",
      `the upload file "${file}" does not exist`,
      "Pass a path to a file that exists, or create it first.",
    );
  }
  if (!stats.isFile()) {
    throw browseError(
      "file_not_found",
      `the upload path "${file}" is not a regular file`,
      "Pass a path to a file, not to a directory.",
    );
  }
}

/** `browse_upload` — attach files to a file input. */
export function createBrowseUploadTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_upload", {
    description:
      "Attach files to an <input type=file> element. " +
      "Relative paths resolve against the worktree and absolute paths are used as given; every path must name an existing regular file, " +
      "otherwise the call fails with file_not_found before the browser is touched. " +
      "Take the input's target from the latest browse_snapshot.",
    args: {
      target: BROWSE_TARGET_ARG,
      paths: z
        .array(z.string().trim().min(1).max(2_000))
        .min(1)
        .max(20)
        .describe("Non-empty list of worktree-relative or absolute file paths"),
      page: BROWSE_PAGE_ARG,
    },
    async execute(args, context) {
      const plan = parseTarget(args.target);
      const files = args.paths.map(path => resolveUploadPath(
        context.worktree,
        path,
        "Pass a path to a file inside the worktree or an absolute path to an existing file.",
      ));
      for (const file of files) assertUploadFile(file);
      const call = browseCall({ runtime, action: "browse_upload", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const result = await page.upload(plan, files, { timeoutMs: BROWSE_ACTION_TIMEOUT_MS });
        return browseResult({
          title: `Uploaded ${files.length} file(s)`,
          output: `Uploaded ${files.length} file(s) to ${describeTarget(plan)}: ${files.map(file => basename(file)).join(", ")}.`,
          context: resultContext({ url: result.url, title: result.title }),
          metadata: {
            target: result.target,
            count: files.length,
            files: files.map(file => basename(file)),
            paths: files,
          },
        });
      });
    },
  });
}

/** `browse_dialog` — accept or dismiss the one pending dialog. */
export function createBrowseDialogTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_dialog", {
    description:
      "Accept or dismiss the dialog currently blocking the page. " +
      "action=accept presses OK and may answer a prompt with prompt_text; action=dismiss presses Cancel. " +
      "A page has at most one pending dialog, and every other action on it refuses with dialog_open until it is handled. " +
      "When no dialog is open the call fails with dialog_missing; browse_status reports the pending dialog without blocking.",
    args: {
      action: z.enum(["accept", "dismiss"]).describe("accept (OK) or dismiss (Cancel) the pending dialog"),
      prompt_text: z.string().max(10_000).optional().describe("Text to answer a prompt with; only valid with action=accept"),
      page: BROWSE_PAGE_ARG,
    },
    async execute(args, context) {
      if (args.prompt_text !== undefined && args.action !== "accept") {
        throw invalidArgumentsError("browse_dialog", "prompt_text only applies to action=accept");
      }
      const call = browseCall({ runtime, action: "browse_dialog", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const pending = await page.dialog();
        if (pending === null) {
          throw browseError(
            "dialog_missing",
            `no dialog is open on page "${page.name}"`,
            "Call browse_status to inspect the page; an earlier browse_dialog call may already have handled it.",
          );
        }
        if (args.action === "accept") await page.acceptDialog(args.prompt_text);
        else await page.dismissDialog();
        const answer = args.prompt_text === undefined ? "" : ` and answered ${quote(args.prompt_text, 200)}`;
        return browseResult({
          title: `Dialog: ${args.action}`,
          output: `${args.action === "accept" ? "Accepted" : "Dismissed"} ${pending.type} dialog ${quote(pending.message, 300)}${answer}. The page can continue; call browse_snapshot before the next action.`,
          context: resultContext({ url: page.url }),
          metadata: {
            dialog: pending,
            handled: args.action,
            prompt_text: args.prompt_text !== undefined,
          },
        });
      });
    },
  });
}

// ── browse_cookies ───────────────────────────────────────────────────────────

/** How a cookie value is printed: the value itself, clipped to 200 characters. */
function cookieValue(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
}

function renderCookie(cookie: CookieRecord): string {
  const flags = [
    cookie.secure ? "secure" : "",
    cookie.httpOnly ? "http_only" : "",
    cookie.sameSite === undefined ? "" : `same_site=${cookie.sameSite}`,
  ].filter(flag => flag !== "");
  const expires = cookie.expires <= 0 ? "session" : new Date(cookie.expires * 1_000).toISOString();
  return `${cookie.name}=${cookieValue(cookie.value)}; domain=${cookie.domain}; path=${cookie.path}; expires=${expires}${flags.length === 0 ? "" : `; ${flags.join("; ")}`}`;
}

/** The cookie-scope arguments, checked once per action. */
function cookieInput(args: {
  url?: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  http_only?: boolean;
  same_site?: "Strict" | "Lax" | "None";
  expires?: number;
}): CookieInput {
  if (args.name === undefined || args.value === undefined) {
    throw invalidArgumentsError("browse_cookies", "action=set requires name and value");
  }
  const flags = {
    ...(args.secure === undefined ? {} : { secure: args.secure }),
    ...(args.http_only === undefined ? {} : { httpOnly: args.http_only }),
    ...(args.same_site === undefined ? {} : { sameSite: args.same_site }),
    ...(args.expires === undefined ? {} : { expires: args.expires }),
  };
  if (args.url !== undefined) {
    if (args.domain !== undefined || args.path !== undefined) {
      throw invalidArgumentsError("browse_cookies", "pass either url or domain with path, not both");
    }
    return { name: args.name, value: args.value, url: validateHttpUrl(args.url), ...flags };
  }
  if (args.domain === undefined) {
    throw invalidArgumentsError("browse_cookies", "action=set requires url or domain with path");
  }
  if (args.path === undefined) {
    throw invalidArgumentsError("browse_cookies", "action=set with domain requires path");
  }
  return { name: args.name, value: args.value, domain: args.domain, path: args.path, ...flags };
}

/** The cookie action after its arguments have been checked once. */
type PreparedCookieAction =
  | { action: "get"; name?: string }
  | { action: "clear" }
  | { action: "set"; cookie: CookieInput };

/** Check one cookie action's arguments before any page is touched. */
function prepareCookieAction(args: {
  action: "get" | "set" | "clear";
  url?: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  http_only?: boolean;
  same_site?: "Strict" | "Lax" | "None";
  expires?: number;
}): PreparedCookieAction {
  if (args.action === "get") {
    const setOnly = [args.url, args.domain, args.path, args.secure, args.http_only, args.same_site, args.expires];
    if (setOnly.some(value => value !== undefined)) {
      throw invalidArgumentsError(
        "browse_cookies",
        "url, domain, path, secure, http_only, same_site and expires only apply to action=set",
      );
    }
    return { action: "get", ...(args.name === undefined ? {} : { name: args.name }) };
  }
  if (args.action === "clear") {
    if (args.name !== undefined || args.value !== undefined) {
      throw invalidArgumentsError("browse_cookies", "action=clear removes every cookie; name and value are not supported");
    }
    return { action: "clear" };
  }
  return { action: "set", cookie: cookieInput(args) };
}

/** `browse_cookies` — get, set or clear cookies through the browser context. */
export function createBrowseCookiesTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_cookies", {
    description:
      "Read, write or clear cookies in the session's browser context (cookies are shared by every page in it). " +
      "action=get lists cookies, optionally only the one named by name; action=set requires name and value plus either url or domain with path; " +
      "action=clear removes every cookie in the context. " +
      "same_site accepts Strict, Lax or None, expires is Unix seconds, and secure/http_only map to the cookie flags. " +
      "Use it to restore a login or to inspect what a site stored.",
    args: {
      action: z.enum(["get", "set", "clear"]).describe("get, set or clear cookies"),
      page: BROWSE_PAGE_ARG,
      url: z.string().trim().min(1).max(2_000).optional().describe("Absolute http(s) URL the cookie is scoped to, for action=set"),
      name: z.string().trim().min(1).max(200).optional().describe("Cookie name: required for set, optional filter for get"),
      value: z.string().max(4_000).optional().describe("Cookie value; required for action=set"),
      domain: z.string().trim().min(1).max(500).optional().describe("Cookie domain, used with path instead of url"),
      path: z.string().trim().min(1).max(500).optional().describe("Cookie path, required with domain"),
      secure: z.boolean().optional().describe("Send the cookie only over HTTPS"),
      http_only: z.boolean().optional().describe("Make the cookie inaccessible to page JavaScript"),
      same_site: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite policy"),
      expires: z.number().int().min(-1).optional().describe("Expiry in Unix seconds; -1 or omitted for a session cookie"),
    },
    async execute(args, context) {
      const prepared = prepareCookieAction(args);
      const call = browseCall({ runtime, action: "browse_cookies", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        if (prepared.action === "get") {
          const all = await page.cookies();
          const cookies = prepared.name === undefined ? all : all.filter(cookie => cookie.name === prepared.name);
          const sorted = [...cookies].sort((left, right) =>
            left.domain.localeCompare(right.domain) || left.name.localeCompare(right.name));
          const output = sorted.length === 0
            ? prepared.name === undefined
              ? "No cookies are set in this browser context."
              : `No cookie named ${quote(prepared.name)} is set in this browser context.`
            : sorted.map(renderCookie).join("\n");
          return browseResult({
            title: `Cookies: ${sorted.length}`,
            output,
            context: resultContext({ url: page.url }),
            metadata: {
              action_name: "get",
              count: sorted.length,
              names: sorted.map(cookie => cookie.name),
              cookies: sorted,
            },
          });
        }

        if (prepared.action === "clear") {
          const before = await page.cookies();
          await page.clearCookies();
          return browseResult({
            title: `Cookies cleared: ${before.length}`,
            output: `Cleared ${before.length} cookie(s) from the browser context.`,
            context: resultContext({ url: page.url }),
            metadata: { action_name: "clear", count: before.length },
          });
        }

        const cookie = prepared.cookie;
        await page.setCookies([cookie]);
        const scope = cookie.url === undefined
          ? `domain=${cookie.domain ?? ""} path=${cookie.path ?? ""}`
          : cookie.url;
        return browseResult({
          title: `Cookie set: ${cookie.name}`,
          output: `Set cookie ${quote(cookie.name)} for ${scope}; it is now visible to every page in this browser context.`,
          context: resultContext({ url: page.url }),
          metadata: {
            action_name: "set",
            count: 1,
            name: cookie.name,
            domain: cookie.domain ?? null,
            path: cookie.path ?? null,
            url: cookie.url ?? null,
            secure: cookie.secure === true,
            http_only: cookie.httpOnly === true,
            same_site: cookie.sameSite ?? null,
            expires: cookie.expires ?? null,
          },
        });
      });
    },
  });
}
