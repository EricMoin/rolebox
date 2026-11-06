/**
 * SuggestDock — the composer draft-suggestion button (browser half).
 *
 * The harness is the same mini-React double used by `dsh-web-ui-dock.test.ts`:
 * a synchronous fiber with per-slot state, effects re-run by dependency, and
 * JSX factories mocked before the module graph is imported. The host's
 * `useSession` / `useInput` seats are provided as props (they are closures over
 * a mutable host snapshot), and `inputActions.setDraft` writes that snapshot and
 * re-renders — the same round trip the real composer performs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Stateful react double + tree harness ───────────────────────────────────

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}

/** Per-mount hook slots (the mini-React "fiber"). */
interface RenderState {
  states: unknown[];
  effects: Array<{ deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }>;
  pending: Array<{
    slot: number;
    effect: () => void | (() => void);
    deps: readonly unknown[] | undefined;
  }>;
}

let renderState: RenderState | null = null;
let currentComponent: ((props: unknown) => unknown) | null = null;
let currentProps: unknown = null;
let hookIndex = 0;
let rendering = false;
let dirty = false;
let tree: VNode | null = null;

/** `useState` — one state slot per hook call, synchronous re-render on change. */
function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void] {
  const rs = renderState!;
  const slot = hookIndex++;
  if (rs.states.length <= slot) {
    rs.states.push(typeof initial === "function" ? (initial as () => S)() : initial);
  }
  return [
    rs.states[slot] as S,
    (value) => {
      const next =
        typeof value === "function"
          ? (value as (previous: S) => S)(rs.states[slot] as S)
          : value;
      // React's Object.is bail-out: an identical value does not re-render.
      if (Object.is(next, rs.states[slot])) return;
      rs.states[slot] = next;
      if (rendering) {
        dirty = true;
        return;
      }
      renderNow();
    },
  ];
}

/** `useEffect` — runs after the commit; re-runs on dependency change (with cleanup). */
function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  const rs = renderState!;
  const slot = hookIndex++;
  const prev = rs.effects[slot];
  const prevDeps = prev?.deps;
  const changed =
    prev === undefined ||
    deps === undefined ||
    prevDeps === undefined ||
    deps.length !== prevDeps.length ||
    deps.some((dep, index) => !Object.is(dep, prevDeps[index]));
  if (changed) rs.pending.push({ slot, effect, deps });
}

function renderNow(): void {
  if (currentComponent === null || renderState === null) return;
  rendering = true;
  hookIndex = 0;
  try {
    tree = currentComponent(currentProps) as VNode;
  } finally {
    rendering = false;
  }
  const due = renderState.pending.splice(0);
  for (const { slot, effect, deps } of due) {
    const prev = renderState.effects[slot];
    if (prev?.cleanup) prev.cleanup();
    // Record the slot BEFORE running the body: a setState inside the effect
    // triggers a synchronous re-render, and the re-registration must see this
    // effect's deps (otherwise the same effect re-queues forever).
    renderState.effects[slot] = { deps, cleanup: undefined };
    const cleanup = effect();
    renderState.effects[slot] = {
      deps,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
  }
  if (dirty) {
    dirty = false;
    renderNow();
  }
}

/** Mount the component (fresh hook slots) and run its mount effects. */
function mount(component: (props: unknown) => unknown, props: unknown): void {
  currentComponent = component;
  currentProps = props;
  renderState = { states: [], effects: [], pending: [] };
  dirty = false;
  renderNow();
}

/** Re-render with new props (effects re-run only if their deps changed). */
function rerender(props: unknown): void {
  currentProps = props;
  renderNow();
}

/** Unmount: run every effect cleanup (React's unmount order is not observable here). */
function unmount(): void {
  const rs = renderState;
  if (rs === null) return;
  for (const effect of [...rs.effects].reverse()) {
    if (effect?.cleanup) effect.cleanup();
  }
  renderState = null;
  currentComponent = null;
  currentProps = null;
  tree = null;
}

// ── Tree query helpers ─────────────────────────────────────────────────────

function childNodes(node: VNode): Array<VNode | string | number> {
  const children = node.props.children;
  if (children === undefined || children === null || typeof children === "boolean") return [];
  if (Array.isArray(children)) return children.flat(Infinity) as Array<VNode | string | number>;
  return [children as VNode | string | number];
}

function walk(node: unknown, visit: (vnode: VNode) => void): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  const vnode = node as VNode;
  if (typeof vnode !== "object" || vnode.type === undefined || vnode.props === undefined) return;
  visit(vnode);
  for (const child of childNodes(vnode)) walk(child, visit);
}

function allNodes(): VNode[] {
  const out: VNode[] = [];
  walk(tree, (node) => out.push(node));
  return out;
}

function byClass(cls: string): VNode[] {
  return allNodes().filter((node) => {
    const className = node.props.className;
    return typeof className === "string" && className.split(" ").includes(cls);
  });
}

function click(node: VNode): void {
  const onClick = node.props.onClick;
  if (typeof onClick === "function") (onClick as () => void)();
}

// ── Module mocks (must precede the component import) ──────────────────────

const FRAGMENT = Symbol.for("react.fragment");

/** `useRef` — a per-slot mutable cell sharing the hook-order slot array. */
function useRef<T>(initial: T): { current: T } {
  const rs = renderState!;
  const slot = hookIndex++;
  if (rs.states.length <= slot) rs.states.push({ current: initial });
  return rs.states[slot] as { current: T };
}

const jsx = (type: unknown, props: Record<string, unknown>): VNode => ({ type, props });

vi.doMock("react", () => ({ useState, useEffect, useRef, createElement: jsx, Fragment: FRAGMENT }));
vi.doMock("react/jsx-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));
vi.doMock("react/jsx-dev-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));

// ── Module under test (dynamic import: mocks must precede the graph) ──────

const suggest = await import("../../src/platform/adapters/dsh/web-ui/suggest-dock.tsx");
const css = await import("../../src/platform/adapters/dsh/web-ui/suggest-dock.css.ts");
const locales = await import("../../src/platform/adapters/dsh/web-ui/suggest-locales.ts");

// ── Host snapshot + props ──────────────────────────────────────────────────

interface HostSession {
  running: boolean;
  blank: boolean;
  subagent: unknown;
}

interface HostInput {
  draft: string;
  phase: string;
}

let host: { session: HostSession; input: HostInput };

/** Every `setDraft` call, in order (the fill/clear contract). */
const drafts: string[] = [];

/** A locale-seat fake; the component falls back to English when absent. */
type TSeat = (key: string, params?: Record<string, unknown>) => string;

/**
 * Compose the props the renderer hands a session-scope slot entry. The two
 * selector seats close over the mutable `host` snapshot; `setDraft` writes it
 * and re-renders, exactly like the composer's own input store.
 */
function propsFor(sessionId = "sess-1", t?: TSeat): unknown {
  return {
    sessionId,
    useSession: (selector: (state: HostSession) => unknown) => selector(host.session),
    useInput: (selector: (state: HostInput) => unknown) => selector(host.input),
    ...(t === undefined ? {} : { t }),
    inputActions: {
      setDraft(text: string) {
        drafts.push(text);
        host.input.draft = text;
        rerender(propsFor(sessionId, t));
      },
    },
  };
}

function mountDock(sessionId = "sess-1", t?: TSeat): void {
  mount(suggest.SuggestDock as unknown as (props: unknown) => unknown, propsFor(sessionId, t));
}

// ── fetch double ───────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: string | null;
  credentials: RequestCredentials | undefined;
  signal: AbortSignal | undefined;
}

type ResponseMode = "suggested" | "none" | "disabled";

let mode: ResponseMode;
let autoRespond: boolean;
const SUGGESTION = "Ship it and verify the result.";
const calls: Call[] = [];
let responders: Array<(res: Response) => void> = [];

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function responseForMode(): Response {
  if (mode === "disabled") {
    return fakeResponse(200, { ok: true, status: "disabled", reason: "not-enabled" });
  }
  if (mode === "none") return fakeResponse(200, { ok: true, status: "none" });
  return fakeResponse(200, {
    ok: true,
    status: "suggested",
    text: SUGGESTION,
    model: "example-provider/example-model",
    ms: 12,
  });
}

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const signal = init?.signal ?? undefined;
  calls.push({
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    body: typeof init?.body === "string" ? init.body : null,
    credentials: init?.credentials,
    signal,
  });
  if (autoRespond) return Promise.resolve(responseForMode());
  // Gated mode: the request stays pending until the test resolves it. The
  // component still observes `signal.aborted`, so a late resolution is a
  // faithful "provider ignored the abort" case.
  return new Promise<Response>((resolve) => {
    responders.push((res) => resolve(res));
  });
}) as typeof fetch;

// ── Fixtures and helpers ───────────────────────────────────────────────────

function button(): VNode {
  return byClass(css.suggestClass.button)[0]!;
}

/** The single tooltip block rendered beside the button. */
function tooltip(): VNode {
  return allNodes().find((node) => node.props.role === "tooltip")!;
}

/** Visible text of a vnode subtree, in tree order. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node === "boolean") return "";
  return childNodes(node as VNode).map((child) => textOf(child)).join("");
}

/** Flush the microtask chain (fetch → json → setState). */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Advance the fake clock, flushing the microtasks the timer callback starts. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  host = {
    session: { running: false, blank: false, subagent: null },
    input: { draft: "", phase: "plain" },
  };
  mode = "suggested";
  autoRespond = true;
  calls.length = 0;
  drafts.length = 0;
  responders = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  renderState = null;
  tree = null;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SuggestDock", () => {
  it("fills the composer once an idle session has an empty draft", async () => {
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/rolebox/copilot/suggest");
    expect(suggest.SUGGEST_ENDPOINT).toBe("/rolebox/copilot/suggest");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.credentials).toBe("same-origin");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ session: "sess-1" });

    expect(drafts).toEqual([SUGGESTION]);
    expect(host.input.draft).toBe(SUGGESTION);
    // The filled draft is OURS: the control is the clear affordance.
    expect(button().props["aria-label"]).toBe("Suggestion inserted");
    expect(button().props.title).toBeUndefined();
    expect(textOf(button())).toBe("Clear");
    expect(button().props.disabled).toBe(false);
    const tip = tooltip();
    expect(tip.props.role).toBe("tooltip");
    expect(typeof tip.props.id).toBe("string");
    expect(button().props["aria-describedby"]).toBe(tip.props.id);
    expect(textOf(tip)).toContain("Suggestion inserted");
    expect(textOf(tip)).toContain("This draft was filled automatically.");
    expect(textOf(tip)).toContain("Clearing it never sends it.");
    expect(suggest.SUGGEST_DELAY_MS).toBe(300);
  });

  it("renders the idle pill label and a tooltip explaining fill/decide semantics", () => {
    mountDock();

    expect(textOf(button())).toBe("Suggest");
    expect(button().props.title).toBeUndefined();
    expect(button().props["aria-label"]).toBe("Suggest the next message");
    expect(button().props.disabled).toBe(false);

    const tip = tooltip();
    expect(tip).toBeDefined();
    expect(tip.props.role).toBe("tooltip");
    expect(typeof tip.props.id).toBe("string");
    expect(button().props["aria-describedby"]).toBe(tip.props.id);
    expect(textOf(tip)).toContain("Suggest the next message");
    expect(textOf(tip)).toContain(
      "Fills the composer with a likely next message from this conversation - you decide whether to send it.",
    );
  });

  it("does not request or fill while the user already has draft text", async () => {
    host.input.draft = "I already typed this";
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS * 4);

    expect(calls).toHaveLength(0);
    expect(drafts).toHaveLength(0);
    expect(host.input.draft).toBe("I already typed this");
    // The user owns the draft: the button cannot overwrite it.
    expect(button().props["aria-label"]).toBe("Suggestion unavailable");
    expect(textOf(button())).toBe("Suggest");
    expect(textOf(tooltip())).toContain(
      "The composer already has your text - it is never overwritten.",
    );
    expect(button().props.disabled).toBe(true);
    click(button());
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(0);
  });

  it("aborts the request when the user types before the response and drops the stale answer", async () => {
    autoRespond = false;
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(1);
    // In flight: the pill and tooltip say so.
    expect(textOf(button())).toBe("Suggesting");
    expect(button().props["aria-label"]).toBe("Generating a suggestion");
    expect(textOf(tooltip())).toContain("Typing cancels it.");
    const signal = calls[0]!.signal!;
    expect(signal.aborted).toBe(false);

    // The user starts typing: the effect cleanup must abort in-flight work.
    host.input.draft = "Wait, instead";
    rerender(propsFor());
    expect(signal.aborted).toBe(true);

    // A provider that ignored the abort and answered late must not be applied.
    responders[0]!(responseForMode());
    await settle();
    expect(drafts).toHaveLength(0);
    expect(host.input.draft).toBe("Wait, instead");
    expect(button().props.disabled).toBe(true);
  });

  it("asks at most once per idle, even after a none result and a draft keystroke", async () => {
    mode = "none";
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(1);

    // Long after the miss, and after the user typed then erased, the SAME idle
    // must not ask again.
    await advance(3_000);
    host.input.draft = "h";
    rerender(propsFor());
    host.input.draft = "";
    rerender(propsFor());
    await advance(3_000);

    expect(calls).toHaveLength(1);
    expect(drafts).toHaveLength(0);

    // The button is the explicit re-ask path: an idle click asks once more.
    click(button());
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(2);
  });

  it("stops requesting the session after a disabled response", async () => {
    mode = "disabled";
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(1);
    expect(drafts).toHaveLength(0);

    // The feature is off for this role/profile: neither the button nor another
    // idle/keystroke round trip may reach the route again.
    click(button());
    await advance(1_000);
    host.input.draft = "x";
    rerender(propsFor());
    host.input.draft = "";
    rerender(propsFor());
    await advance(1_000);

    expect(calls).toHaveLength(1);
    expect(button().props.disabled).toBe(true);
  });

  it("clears an injected suggestion on click without re-requesting that idle", async () => {
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(host.input.draft).toBe(SUGGESTION);

    click(button());
    expect(drafts).toEqual([SUGGESTION, ""]);
    expect(host.input.draft).toBe("");
    expect(button().props["aria-label"]).toBe("Suggest the next message");
    expect(textOf(button())).toBe("Suggest");
    expect(button().props.disabled).toBe(false);

    // Clearing is not a new idle: no automatic request follows.
    await advance(3_000);
    expect(calls).toHaveLength(1);
  });

  it("skips blank and subagent sessions", async () => {
    host.session.blank = true;
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    click(button());
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(0);
    expect(button().props.disabled).toBe(true);

    host.session = { running: false, blank: false, subagent: { address: { mode: "continuable" } } };
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    click(button());
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(0);
    expect(button().props.disabled).toBe(true);
  });

  it("aborts in flight work and writes nothing after unmount", async () => {
    autoRespond = false;
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(calls).toHaveLength(1);
    const signal = calls[0]!.signal!;

    unmount();
    expect(signal.aborted).toBe(true);

    responders[0]!(responseForMode());
    await settle();
    expect(drafts).toHaveLength(0);
    expect(host.input.draft).toBe("");
  });

  it("explains each disabled reason in the tooltip", async () => {
    // 1. blank session (no transcript yet)
    host.session.blank = true;
    mountDock();
    expect(button().props.disabled).toBe(true);
    expect(button().props["aria-label"]).toBe("Suggestion unavailable");
    expect(textOf(tooltip())).toContain("This session has no conversation yet.");

    // 2. subagent conversation
    host.session = { running: false, blank: false, subagent: { address: { mode: "continuable" } } };
    mountDock();
    expect(textOf(tooltip())).toContain("Subagent conversations do not offer suggestions.");

    // 3. feature disabled by config: the host answered `disabled`.
    host.session = { running: false, blank: false, subagent: null };
    mode = "disabled";
    mountDock();
    await advance(suggest.SUGGEST_DELAY_MS);
    expect(textOf(tooltip())).toContain(
      "Copilot draft suggestions are disabled for this role or host.",
    );

    // 4. user-typed draft (never overwritten)
    mode = "suggested";
    host.input.draft = "my own words";
    mountDock();
    expect(textOf(tooltip())).toContain(
      "The composer already has your text - it is never overwritten.",
    );
  });

  it("renders the Chinese pill labels and tooltip copy through the locale seat", async () => {
    const t: TSeat = (key) => locales.zh[key] ?? key;
    mountDock("sess-1", t);

    expect(textOf(button())).toBe("建议");
    expect(button().props["aria-label"]).toBe("建议下一条消息");
    expect(textOf(tooltip())).toContain(
      "根据当前对话生成一条下一条消息并填入输入框，是否发送由你决定。",
    );

    await advance(suggest.SUGGEST_DELAY_MS);
    expect(textOf(button())).toBe("清除");
    expect(button().props["aria-label"]).toBe("已填入建议");
    expect(textOf(tooltip())).toContain("这条草稿是自动填入的；清除不会发送它。");
  });

  it("self-mounts namespaced CSS and ships a 28px-high pill", () => {
    expect(css.suggestCss).toContain(".rolebox-suggest-button");
    expect(css.suggestCss).toContain("height: 28px");
    expect(css.suggestCss).toContain("padding: 0 8px");
    expect(css.suggestCss).toContain("gap: 6px");
    expect(css.suggestCss).toContain("font-size: 12px");
    expect(css.suggestCss).toContain("bottom: calc(100% + 8px)");
    expect(css.suggestCss).toContain("max-width: 260px");
    expect(css.suggestCss).toContain("pointer-events: none");
    expect(css.suggestCss).toContain(".rolebox-suggest:hover .rolebox-suggest-tip");
    expect(css.suggestCss).toContain(".rolebox-suggest:focus-within .rolebox-suggest-tip");
    expect(css.suggestCss).toContain("data-state=\"injected\"");
    expect(css.suggestCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css.suggestClass.button).toBe("rolebox-suggest-button");
    expect(css.suggestClass.tip).toBe("rolebox-suggest-tip");
  });
});
