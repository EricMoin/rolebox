/**
 * SuggestDock — the composer draft-suggestion button in the dsh composer tool
 * row (browser half).
 *
 * The component contributes to `'conversation.input.right'`, the session-scoped
 * list seat immediately left of the model selector. It is a 28px-high pill —
 * sparkle glyph plus a short localized action label — with a state-aware
 * tooltip on hover and keyboard focus:
 *
 *   - idle (the session is not running, the draft is empty, the session is not
 *     blank and not a subagent) — one click asks the host for a draft;
 *   - the automatic path — after a turn ends (`running` true -> false) with a
 *     plain input phase and an empty draft, the component waits
 *     {@link SUGGEST_DELAY_MS} and then asks ONCE. A `none` answer is final for
 *     that idle: the component does not re-ask until the next turn. The user
 *     can always ask again with the button;
 *   - loading — the single request is in flight and the button is disabled;
 *   - injected — a suggested draft was written into the composer with
 *     `inputActions.setDraft(text)`. The button turns into the clear
 *     affordance (`setDraft('')`), and the injected text is remembered so the
 *     host echo of our own write is not mistaken for the user typing;
 *   - draft non-empty and not ours — the user owns the draft; the button is
 *     disabled and never overwrites it.
 *
 * The host contract is `POST /rolebox/copilot/suggest` with
 * `{ session: string }`:
 *
 *   - `200 { ok: true, status: "suggested", text, model, ms }` — fill the
 *     composer;
 *   - `200 { ok: true, status: "none" }` — nothing sensible to offer;
 *   - `200 { ok: true, status: "disabled", reason }` — the feature is off for
 *     this role/profile. That answer is remembered per session id and stops
 *     every further request for it.
 *
 * Concurrency and cancellation:
 *
 *   - one request at a time, per component;
 *   - every request is bounded by its own `AbortController`, and the effect
 *     cleanup aborts it when the user edits before the response, the session
 *     starts running again, the session id changes, or the component unmounts;
 *   - before injecting, the LATEST values are re-read through a ref (draft
 *     still empty, phase still plain, still idle, same session, still mounted);
 *     a stale answer is dropped;
 *   - no state is written after unmount.
 *
 * The slot contract is consumed structurally: the component receives
 * `sessionId` through the entry's inject factory and the renderer's
 * `SessionStandardProps` (`useSession`, `useInput`, `inputActions`). It imports
 * only `react`, its own CSS module and its own copy table — no node builtins,
 * no host packages, no non-relative imports. The only external I/O is the
 * same-origin relative `fetch` above.
 *
 * @module
 */

import { useState, useEffect, useRef } from "react";
import { suggestClass } from "./suggest-dock.css.ts";
import { en as suggestEn, type SuggestKey } from "./suggest-locales.ts";

/** `POST /rolebox/copilot/suggest` — same-origin relative path on the dsh web server. */
export const SUGGEST_ENDPOINT = "/rolebox/copilot/suggest";

/** Delay between the session going idle and the automatic request (ms). */
export const SUGGEST_DELAY_MS = 300;

/**
 * Monotonic tooltip-id source. A module-level counter rather than `useId`:
 * the structural react stub in this directory exposes only
 * `useState`/`useEffect`/`useRef`.
 */
let tooltipSequence = 0;

/**
 * The subset of the renderer's session snapshot this component reads.
 *
 * `SessionStandardProps.useSession` selects over the host's `SessionSnapshot`;
 * only these three fields matter here. They are optional so a host snapshot
 * that omits one degrades to the safe default instead of throwing.
 */
export interface SuggestSessionState {
  /** True while the agent is working on a turn. */
  running?: boolean;
  /** True for a brand-new session with no conversation to read. */
  blank?: boolean;
  /** Non-null when the session is a subagent conversation. */
  subagent?: unknown;
}

/** The subset of the renderer's input state this component reads. */
export interface SuggestInputState {
  /** Clipboard-text projection of the composer draft. */
  draft?: string;
  /** Submit-plane phase; only `"plain"` is editable. */
  phase?: string;
}

/**
 * Composed props of the draft-suggestion entry — the structural intersection
 * of the slot's inject face (`{ sessionId }`) and the renderer's
 * `SessionStandardProps` seats this component consumes.
 */
export interface SuggestDockProps {
  /** Framework-resolved session id, delivered via the entry's inject factory. */
  sessionId: string;
  /** Session snapshot selector (the renderer's standard session seat). */
  useSession: <T>(selector: (state: SuggestSessionState) => T) => T;
  /** Input state selector (the renderer's standard input seat). */
  useInput: <T>(selector: (state: SuggestInputState) => T) => T;
  /** Stable composer actions; only `setDraft` is used. */
  inputActions: { setDraft(text: string): void };
  /** Optional locale seat of the declared namespace; absent falls back to English copy. */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/** Button states (also rendered as `data-state` for styling and tests). */
export type SuggestButtonState = "idle" | "loading" | "injected" | "disabled";

/** Structural record guard (no node builtins). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Suggestion glyph — a 14x14 four-point sparkle, following the composer-row
 * glyph convention shared with the role chip (14x14 artboard, `fill: none`,
 * `currentColor`, `aria-hidden`). Inline local SVG: the dsh primitives icon
 * set is deliberately not imported.
 */
function SuggestGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.6c.35 2.3 1.1 3.05 3.4 3.4-2.3.35-3.05 1.1-3.4 3.4-.35-2.3-1.1-3.05-3.4-3.4 2.3-.35 3.05-1.1 3.4-3.4Z"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path
        d="M10.4 9.3c.18 1.1.52 1.44 1.6 1.6-1.08.16-1.42.5-1.6 1.6-.18-1.1-.52-1.44-1.6-1.6 1.08-.16 1.42-.5 1.6-1.6Z"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The draft-suggestion button.
 *
 * @param props - composed slot props (see {@link SuggestDockProps}).
 */
export function SuggestDock({
  sessionId,
  useSession,
  useInput,
  inputActions,
  t,
}: SuggestDockProps) {
  // Session facts. Called unconditionally at the top: these are the renderer's
  // standard session/input hook seats, so their order must stay stable.
  const running = useSession((state) => state.running === true);
  const blank = useSession((state) => state.blank === true);
  const subagent = useSession((state) => state.subagent ?? null);
  const draft = useInput((state) => state.draft ?? "");
  const phase = useInput((state) => state.phase ?? "plain");

  /** True while our single request is in flight. */
  const [inflight, setInflight] = useState(false);
  /** The text WE injected; the host echo of it is not user typing. */
  const [injectedText, setInjectedText] = useState<string | null>(null);
  /** True after the host answered `disabled` for the current session id. */
  const [disabled, setDisabled] = useState(false);

  /** Latest injected text, readable from async continuations before render. */
  const injectedRef = useRef<string | null>(null);
  /** Session ids the host reported `disabled` for (survives a re-render). */
  const disabledRef = useRef<Set<string>>(new Set());
  /** Whether this idle episode already spent its one automatic request. */
  const autoRequestedRef = useRef(false);
  /** False once the component unmounts; every async write checks it. */
  const mountedRef = useRef(true);
  /** The in-flight request's controller (one request at a time). */
  const activeControllerRef = useRef<AbortController | null>(null);
  /** True while the request behind `activeControllerRef` is unresolved. */
  const inflightRef = useRef(false);
  /** Snapshot of the latest render values, read by the async continuation. */
  const latestRef = useRef({
    sessionId,
    draft,
    phase,
    running,
    blank,
    subagent,
  });
  latestRef.current = { sessionId, draft, phase, running, blank, subagent };

  /** Unique, stable tooltip id for this mount's `aria-describedby`. */
  const tooltipIdRef = useRef<string | null>(null);
  const tooltipId =
    tooltipIdRef.current ?? `rolebox-suggest-tip-${++tooltipSequence}`;
  if (tooltipIdRef.current === null) tooltipIdRef.current = tooltipId;

  // Unmount guard: abort whatever is in flight and refuse every later write.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const controller = activeControllerRef.current;
      if (controller !== null) {
        activeControllerRef.current = null;
        controller.abort();
      }
    };
  }, []);

  // Session-scoped reset. A new session must never inherit the previous
  // session's injected/loading/disabled posture.
  useEffect(() => {
    autoRequestedRef.current = false;
    injectedRef.current = null;
    setInjectedText(null);
    setDisabled(disabledRef.current.has(sessionId));
    const controller = activeControllerRef.current;
    if (controller !== null) {
      activeControllerRef.current = null;
      controller.abort();
    }
    inflightRef.current = false;
    setInflight(false);
  }, [sessionId]);

  // The idle watcher. It owns BOTH the one-per-idle automatic request and the
  // cancellation of whatever request an earlier render started:
  //   - `running` true starts a new turn, so the next idle may ask again;
  //   - any dependency change (draft typed, phase left plain, running resumed,
  //     session changed, feature disabled) aborts the in-flight request — the
  //     timer is cleared and the controller is aborted here, not later.
  useEffect(() => {
    if (running) autoRequestedRef.current = false;

    const canAutoRequest =
      !running &&
      !blank &&
      subagent === null &&
      !disabled &&
      phase === "plain" &&
      draft === "" &&
      !autoRequestedRef.current;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (canAutoRequest) {
      // Spend this idle's one automatic request at scheduling time: even if the
      // answer is `none` (or the schedule is cancelled by a keystroke), the
      // same idle never fires again.
      autoRequestedRef.current = true;
      timer = setTimeout(() => {
        timer = undefined;
        startRequest();
      }, SUGGEST_DELAY_MS);
    }

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      const controller = activeControllerRef.current;
      if (controller !== null) {
        activeControllerRef.current = null;
        controller.abort();
      }
    };
  }, [sessionId, running, phase, draft, blank, subagent, disabled]);

  /**
   * Begin one request. The latest render values are checked again first: the
   * timer may fire after a re-render that invalidated the schedule.
   */
  function startRequest(): void {
    if (!mountedRef.current) return;
    const latest = latestRef.current;
    if (latest.running || latest.blank || latest.subagent !== null) return;
    if (latest.phase !== "plain" || latest.draft !== "") return;
    if (disabledRef.current.has(latest.sessionId)) return;

    const previous = activeControllerRef.current;
    if (previous !== null) previous.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    inflightRef.current = true;
    setInflight(true);
    void runRequest(controller, latest.sessionId);
  }

  /**
   * Perform and apply one suggestion request.
   *
   * @param controller - This request's abort controller.
   * @param requestSessionId - The session the request was issued for.
   */
  async function runRequest(
    controller: AbortController,
    requestSessionId: string,
  ): Promise<void> {
    const isCurrent = (): boolean =>
      mountedRef.current &&
      !controller.signal.aborted &&
      latestRef.current.sessionId === requestSessionId;

    try {
      const res = await fetch(SUGGEST_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: requestSessionId }),
        signal: controller.signal,
      });
      if (!isCurrent() || !res.ok) return;

      const data = (await res.json().catch(() => null)) as unknown;
      if (!isCurrent() || !isRecord(data) || data.ok !== true) return;

      if (data.status === "disabled") {
        disabledRef.current.add(requestSessionId);
        if (latestRef.current.sessionId === requestSessionId) setDisabled(true);
        return;
      }
      if (data.status !== "suggested" || typeof data.text !== "string") return;

      const text = data.text;
      if (text.trim() === "") return;

      // Re-read the LATEST values: the response is only usable while the
      // session is still idle, still plain, still empty, and still this
      // session. Anything else means the user moved on.
      const latest = latestRef.current;
      if (!isCurrent()) return;
      if (
        latest.sessionId !== requestSessionId ||
        latest.draft !== "" ||
        latest.phase !== "plain" ||
        latest.running
      ) {
        return;
      }

      // Remember the text BEFORE writing it, so the resulting draft change is
      // recognised as ours (the clear affordance) rather than as typing.
      injectedRef.current = text;
      setInjectedText(text);
      inputActions.setDraft(text);
    } catch {
      // Aborted, offline or a malformed transport: a miss. The next idle (or
      // the button) may ask again.
    } finally {
      const active = activeControllerRef.current;
      // Reset the loading state only when this request is still the current
      // one, or when a cleanup already detached it. A request that a newer one
      // replaced must not clear its successor's loading state.
      if (active === controller || active === null) {
        if (active === controller) activeControllerRef.current = null;
        inflightRef.current = false;
        if (mountedRef.current) setInflight(false);
      }
    }
  }

  const injected = draft !== "" && injectedText !== null && draft === injectedText;
  const userDraft = draft !== "" && !injected;
  // Blank (no transcript) and subagent conversations have nothing to suggest.
  // The control stays mounted — the composer row must not reflow — but it is
  // inert; the tooltip still explains why.
  const unavailable = blank || subagent !== null || disabled;

  let state: SuggestButtonState;
  let labelKey: SuggestKey;
  let titleKey: SuggestKey;
  let bodyKey: SuggestKey;
  if (injected) {
    state = "injected";
    labelKey = "label.injected";
    titleKey = "title.injected";
    bodyKey = "body.injected";
  } else if (inflight) {
    state = "loading";
    labelKey = "label.loading";
    titleKey = "title.loading";
    bodyKey = "body.loading";
  } else if (unavailable || userDraft) {
    state = "disabled";
    labelKey = "label.idle";
    titleKey = "title.disabled";
    // One body per reason, in the precedence the component applies it.
    if (blank) bodyKey = "body.disabled.blank";
    else if (subagent !== null) bodyKey = "body.disabled.subagent";
    else if (disabled) bodyKey = "body.disabled.config";
    else bodyKey = "body.disabled.draft";
  } else {
    state = "idle";
    labelKey = "label.idle";
    titleKey = "title.idle";
    bodyKey = "body.idle";
  }

  // The `t` seat is optional: the unit-test harness (and a host without the
  // locale namespace) falls back to the shipped English copy.
  const copy = (key: SuggestKey): string => t?.(key) ?? suggestEn[key] ?? key;
  const label = copy(labelKey);
  const title = copy(titleKey);
  const body = copy(bodyKey);

  const onActivate = (): void => {
    if (injected) {
      injectedRef.current = null;
      setInjectedText(null);
      inputActions.setDraft("");
      return;
    }
    if (state === "idle") startRequest();
  };

  return (
    <div className={suggestClass.root} data-rolebox-suggest data-state={state}>
      <button
        type="button"
        className={suggestClass.button}
        data-state={state}
        aria-label={title}
        aria-describedby={tooltipId}
        disabled={state === "loading" || state === "disabled"}
        onClick={onActivate}
      >
        <span className={suggestClass.glyph} aria-hidden="true">
          <SuggestGlyph />
        </span>
        <span className={suggestClass.label} aria-hidden="true">
          {label}
        </span>
      </button>
      <div className={suggestClass.tip} role="tooltip" id={tooltipId}>
        <span className={suggestClass.tipTitle}>{title}</span>
        <span className={suggestClass.tipBody}>{body}</span>
      </div>
    </div>
  );
}
