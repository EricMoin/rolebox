/**
 * The page snapshot: a compact, ARIA-shaped text tree with stable element refs.
 *
 * Browsing is ref-based, not coordinate-based, so this module is the foundation
 * of every element action: it walks the DOM in document order, prints one line
 * per meaningful node, and stamps `data-rolebox-ref="eN"` onto the actionable
 * elements it prints. A later `click(target="e12")` is then a plain attribute
 * lookup in the live page rather than a guess about pixels or selectors.
 *
 * {@link browseSnapshotWalker} is a single self-contained function because it is
 * serialized into the page by `page.evaluate`: it cannot close over anything in
 * this module, so its small primitives (whitespace collapse, clipping, the caps)
 * are written inline. The exported helpers below are the host-side half of the
 * same contract — the driver clamps the requested cap with them, the session
 * formats stale-ref hints with them, and {@link parseSnapshotRefs} can recover
 * refs from snapshot text when a caller only kept the string. Their unit tests
 * pin the formatting the page-side function mirrors.
 *
 * The walker is also a security boundary of sorts: password values are never
 * copied into the snapshot, and the only thing it writes to the page is the ref
 * attribute.
 */

import type { SnapshotRef, SnapshotResult } from "./types.ts";

/** Default character cap for snapshot text. */
export const SNAPSHOT_DEFAULT_MAX_CHARS = 20_000;

/** Hard ceiling for snapshot text, even when a caller asks for more. */
export const SNAPSHOT_MAX_CHARS = 100_000;

/** Maximum characters in an accessible name printed by the walker. */
export const SNAPSHOT_NAME_MAX_CHARS = 120;

/** The marker the walker appends when the cap cut the tree short. */
export const SNAPSHOT_TRUNCATION_PREFIX = "[... truncated:";

/** The options as they cross into the page: plain, resolved, JSON-safe. */
export interface SerializedSnapshotOptions {
  selector: string | null;
  maxChars: number;
  full: boolean;
  refOffset?: number;
}

/** What the page-side walker returns. */
export interface SnapshotPayload {
  text: string;
  nodeCount: number;
  refCount: number;
  truncated: boolean;
  truncatedNodes: number;
  refs: SnapshotRef[];
  /** Whether the scope selector matched anything (always true without one). */
  matched: boolean;
  /** `invalid_selector` when the scope selector is not valid CSS. */
  error?: "invalid_selector";
}

// ── Host-side contract helpers ───────────────────────────────────────────────

/** Clamp a requested snapshot cap into `[1, SNAPSHOT_MAX_CHARS]`. */
export function clampSnapshotMaxChars(value?: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SNAPSHOT_DEFAULT_MAX_CHARS;
  return Math.min(Math.max(Math.trunc(value), 1), SNAPSHOT_MAX_CHARS);
}

/** Collapse runs of whitespace and trim — the page-side walker's first rule. */
export function collapseSnapshotWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Collapse, then clip to `limit` characters (with an ellipsis when clipped). */
export function truncateSnapshotLabel(value: string, limit: number = SNAPSHOT_NAME_MAX_CHARS): string {
  const collapsed = collapseSnapshotWhitespace(value);
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}

/** The exact marker line the walker appends after a truncated walk. */
export function formatTruncationMarker(remaining: number): string {
  return `${SNAPSHOT_TRUNCATION_PREFIX} ${Math.max(0, Math.trunc(remaining))} more nodes]`;
}

/** Strip the quoting the walker applies inside names and attribute values. */
function unescapeSnapshotText(value: string): string {
  return value.replace(/\\(["\\])/g, "$1").replace(/\\n/g, " ");
}

/**
 * Recover the refs a snapshot text declares.
 *
 * The walker returns refs in its payload, so this is a fallback: a caller that
 * only kept the rendered text (a transcript, a cached tool result) can still
 * build a ref map. It understands exactly the line format the walker prints —
 * `- <role> "<name>" [ref=eN] ...` — and ignores every other line.
 */
export function parseSnapshotRefs(text: string): SnapshotRef[] {
  const linePattern = /^\s*- ([a-z][a-z0-9_-]*) "(.*)"(?: \[|$)/;
  const refPattern = /\[ref=(e\d+)\]/;
  const refs: SnapshotRef[] = [];
  for (const line of text.split("\n")) {
    const lineMatch = linePattern.exec(line);
    if (lineMatch === null) continue;
    const refMatch = refPattern.exec(line);
    if (refMatch === null) continue;
    refs.push({
      ref: refMatch[1],
      role: lineMatch[1],
      name: unescapeSnapshotText(lineMatch[2]),
    });
  }
  return refs;
}

/** Render one ref the way error hints and summaries refer to it. */
export function formatSnapshotRef(ref: SnapshotRef): string {
  return `ref ${ref.ref} (${ref.role} "${truncateSnapshotLabel(ref.name)}")`;
}

/** Build the JSON-safe options object the walker receives. */
export function serializeSnapshotOptions(options?: {
  selector?: string;
  maxChars?: number;
  full?: boolean;
}): SerializedSnapshotOptions {
  return {
    selector: options?.selector === undefined || options.selector.trim() === "" ? null : options.selector,
    maxChars: clampSnapshotMaxChars(options?.maxChars),
    full: options?.full === true,
  };
}

/** Whether a value is the payload shape the walker promises. */
export function isSnapshotPayload(value: unknown): value is SnapshotPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<SnapshotPayload>;
  return typeof payload.text === "string"
    && typeof payload.nodeCount === "number"
    && typeof payload.refCount === "number"
    && typeof payload.truncated === "boolean"
    && typeof payload.truncatedNodes === "number"
    && Array.isArray(payload.refs)
    && typeof payload.matched === "boolean";
}

/**
 * Cut snapshot text down to the model-facing {@link SnapshotResult}.
 *
 * The payload from the page is already capped; this only keeps the reported
 * shape honest (it never invents refs or claims a truncation the page did not
 * report).
 */
export function snapshotResultFromPayload(
  payload: SnapshotPayload,
  url: string,
  title: string,
): SnapshotResult {
  return {
    text: payload.text,
    nodeCount: payload.nodeCount,
    refCount: payload.refCount,
    truncated: payload.truncated,
    url,
    title,
  };
}

// ── The page-side walker ─────────────────────────────────────────────────────

/**
 * Walk the DOM into an ARIA-shaped ref tree.
 *
 * This function is serialized into the page by `page.evaluate`, so everything it
 * needs is nested inside it and it only touches browser globals. It:
 *
 * - skips `script`/`style`/`template`/`noscript`, `aria-hidden="true"`,
 *   `display:none`/`visibility:hidden` subtrees and `input[type=hidden]`;
 * - derives a role from an explicit `role` attribute or the implicit HTML
 *   mapping, and an accessible name from `aria-labelledby`, `aria-label`,
 *   `<label>`, `alt`, `placeholder`, `title`, then text content;
 * - prints `- <role> "<name>" [ref=eN] [attr...]`, indented two spaces per
 *   printed level (a container that prints no line takes no level), and, in full
 *   mode, `text "..."` leaves;
 * - assigns refs in DOM order to actionable elements only, after clearing the
 *   previous `data-rolebox-ref` markers;
 * - reports iframes as `- iframe "<src>"` without entering their documents;
 * - stops at `maxChars`, reports `[... truncated: N more nodes]`, and never cuts
 *   a printed line in half.
 */
export function browseSnapshotWalker(options?: SerializedSnapshotOptions): SnapshotPayload {
  // ── Self-contained helpers (the function is serialized into the page) ──
  const settings = options ?? { selector: null, maxChars: 20000, full: false };
  const maxChars = Math.max(1, Math.min(Math.trunc(settings.maxChars) || 20000, 100000));
  const full = settings.full === true;

  const collapse = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const clip = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`);
  const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  const asBooleanProperty = (element: Element, name: string): boolean => {
    const value = (element as unknown as Record<string, unknown>)[name];
    return value === true;
  };

  const refs: SnapshotRef[] = [];
  const lines: string[] = [];
  let budget = 0;
  let truncated = false;
  let nodeCount = 0;
  let truncatedNodes = 0;
  let refCounter = settings.refOffset ?? 0;

  const emptyResult = (matched: boolean, error?: "invalid_selector"): SnapshotPayload => ({
    text: "",
    nodeCount: 0,
    refCount: 0,
    truncated: false,
    truncatedNodes: 0,
    refs: [],
    matched,
    ...(error === undefined ? {} : { error }),
  });

  let root: Element | null = null;
  if (typeof settings.selector === "string" && settings.selector !== "") {
    try {
      root = document.querySelector(settings.selector);
    } catch {
      return emptyResult(false, "invalid_selector");
    }
    if (root === null) return emptyResult(false);
  } else {
    root = document.body ?? document.documentElement;
    if (root === null) return emptyResult(true);
  }

  // A snapshot owns the ref namespace: drop the markers a previous snapshot left
  // behind before assigning new ones, so an old ref cannot resolve to an element
  // the new snapshot never printed.
  const stale = document.querySelectorAll("[data-rolebox-ref]");
  for (let index = 0; index < stale.length; index += 1) stale[index].removeAttribute("data-rolebox-ref");

  const SKIP_TAGS: Record<string, boolean> = {
    script: true, style: true, template: true, noscript: true,
    head: true, meta: true, link: true, title: true, base: true,
  };
  const IMPLICIT_ROLES: Record<string, string> = {
    button: "button", textarea: "textbox", option: "option",
    main: "main", nav: "navigation", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", dialog: "dialog", fieldset: "group",
    ul: "list", ol: "list", li: "listitem", table: "table", tr: "row",
    th: "columnheader", td: "cell", summary: "button", details: "group", iframe: "iframe",
  };
  const INPUT_ROLES: Record<string, string> = {
    button: "button", submit: "button", reset: "button", image: "button", file: "button",
    color: "button", checkbox: "checkbox", radio: "radio", range: "slider",
    number: "spinbutton", search: "searchbox",
  };
  const ACTIONABLE_ROLES: Record<string, boolean> = {
    button: true, link: true, checkbox: true, radio: true, switch: true,
    textbox: true, searchbox: true, combobox: true, listbox: true,
    slider: true, spinbutton: true, tab: true, menuitem: true,
    menuitemcheckbox: true, menuitemradio: true, treeitem: true,
  };
  // Roles whose accessible name already is their content, so a full-mode text
  // leaf under them would only repeat the line above it.
  const NAME_FROM_CONTENT: Record<string, boolean> = {
    button: true, link: true, heading: true, option: true, cell: true,
    columnheader: true, rowheader: true, listitem: true, tab: true,
    menuitem: true, menuitemcheckbox: true, menuitemradio: true,
    treeitem: true, checkbox: true, radio: true, switch: true, tooltip: true, dialog: true,
  };

  const tagOf = (element: Element): string => element.tagName.toLowerCase();

  const explicitRole = (element: Element): string | null => {
    const attribute = element.getAttribute("role");
    if (attribute === null) return null;
    const first = collapse(attribute).toLowerCase().split(" ")[0];
    return first === "" ? null : first;
  };

  const roleOf = (element: Element): string | null => {
    const explicit = explicitRole(element);
    if (explicit !== null) return explicit;
    const tag = tagOf(element);
    if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      return INPUT_ROLES[type] ?? "textbox";
    }
    if (tag === "select") {
      const multiple = element.hasAttribute("multiple");
      const size = Number.parseInt(element.getAttribute("size") ?? "", 10);
      return multiple || (Number.isFinite(size) && size > 1) ? "listbox" : "combobox";
    }
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "img") return element.hasAttribute("alt") ? "img" : null;
    if (IMPLICIT_ROLES[tag] !== undefined) return IMPLICIT_ROLES[tag];
    return null;
  };

  const isSkipped = (element: Element): boolean => {
    const tag = tagOf(element);
    if (SKIP_TAGS[tag] === true) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    if (tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "hidden") return true;
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  };

  const labelsText = (element: Element): string => {
    const labels = (element as unknown as { labels?: ArrayLike<Element> | null }).labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      const parts: string[] = [];
      for (let index = 0; index < labels.length; index += 1) parts.push(collapse(labels[index].textContent));
      const joined = collapse(parts.join(" "));
      if (joined !== "") return joined;
    }
    const wrapping = element.closest("label");
    if (wrapping !== null && wrapping !== element) return collapse(wrapping.textContent);
    return "";
  };

  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const parts: string[] = [];
      const ids = labelledBy.split(/\s+/);
      for (let index = 0; index < ids.length; index += 1) {
        if (ids[index] === "") continue;
        const reference = document.getElementById(ids[index]);
        if (reference !== null) parts.push(collapse(reference.textContent));
      }
      const joined = collapse(parts.join(" "));
      if (joined !== "") return joined;
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel !== null && collapse(ariaLabel) !== "") return collapse(ariaLabel);
    const tag = tagOf(element);
    const labelled = labelsText(element);
    if (labelled !== "") return labelled;
    if (tag === "img" || tag === "area" || (tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "image")) {
      const alt = element.getAttribute("alt");
      if (alt !== null) return collapse(alt);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder !== null && collapse(placeholder) !== "") return collapse(placeholder);
    const title = element.getAttribute("title");
    if (title !== null && collapse(title) !== "") return collapse(title);
    const text = collapse(element.textContent);
    if (text !== "") return text;
    const image = element.querySelector("img[alt]");
    if (image !== null) return collapse(image.getAttribute("alt"));
    return "";
  };

  const isActionable = (element: Element, role: string | null): boolean => {
    const tag = tagOf(element);
    if ((tag === "a" || tag === "area") && element.hasAttribute("href")) return true;
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") return true;
    if (tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() !== "hidden") return true;
    if ((element as HTMLElement).isContentEditable === true) return true;
    const tabindex = element.getAttribute("tabindex");
    if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return true;
    return role !== null && ACTIONABLE_ROLES[role] === true;
  };

  const headingLevel = (element: Element, tag: string): number | null => {
    if (/^h[1-6]$/.test(tag)) return Number.parseInt(tag.slice(1), 10);
    const ariaLevel = Number.parseInt(element.getAttribute("aria-level") ?? "", 10);
    return Number.isFinite(ariaLevel) && ariaLevel > 0 ? ariaLevel : null;
  };

  const controlValue = (element: Element, tag: string): string | null => {
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      // A password value never enters a snapshot: snapshots become transcripts.
      if (type === "password") return null;
      if (type === "checkbox" || type === "radio" || type === "file" || type === "button"
        || type === "submit" || type === "reset" || type === "image" || type === "color") return null;
      const value = (element as HTMLInputElement).value;
      return typeof value === "string" ? value : null;
    }
    if (tag === "textarea") {
      const value = (element as HTMLTextAreaElement).value;
      return typeof value === "string" ? value : null;
    }
    if (tag === "option") return element.getAttribute("value");
    return null;
  };

  const attributes = (element: Element, tag: string, ref: string | null): string => {
    const parts: string[] = [];
    if (ref !== null) parts.push(`[ref=${ref}]`);
    const level = headingLevel(element, tag);
    if (level !== null) parts.push(`[level=${level}]`);
    const checked = (tag === "input" && asBooleanProperty(element, "checked"))
      || element.getAttribute("aria-checked") === "true";
    if (checked) parts.push("[checked]");
    if (asBooleanProperty(element, "disabled") || element.getAttribute("aria-disabled") === "true") parts.push("[disabled]");
    const selected = (tag === "option" && asBooleanProperty(element, "selected"))
      || element.getAttribute("aria-selected") === "true";
    if (selected) parts.push("[selected]");
    if (element.getAttribute("aria-expanded") === "true") parts.push("[expanded]");
    const value = controlValue(element, tag);
    if (value !== null && value !== "") {
      parts.push(`[value="${quote(clip(collapse(value), 100))}"]`);
    }
    if (tag === "a" || tag === "area") {
      const href = element.getAttribute("href");
      if (href !== null && href !== "") parts.push(`[href="${quote(clip(href, 200))}"]`);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder !== null && collapse(placeholder) !== "") {
      parts.push(`[placeholder="${quote(clip(collapse(placeholder), 100))}"]`);
    }
    return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
  };

  const record = (depth: number, line: string): boolean => {
    if (truncated) {
      truncatedNodes += 1;
      return false;
    }
    const padding = "  ".repeat(Math.max(0, depth));
    const cost = padding.length + line.length + 1;
    if (budget + cost > maxChars) {
      truncated = true;
      truncatedNodes += 1;
      return false;
    }
    budget += cost;
    lines.push(`${padding}${line}`);
    nodeCount += 1;
    return true;
  };

  // Indentation tracks the printed tree, not invisible wrappers: a container
  // that prints no line does not add a level, so a button nested in six plain
  // <div>s still starts at the left margin and the heading's text sits beneath
  // the heading. Two spaces per printed level.
  const walk = (element: Element, depth: number): void => {
    if (isSkipped(element)) return;
    const tag = tagOf(element);
    const computedRole = roleOf(element);
    const actionable = isActionable(element, computedRole);
    // A focusable or editable element with no implicit role (a contenteditable
    // div, a tabindex container) is still actionable, so it is printed as
    // `generic` and gets a ref instead of disappearing from the tree.
    const role = computedRole ?? (actionable ? "generic" : null);
    if (role === "iframe") {
      const source = (element as HTMLIFrameElement).src || element.getAttribute("src") || "about:blank";
      record(depth, `- iframe "${quote(clip(collapse(source), 200))}"`);
      return;
    }
    let printed = false;
    if (role !== null) {
      if (truncated) {
        // The tree is already cut: count what would have printed without paying
        // for another accessible-name computation on a large remaining DOM.
        truncatedNodes += 1;
      } else {
        const name = accessibleName(element);
        let ref: string | null = null;
        if (actionable) {
          refCounter += 1;
          ref = `e${refCounter}`;
          element.setAttribute("data-rolebox-ref", ref);
          refs.push({ ref, role, name: clip(name, 120) });
        }
        printed = record(depth, `- ${role} "${quote(clip(name, 120))}"${attributes(element, tag, ref)}`);
        if (!printed && ref !== null) {
          // The cap cut this line: the ref was never shown, so withdraw it rather
          // than leaving an invisible element in the ref map.
          refs.pop();
          refCounter -= 1;
          element.removeAttribute("data-rolebox-ref");
        }
      }
    }
    const childDepth = printed ? depth + 1 : depth;
    const children = element.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.nodeType === 1) {
        walk(child as Element, childDepth);
      } else if (full && child.nodeType === 3) {
        if (role !== null && NAME_FROM_CONTENT[role] === true) continue;
        const text = collapse(child.nodeValue);
        if (text !== "") record(childDepth, `text "${quote(clip(text, 200))}"`);
      }
    }
  };

  walk(root, 0);
  if (truncated) lines.push(`[... truncated: ${truncatedNodes} more nodes]`);
  return {
    text: lines.join("\n"),
    nodeCount,
    refCount: refs.length,
    truncated,
    truncatedNodes,
    refs,
    matched: true,
  };
}
