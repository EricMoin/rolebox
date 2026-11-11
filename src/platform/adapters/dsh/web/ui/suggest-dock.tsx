/**
 * SuggestDock — the composer draft-suggestion button in the dsh composer tool
 * row (browser half).
 *
 * The component contributes to `'conversation.input.right'`, the session-scoped
 * list seat immediately left of the model selector. It is a 28px-high pill —
 * sparkle glyph plus a short localized action label. Hover and keyboard focus
 * expose only the mode settings; request results appear separately:
 *
 *   - idle (the session is not running, the draft is empty, the session is not
 *     blank and not a subagent) — one click asks the host for a draft with
 *     `intent: "manual"` (the host may abstain when no useful draft exists);
 *   - the automatic path — after a turn ends (`running` true -> false) with a
 *     plain input phase and an empty draft, the component waits
 *     {@link SUGGEST_DELAY_MS} and then asks ONCE with `intent: "auto"` (the
 *     conservative rule: a `none` answer is legitimate). A `none` answer is
 *     final for that idle and mode: the next turn or a mode change can ask again.
 *     The user can always ask again with the button;
 *   - loading — the single request is in flight and the button is disabled;
 *   - suggestion ready — a `suggested` answer is held in component state and
 *     rendered as a HINT CARD above the pill: a small eyebrow, the text and
 *     two real buttons, Fill (`inputActions.setDraft(text)`) and Dismiss.
 *     In suggestion modes, nothing is written until Fill. The pill gains
 *     an accent while the card is open; the settings panel is hidden so it cannot
 *     overlap the card. The card clears on Fill, Dismiss, typing (any
 *     non-empty draft), a new turn (`running` true), a session change or
 *     unmount, and never reappears for the same idle;
 *   - full automation — automatic answers use `setDraft` and `submit` to send
 *     through the host's normal composer pipeline; manual asks still show a card;
 *   - draft non-empty or attachments present — the user owns the composer;
 *     the button is disabled and never overwrites or submits that content.
 *
 * The host contract is `POST /rolebox/copilot/suggest` with
 * `{ session: string, intent?: "auto" | "manual" }`:
 *
 *   - `200 { ok: true, status: "suggested", text, model, ms }` — show a card,
 *     or submit an automatic answer requested in full automation mode;
 *   - `200 { ok: true, status: "none" }` — nothing sensible to offer;
 *   - `200 { ok: true, status: "disabled", reason }` — the feature is off for
 *     this role/profile. That answer is remembered per session id and stops
 *     every further request for it.
 *
 * A MANUAL ask that ends in `none` or `disabled` must not look like a dead
 * button: the component raises a transient notice for {@link SUGGEST_NOTICE_MS}
 * in a separate status card.
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
 * The hover/focus panel offers four browser-local modes: off,
 * manual suggestions, automatic suggestions (default), and full automation.
 * A mode change cancels obsolete automatic work; off also cancels manual work.
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
import type { DraftIntent } from "../../../../../copilot/draft/prompt.ts";
import { suggestClass } from "./suggest-dock.css.ts";
import { en as suggestEn, type SuggestKey } from "./suggest-locales.ts";
import {
  COPILOT_MODES,
  getCopilotMode,
  isAutomaticMode,
  isCopilotMode,
  setCopilotMode,
  subscribeCopilotMode,
  type CopilotMode,
} from "./suggest-preferences.ts";

/** `POST /rolebox/copilot/suggest` — same-origin relative path on the dsh web server. */
export const SUGGEST_ENDPOINT = "/rolebox/copilot/suggest";

/** Delay between the session going idle and the automatic request (ms). */
export const SUGGEST_DELAY_MS = 300;

/** How long a manual request's transient notice stays visible (ms). */
export const SUGGEST_NOTICE_MS = 4_000;

/**
 * Monotonic description-id source. A module-level counter rather than `useId`:
 * the structural react stub in this directory exposes only
 * `useState`/`useEffect`/`useRef`.
 */
let descriptionSequence = 0;

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
  /** Attachments belong to the user even when the text draft is empty. */
  attachmentIds?: readonly unknown[];
  /** An intervening edit invalidates a request even if the text is empty again. */
  draftRev?: number;
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
  /** Stable composer actions; submission keeps host admission and error handling. */
  inputActions: { setDraft(text: string): void; submit?(): void };
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
  const attachmentCount = useInput((state) => state.attachmentIds?.length ?? 0);
  const draftRev = useInput((state) => state.draftRev ?? 0);

  /** True while our single request is in flight. */
  const [inflight, setInflight] = useState(false);
  /** The last answer held for the user to review in a hint card. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** True after the host answered `disabled` for the current session id. */
  const [disabled, setDisabled] = useState(false);
  /** A manual request's transient explanation; `null` when none is showing. */
  const [notice, setNotice] = useState<SuggestNotice | null>(null);
  const [mode, setMode] = useState(getCopilotMode);
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
  const rootRef = useRef<HTMLDivElement | null>(null);
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
    mode,
    attachmentCount,
    draftRev,
  });
  latestRef.current = { sessionId, draft, phase, running, blank, subagent, mode, attachmentCount, draftRev };

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
   * Never called for an automatic request; the status card takes no focus.
   */
  function showNotice(kind: SuggestNotice): void {
    if (!mountedRef.current) return;
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    setNotice(kind);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      if (mountedRef.current) {
        setPopoverDismissed(true);
        setNotice(null);
      }
    }, SUGGEST_NOTICE_MS);
  }

  /** Disabled reasons remain available to screen readers without a hover explainer. */
  const descriptionIdRef = useRef<string | null>(null);
  const descriptionId =
    descriptionIdRef.current ?? `rolebox-suggest-description-${++descriptionSequence}`;
  if (descriptionIdRef.current === null) descriptionIdRef.current = descriptionId;

  function dismissResult(): void {
    cancelRequest();
    clearNotice();
    const card = cardRef.current;
    if (card !== null && typeof document !== "undefined" && card.contains(document.activeElement)) {
      rootRef.current?.focus();
    }
    setSuggestion(null);
    // Focus restoration must not reveal the settings underneath a closing card.
    setPopoverDismissed(true);
  }

  useEffect(() => subscribeCopilotMode((nextMode) => {
    if (latestRef.current.mode !== nextMode) {
      // Invalidate immediately, including two preference changes before React commits.
      if (activeIntentRef.current === "auto" || nextMode === "none") cancelRequest();
      if (autoTimerRef.current !== null) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      latestRef.current.mode = nextMode;
    }
    setMode(nextMode);
  }), []);

  useEffect(() => {
    autoRequestedRef.current = activeIntentRef.current === "manual" || suggestionIntentRef.current === "manual";
    if (activeIntentRef.current === "auto" || mode === "none") cancelRequest();
    if (suggestionIntentRef.current === "auto" || mode === "none") {
      suggestionIntentRef.current = null;
      setSuggestion(null);
      // Closing a card must not strand keyboard focus on its mode selector.
      const card = cardRef.current;
      if (card !== null && typeof document !== "undefined" && card.contains(document.activeElement)) {
        if (mode === "none") rootRef.current?.focus();
        else buttonRef.current?.focus();
      }
    }
    clearNotice();
  }, [mode]);

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
    if (draft !== "" || attachmentCount > 0 || running || phase !== "plain") {
      suggestionIntentRef.current = null;
      setSuggestion(null);
    }
  }, [draft, attachmentCount, running, phase, draftRev]);

  // The transient manual notice belongs to the state it explains. Any later
  // state change the user can observe — typing, a new turn, a session switch,
  // the session going blank/subagent, or the phase leaving `plain` — clears it.
  // `disabled` is deliberately absent: a manual request's OWN `disabled` answer
  // arrives with that flag and must keep its notice.
  useEffect(() => {
    clearNotice();
  }, [sessionId, running, draft, phase, blank, subagent, attachmentCount, draftRev]);

  // Session/input invalidation cancels either intent. Keep it separate from
  // mode changes so switching between enabled modes preserves manual work.
  useEffect(() => () => cancelRequest(), [sessionId, running, phase, draft, blank, subagent, disabled, attachmentCount, draftRev]);

  // Spend at most one automatic request per idle and selected mode.
  useEffect(() => {
    if (running) autoRequestedRef.current = false;

    const canAutoRequest =
      isAutomaticMode(mode) &&
      !running &&
      !blank &&
      subagent === null &&
      !disabled &&
      phase === "plain" &&
      draft === "" &&
      attachmentCount === 0 &&
      !inflightRef.current &&
      suggestionIntentRef.current !== "manual" &&
      !autoRequestedRef.current;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (canAutoRequest) {
      // Spend this idle's one automatic request at scheduling time: even if the
      // answer is `none` (or the schedule is cancelled by a keystroke), the
      // same idle and selected mode never fire again.
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
  }, [sessionId, running, phase, draft, blank, subagent, disabled, mode, attachmentCount, draftRev]);

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
    if (latest.phase !== "plain" || latest.draft !== "" || latest.attachmentCount > 0) return;
    if (disabledRef.current.has(latest.sessionId)) return;
    if (latest.mode === "none") return;
    if (intent === "auto" && !isAutomaticMode(latest.mode)) return;
    if (inflightRef.current) return;
    if (intent === "manual") {
      autoRequestedRef.current = true;
      if (autoTimerRef.current !== null) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    }

    // A refresh keeps its existing card until the replacement is ready.
    clearNotice();
    if (intent === "manual") {
      setPopoverDismissed(true);
    } else {
      setSuggestion(null);
      suggestionIntentRef.current = null;
    }
    const previous = activeControllerRef.current;
    if (previous !== null) previous.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    activeIntentRef.current = intent;
    inflightRef.current = true;
    setInflight(true);
    void runRequest(controller, latest.sessionId, intent, latest.mode, latest.draftRev);
  }

  /**
   * Perform and apply one suggestion request.
   *
   * @param controller - This request's abort controller.
   * @param requestSessionId - The session the request was issued for.
   * @param intent - Why it was sent (`"auto"` timer / `"manual"` click).
   * @param requestMode - Prevents a mode change from promoting an older answer.
   * @param requestDraftRev - Detects edits even when the user has erased the text.
   */
  async function runRequest(
    controller: AbortController,
    requestSessionId: string,
    intent: DraftIntent,
    requestMode: CopilotMode,
    requestDraftRev: number,
  ): Promise<void> {
    const isCurrent = (): boolean =>
      mountedRef.current &&
      !controller.signal.aborted &&
      activeControllerRef.current === controller &&
      latestRef.current.mode !== "none" &&
      (intent !== "auto" || latestRef.current.mode === requestMode) &&
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
        setSuggestion(null);
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
        setSuggestion(null);
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
        latest.attachmentCount > 0 ||
        latest.draftRev !== requestDraftRev ||
        latest.phase !== "plain" ||
        latest.running ||
        latest.blank ||
        latest.subagent !== null
      ) {
        return;
      }

      if (intent === "auto" && requestMode === "auto-mated" && inputActions.submit) {
        inputActions.setDraft(text);
        inputActions.submit();
        return;
      }

      // Manual asks always stay reviewable, even in full automation mode.
      // Hosts without a submit action also degrade to a reviewable card.
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
  // inert; its accessible description still explains why.
  const unavailable = blank || subagent !== null || disabled || mode === "none";

  // The hint card is shown while a suggestion is held, the composer is still
  // empty and the session is idle. `suggestion` is also cleared by the effects
  // above (typing, new turn, session change) and by Fill/Dismiss, so these
  // guards are defensive: a stale render can never expose the card.
  const cardVisible = suggestion !== null && draft === "" && attachmentCount === 0 && phase === "plain" && !running && !unavailable;
  const noticeVisible = notice !== null && draft === "" && attachmentCount === 0 && phase === "plain" && !running && mode !== "none";
  const resultVisible = cardVisible || noticeVisible;
  // Existing text and attachments always belong to the user.
  const userDraft = draft !== "" || attachmentCount > 0;

  let state: SuggestButtonState;
  let labelKey: SuggestKey;
  let titleKey: SuggestKey;
  let bodyKey: SuggestKey | undefined;
  if (inflight) {
    state = "loading";
    labelKey = "label.loading";
    titleKey = "title.loading";
  } else if (unavailable || userDraft) {
    state = "disabled";
    labelKey = "label.idle";
    titleKey = "title.disabled";
    // One body per reason, in the precedence the component applies it.
    if (blank) bodyKey = "body.disabled.blank";
    else if (subagent !== null) bodyKey = "body.disabled.subagent";
    else if (disabled) bodyKey = "body.disabled.config";
    else if (mode === "none") bodyKey = "body.disabled.mode";
    else if (attachmentCount > 0) bodyKey = "body.disabled.attachments";
    else bodyKey = "body.disabled.draft";
  } else if (suggestion !== null) {
    // A card is open: the pill keeps its idle label and click action, and
    // explains the card through its accessible label.
    state = "idle";
    labelKey = "label.idle";
    titleKey = "title.ready";
  } else {
    state = "idle";
    labelKey = "label.idle";
    titleKey = mode === "auto-mated" ? "title.automated" : "title.idle";
  }
  if (labelKey === "label.idle" && mode === "auto-mated") labelKey = "label.automated";

  // The `t` seat is optional: the unit-test harness (and a host without the
  // locale namespace) falls back to the shipped English copy.
  const copy = (key: SuggestKey): string => t?.(key) ?? suggestEn[key] ?? key;
  const label = copy(labelKey);
  const title = copy(titleKey);
  const description = bodyKey === undefined ? undefined : copy(bodyKey);
  const eyebrow = copy("card.eyebrow");

  /** Fill leaves submission to the user, including in full automation mode. */
  const onFill = (): void => {
    const text = suggestion;
    if (text === null) return;
    const latest = latestRef.current;
    if (latest.mode === "none" || latest.running || latest.draft !== "" || latest.attachmentCount > 0 || latest.phase !== "plain") return;
    dismissResult();
    inputActions.setDraft(text);
  };

  /** Dismiss: drop the card and write nothing. */
  const onDismiss = (): void => {
    dismissResult();
  };

  const onActivate = (): void => {
    // A click is an explicit request: ask for the manual rule, never the
    // conservative automatic one.
    if (state === "idle") startRequest("manual");
  };

  const modeControls = (
    <div className={suggestClass.modeSettings}>
      <label className={suggestClass.modeLabel}>
        <span>{copy("mode.label")}</span>
        <select
          className={suggestClass.modeSelect}
          aria-label={copy("mode.label")}
          value={mode}
          onChange={(event: { currentTarget: HTMLSelectElement }) => {
            const value = event.currentTarget.value;
            if (isCopilotMode(value)) setCopilotMode(value);
          }}
        >
          {COPILOT_MODES.map((value) => <option key={value} value={value}>{copy(`mode.${value}`)}</option>)}
        </select>
      </label>
      <span className={suggestClass.modeDescription}>{copy(`mode.${mode}.description`)}</span>
    </div>
  );

  return (
    <div
      className={suggestClass.root}
      ref={rootRef}
      data-rolebox-suggest
      data-mode={mode}
      data-state={state}
      data-notice={notice ?? undefined}
      data-has-suggestion={cardVisible ? "true" : undefined}
      data-has-result={resultVisible ? "true" : undefined}
      data-popover-dismissed={popoverDismissed ? "true" : undefined}
      role="group"
      aria-label={copy("settings.title")}
      tabIndex={state === "idle" ? -1 : 0}
      onMouseEnter={() => setPopoverDismissed(false)}
      onFocus={(event: { currentTarget: HTMLElement; relatedTarget: Node | null }) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPopoverDismissed(false);
      }}
      onKeyDown={(event: { key: string; preventDefault(): void; currentTarget: HTMLElement }) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (resultVisible || activeIntentRef.current === "manual") dismissResult();
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
        aria-describedby={description === undefined ? undefined : descriptionId}
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
      {description !== undefined ? <span className={suggestClass.srOnly} id={descriptionId}>{description}</span> : null}
      {cardVisible && suggestion !== null ? (
        <div
          className={suggestClass.card}
          ref={cardRef}
          role="group"
          aria-label={eyebrow}
          aria-live="polite"
          aria-busy={inflight ? true : undefined}
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
        </div>
      ) : null}
      {noticeVisible ? (
        <div className={suggestClass.notice} role="status">
          <span className={suggestClass.noticeTitle}>
            {copy(notice === "none" ? "notice.none" : "title.disabled")}
          </span>
          <span className={suggestClass.noticeBody}>
            {copy(notice === "none" ? "notice.none.body" : "body.disabled.config")}
          </span>
        </div>
      ) : null}
      <div
        className={suggestClass.tip}
        role="group"
        aria-label={copy("settings.title")}
        data-hidden={resultVisible || popoverDismissed ? "true" : undefined}
      >
        {modeControls}
      </div>
    </div>
  );
}
