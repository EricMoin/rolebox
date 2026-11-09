/**
 * SuggestDock — the composer draft-suggestion button in the dsh composer tool
 * row (browser half).
 *
 * The component contributes to `'conversation.input.right'`, the session-scoped
 * list seat immediately left of the model selector. It is a 28px-high pill —
 * sparkle glyph plus a short localized action label — with a state-aware
 * tooltip on hover and keyboard focus, and it never writes the composer on its
 * own:
 *
 *   - idle (the session is not running, the draft is empty, the session is not
 *     blank and not a subagent) — one click asks the host for a draft with
 *     `intent: "manual"` (the host may abstain when no useful draft exists);
 *   - the automatic path — after a turn ends (`running` true -> false) with a
 *     plain input phase and an empty draft, the component waits
 *     {@link SUGGEST_DELAY_MS} and then asks ONCE with `intent: "auto"` (the
 *     conservative rule: a `none` answer is legitimate). A `none` answer is
 *     final for that idle: the component does not re-ask until the next turn.
 *     The user can always ask again with the button;
 *   - loading — the single request is in flight and the button is disabled;
 *   - suggestion ready — a `suggested` answer is held in component state and
 *     rendered as a HINT CARD above the pill: a small eyebrow, the text and
 *     two real buttons, Fill (`inputActions.setDraft(text)`) and Dismiss.
 *     Nothing is written until Fill. The pill keeps its idle label and gains
 *     an accent while the card is open; the tooltip is hidden so it cannot
 *     overlap the card. The card clears on Fill, Dismiss, typing (any
 *     non-empty draft), a new turn (`running` true), a session change or
 *     unmount, and never reappears for the same idle;
 *   - draft non-empty — the user owns the draft; the button is disabled and
 *     never overwrites it.
 *
 * The host contract is `POST /rolebox/copilot/suggest` with
 * `{ session: string, intent?: "auto" | "manual" }`:
 *
 *   - `200 { ok: true, status: "suggested", text, model, ms }` — keep the text
 *     in component state and show the hint card above the button; nothing is
 *     written to the composer until the user chooses Fill;
 *   - `200 { ok: true, status: "none" }` — nothing sensible to offer;
 *   - `200 { ok: true, status: "disabled", reason }` — the feature is off for
 *     this role/profile. That answer is remembered per session id and stops
 *     every further request for it.
 *
 * A MANUAL ask that ends in `none` or `disabled` must not look like a dead
 * button: the component raises a transient notice for {@link SUGGEST_NOTICE_MS}
 * in the tooltip area (`data-notice` on the root forces that tooltip visible).
 * Automatic requests never raise a notice, and any later state change — typing,
 * a new turn, a session change or unmount — clears it.
 *
 * Concurrency and cancellation:
 *
 *   - one request at a time, per component;
 *   - every request is bounded by its own `AbortController`, and the effect
 *     cleanup aborts it when the user edits before the response, the session
 *     starts running again, the session id changes, or the component unmounts;
 *   - before storing the answer, the LATEST values are re-read through a ref
 *     (draft still empty, phase still plain, still idle, same session, still
 *     mounted); a stale answer is dropped;
 *   - no state is written after unmount.
 *
 * Automatic requests can be disabled from the hover/focus panel or hint card.
 * That browser-local preference survives reloads and leaves manual asks usable.
 *
 * The slot contract is consumed structurally: the component receives
 * `sessionId` through the entry's inject factory and the renderer's
 * `SessionStandardProps` (`useSession`, `useInput`, `inputActions`). It imports
 * only `react`, its own CSS module, its own copy table and a TYPE-ONLY intent
 * union — no node builtins, no host packages, no non-relative imports. The only
 * external I/O is the same-origin relative `fetch` above and local preferences.
 *
 * @module
 */

import { useState, useEffect, useRef } from "react";
import type { DraftIntent } from "../../../../copilot/draft/prompt.ts";
import { suggestClass } from "./suggest-dock.css.ts";
import { en as suggestEn, type SuggestKey } from "./suggest-locales.ts";
import { getAutoSuggestEnabled, setAutoSuggestEnabled, subscribeAutoSuggest } from "./suggest-preferences.ts";

/** `POST /rolebox/copilot/suggest` — same-origin relative path on the dsh web server. */
export const SUGGEST_ENDPOINT = "/rolebox/copilot/suggest";

/** Delay between the session going idle and the automatic request (ms). */
export const SUGGEST_DELAY_MS = 300;

/** How long a manual request's transient notice stays visible (ms). */
export const SUGGEST_NOTICE_MS = 4_000;

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
export type SuggestButtonState = "idle" | "loading" | "disabled";

/**
 * A transient notice raised by a MANUAL request that produced no draft:
 * `"none"` (the model had nothing to propose) or `"disabled"` (the feature is
 * off for this session). Automatic requests never raise one.
 */
export type SuggestNotice = "none" | "disabled";

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
  /** The last `suggested` answer; shown as a hint card, never auto-written. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** True after the host answered `disabled` for the current session id. */
  const [disabled, setDisabled] = useState(false);
  /** A manual request's transient explanation; `null` when none is showing. */
  const [notice, setNotice] = useState<SuggestNotice | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(getAutoSuggestEnabled);
  const [popoverDismissed, setPopoverDismissed] = useState(false);

  /** Session ids the host reported `disabled` for (survives a re-render). */
  const disabledRef = useRef<Set<string>>(new Set());
  /** Whether this idle episode already spent its one automatic request. */
  const autoRequestedRef = useRef(false);
  /** False once the component unmounts; every async write checks it. */
  const mountedRef = useRef(true);
  /** The in-flight request's controller (one request at a time). */
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeIntentRef = useRef<DraftIntent | null>(null);
  const suggestionIntentRef = useRef<DraftIntent | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** True while the request behind `activeControllerRef` is unresolved. */
  const inflightRef = useRef(false);
  /** The pending auto-clear timer of the transient manual notice. */
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Snapshot of the latest render values, read by the async continuation. */
  const latestRef = useRef({
    sessionId,
    draft,
    phase,
    running,
    blank,
    subagent,
    autoEnabled,
  });
  latestRef.current = { sessionId, draft, phase, running, blank, subagent, autoEnabled };

  function cancelRequest(): void {
    const controller = activeControllerRef.current;
    activeControllerRef.current = null;
    activeIntentRef.current = null;
    controller?.abort();
    inflightRef.current = false;
    if (mountedRef.current) setInflight(false);
  }

  /** Drop the transient notice (and its pending auto-clear timer). */
  function clearNotice(): void {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(null);
  }

  /**
   * Raise one transient notice for a MANUAL request's non-draft outcome.
   * Never called for an automatic request, and never steals focus: the notice
   * only forces the hover/focus panel visible.
   */
  function showNotice(kind: SuggestNotice): void {
    if (!mountedRef.current) return;
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    setNotice(kind);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      if (mountedRef.current) setNotice(null);
    }, SUGGEST_NOTICE_MS);
  }

  /** Unique, stable tooltip id for this mount's `aria-describedby`. */
  const tooltipIdRef = useRef<string | null>(null);
  const tooltipId =
    tooltipIdRef.current ?? `rolebox-suggest-tip-${++tooltipSequence}`;
  if (tooltipIdRef.current === null) tooltipIdRef.current = tooltipId;

  useEffect(() => subscribeAutoSuggest((enabled) => {
    latestRef.current.autoEnabled = enabled;
    setAutoEnabled(enabled);
  }), []);

  useEffect(() => {
    if (autoEnabled) return;
    if (activeIntentRef.current === "auto") cancelRequest();
    if (suggestionIntentRef.current === "auto") {
      suggestionIntentRef.current = null;
      setSuggestion(null);
      // Closing the automatic card must not strand keyboard focus on its switch.
      const card = cardRef.current;
      if (card !== null && typeof document !== "undefined" && card.contains(document.activeElement)) {
        buttonRef.current?.focus();
      }
    }
  }, [autoEnabled]);

  // Unmount guard: abort whatever is in flight and refuse every later write.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      cancelRequest();
    };
  }, []);

  // Session-scoped reset. A new session must never inherit the previous
  // session's suggestion/loading/disabled posture or a stale notice.
  useEffect(() => {
    autoRequestedRef.current = false;
    setSuggestion(null);
    suggestionIntentRef.current = null;
    setPopoverDismissed(false);
    setDisabled(disabledRef.current.has(sessionId));
    clearNotice();
    cancelRequest();
  }, [sessionId]);

  // The hint card belongs to an idle, empty composer. Typing (a non-empty
  // draft) or a new turn (`running` true) clears it so it can never linger
  // over the composer; Fill and Dismiss clear it directly. The auto path
  // already spends one request per idle, so a cleared card does not reappear.
  useEffect(() => {
    if (draft !== "" || running) setSuggestion(null);
  }, [draft, running]);

  // The transient manual notice belongs to the state it explains. Any later
  // state change the user can observe — typing, a new turn, a session switch,
  // the session going blank/subagent, or the phase leaving `plain` — clears it.
  // `disabled` is deliberately absent: a manual request's OWN `disabled` answer
  // arrives with that flag and must keep its notice.
  useEffect(() => {
    clearNotice();
  }, [sessionId, running, draft, phase, blank, subagent]);

  // Session/input invalidation cancels either intent. Keep it separate from
  // the auto preference so toggling that preference cannot cancel a manual ask.
  useEffect(() => () => cancelRequest(), [sessionId, running, phase, draft, blank, subagent, disabled]);

  // Spend at most one automatic request per idle, even if its schedule is cancelled.
  useEffect(() => {
    if (running) autoRequestedRef.current = false;

    const canAutoRequest =
      autoEnabled &&
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
        autoTimerRef.current = null;
        startRequest("auto");
      }, SUGGEST_DELAY_MS);
      autoTimerRef.current = timer;
    }

    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        if (autoTimerRef.current === timer) autoTimerRef.current = null;
      }
    };
  }, [sessionId, running, phase, draft, blank, subagent, disabled, autoEnabled]);

  /**
   * Begin one request. The latest render values are checked again first: the
   * timer may fire after a re-render that invalidated the schedule.
   *
   * @param intent - `"auto"` for the idle timer, `"manual"` for a click.
   */
  function startRequest(intent: DraftIntent): void {
    if (!mountedRef.current) return;
    const latest = latestRef.current;
    if (latest.running || latest.blank || latest.subagent !== null) return;
    if (latest.phase !== "plain" || latest.draft !== "") return;
    if (disabledRef.current.has(latest.sessionId)) return;
    if (intent === "auto" && !latest.autoEnabled) return;
    if (inflightRef.current) return;
    if (intent === "manual") {
      autoRequestedRef.current = true;
      if (autoTimerRef.current !== null) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    }

    // A new request replaces whatever the previous manual outcome explained
    // and any card still on screen.
    clearNotice();
    setSuggestion(null);
    suggestionIntentRef.current = null;
    const previous = activeControllerRef.current;
    if (previous !== null) previous.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    activeIntentRef.current = intent;
    inflightRef.current = true;
    setInflight(true);
    void runRequest(controller, latest.sessionId, intent);
  }

  /**
   * Perform and apply one suggestion request.
   *
   * @param controller - This request's abort controller.
   * @param requestSessionId - The session the request was issued for.
   * @param intent - Why it was sent (`"auto"` timer / `"manual"` click).
   */
  async function runRequest(
    controller: AbortController,
    requestSessionId: string,
    intent: DraftIntent,
  ): Promise<void> {
    const isCurrent = (): boolean =>
      mountedRef.current &&
      !controller.signal.aborted &&
      (intent !== "auto" || latestRef.current.autoEnabled) &&
      latestRef.current.sessionId === requestSessionId;

    try {
      const res = await fetch(SUGGEST_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: requestSessionId, intent }),
        signal: controller.signal,
      });
      if (!isCurrent() || !res.ok) return;

      const data = (await res.json().catch(() => null)) as unknown;
      if (!isCurrent() || !isRecord(data) || data.ok !== true) return;

      if (data.status === "disabled") {
        disabledRef.current.add(requestSessionId);
        if (latestRef.current.sessionId === requestSessionId) {
          // A manual ask that finds the feature off must not look like a dead
          // click: the notice explains it. An automatic `disabled` stays silent.
          if (intent === "manual") showNotice("disabled");
          setDisabled(true);
        }
        return;
      }
      if (data.status === "none") {
        // Manual `none` is the reported dead-button case: say so once, for a
        // few seconds. The automatic path keeps its documented silence.
        if (intent === "manual") showNotice("none");
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

      // Hold the answer for the hint card. The composer is untouched until
      // the user chooses Fill.
      suggestionIntentRef.current = intent;
      setSuggestion(text);
    } catch {
      // Aborted, offline or a malformed transport: a miss. The next idle (or
      // the button) may ask again.
    } finally {
      const active = activeControllerRef.current;
      // An obsolete response must not clear its successor's loading state.
      if (active === controller) {
        activeControllerRef.current = null;
        activeIntentRef.current = null;
        inflightRef.current = false;
        if (mountedRef.current) setInflight(false);
      }
    }
  }

  // Blank (no transcript) and subagent conversations have nothing to suggest.
  // The control stays mounted — the composer row must not reflow — but it is
  // inert; the tooltip still explains why.
  const unavailable = blank || subagent !== null || disabled;

  // The hint card is shown while a suggestion is held, the composer is still
  // empty and the session is idle. `suggestion` is also cleared by the effects
  // above (typing, new turn, session change) and by Fill/Dismiss, so these
  // guards are defensive: a stale render can never expose the card.
  const cardVisible = suggestion !== null && draft === "" && !running && !unavailable;
  // Any non-empty draft belongs to the user: only Fill ever writes one.
  const userDraft = draft !== "";

  let state: SuggestButtonState;
  let labelKey: SuggestKey;
  let titleKey: SuggestKey;
  let bodyKey: SuggestKey;
  if (inflight) {
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
  } else if (suggestion !== null) {
    // A card is open: the pill keeps its idle label and click action, and
    // explains the card through the ready copy. The tooltip itself is hidden
    // (see `data-hidden` below) so it cannot overlap the card.
    state = "idle";
    labelKey = "label.idle";
    titleKey = "title.ready";
    bodyKey = "body.ready";
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
  const eyebrow = copy("card.eyebrow");

  // A manual outcome's transient notice replaces the state copy in the tooltip
  // area for its short window. The `disabled` notice reuses the shipped
  // disabled title + config reason, because a `disabled` answer only ever comes
  // from the role/host config (the manual click is impossible in the blank,
  // subagent or user-draft disabled states).
  let tipTitle = title;
  let tipBody = body;
  if (notice === "none") {
    tipTitle = copy("notice.none");
    tipBody = copy("notice.none.body");
  } else if (notice === "disabled") {
    tipTitle = copy("title.disabled");
    tipBody = copy("body.disabled.config");
  }

  /** Fill: the ONLY path that writes a suggestion into the composer. */
  const onFill = (): void => {
    const text = suggestion;
    if (text === null) return;
    setSuggestion(null);
    inputActions.setDraft(text);
  };

  /** Dismiss: drop the card and write nothing. */
  const onDismiss = (): void => {
    setSuggestion(null);
  };

  const onActivate = (): void => {
    // A click is an explicit request: ask for the manual rule, never the
    // conservative automatic one.
    if (state === "idle") startRequest("manual");
  };

  const autoControls = (
    <div className={suggestClass.autoSettings}>
      <button
        type="button"
        className={suggestClass.autoToggle}
        role="switch"
        aria-label={copy("auto.label")}
        aria-checked={autoEnabled}
        onClick={() => setAutoSuggestEnabled(!latestRef.current.autoEnabled)}
      >
        <span>{copy("auto.label")}</span>
        <span className={suggestClass.autoState} aria-hidden="true">
          {copy(autoEnabled ? "auto.on" : "auto.off")}
          <span className={suggestClass.autoTrack} />
        </span>
      </button>
      <span className={suggestClass.autoDescription}>{copy("auto.description")}</span>
    </div>
  );

  return (
    <div
      className={suggestClass.root}
      data-rolebox-suggest
      data-state={state}
      data-notice={notice ?? undefined}
      data-has-suggestion={cardVisible ? "true" : undefined}
      data-popover-dismissed={popoverDismissed ? "true" : undefined}
      role="group"
      aria-label={copy("settings.title")}
      tabIndex={state === "idle" ? undefined : 0}
      onMouseEnter={() => setPopoverDismissed(false)}
      onFocus={() => setPopoverDismissed(false)}
      onKeyDown={(event: { key: string; preventDefault(): void; currentTarget: HTMLElement }) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setSuggestion(null);
        clearNotice();
        if (state === "idle") buttonRef.current?.focus();
        else event.currentTarget.focus();
        setPopoverDismissed(true);
      }}
    >
      <button
        type="button"
        ref={buttonRef}
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
      {cardVisible && suggestion !== null ? (
        <div
          className={suggestClass.card}
          ref={cardRef}
          role="group"
          aria-label={eyebrow}
          aria-live="polite"
        >
          <span className={suggestClass.cardEyebrow} aria-hidden="true">
            {eyebrow}
          </span>
          <span className={suggestClass.cardText}>{suggestion}</span>
          <div className={suggestClass.cardActions}>
            <button
              type="button"
              className={suggestClass.cardAction + " " + suggestClass.cardFill}
              onClick={onFill}
            >
              {copy("card.fill")}
            </button>
            <button
              type="button"
              className={suggestClass.cardAction + " " + suggestClass.cardDismiss}
              onClick={onDismiss}
            >
              {copy("card.dismiss")}
            </button>
          </div>
          {autoControls}
        </div>
      ) : null}
      <div
        className={suggestClass.tip}
        role="group"
        aria-label={copy("settings.title")}
        data-hidden={cardVisible ? "true" : undefined}
      >
        <div role="tooltip" id={tooltipId} data-hidden={cardVisible ? "true" : undefined}>
          <span className={suggestClass.tipTitle}>{tipTitle}</span>
          <span className={suggestClass.tipBody}>{tipBody}</span>
        </div>
        {!cardVisible ? autoControls : null}
      </div>
    </div>
  );
}
