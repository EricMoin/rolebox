/**
 * RoleboxLogsPanel CSS — the rolebox LIVE LOG VIEW as a dsh RIGHT-SIDEBAR TAB
 * BODY (`sidebar.right.pane.tab` seat, keyed by the `rolebox-logs` tab type).
 *
 * The surface answers one question — "what is the platform saying right now?" —
 * so it is a LEDGER, not a dashboard: one row per record, a time, a level, a
 * channel and a message, and no chart anywhere. Everything above the rows is
 * chrome that says WHERE the records come from, HOW fresh they are and how to
 * stop the stream.
 *
 * Design posture (shared with the sibling monitor page):
 *   - The level is a CHIP, never coloured text. The host palette's state
 *     colours measure below 3:1 against their own tints, so each level is a
 *     tint fill plus the level WORD in `--dsw-alias-label-primary` — a reader
 *     who cannot separate the hues still reads the vocabulary. Measured
 *     against the real light tokens the words stay at label-primary contrast
 *     on every tint used here (the strongest tint is 8% alpha).
 *   - Every row is a three-lane grid (time | level | body) whose middle lane is
 *     a fixed small track; the body lane is `minmax(0, 1fr)` so a long message
 *     wraps inside the pane instead of widening it.
 *   - Silent blanks are banned: an absent code, scope or field list renders
 *     nothing rather than an empty chip, but the record itself always states
 *     its message and its channel.
 *   - Motion is meaningful only: the in-flight spinner (delayed 120ms so a fast
 *     poll does not flash) and hover. Nothing animates on its own.
 *   - No decorative edge stripes: a row's level is a chip and a tint, never a
 *     coloured left border (`border-left` is banned here, as in the monitor
 *     sheet).
 *
 * Token discipline: this module may reference ONLY `--dsw-*` host tokens, and
 * every `var(--rolebox-...)` CONSUMPTION must carry a comma and a fallback so
 * the bare-`var()` scan can never become a loophole for a private namespace.
 *
 * Injection: a `style[data-plugin-css=...]` probe plus a `document.head`
 * append under a `typeof document` guard — the same guarded pattern as the
 * dock and the monitor sheet. This module is BROWSER code: no node builtins,
 * no DOM access outside that guarded block.
 *
 * @module
 */

/** The namespaced CSS text injected into the document on module load. */
export const logsCss = `
.rolebox-logs {
  box-sizing: border-box;
  padding: 12px 8px;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);

  --rolebox-logs-surface: var(--dsw-specific-tip, rgb(245, 246, 247));
  --rolebox-logs-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-logs-border: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  --rolebox-logs-border-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  --rolebox-logs-ink-muted: var(--dsw-alias-label-secondary, rgba(15, 17, 21, 0.6));
  --rolebox-logs-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-logs-warn: var(--dsw-alias-state-warn-primary, rgb(224, 145, 0));
  --rolebox-logs-ok: var(--dsw-alias-state-success-primary, rgb(0, 160, 90));
  --rolebox-logs-info: var(--dsw-alias-state-info-primary, rgb(40, 110, 220));
  --rolebox-logs-radius: var(--dsw-alias-border-radius-m, 6px);
  --rolebox-logs-ease: var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-logs-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.rolebox-logs-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.rolebox-logs-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.rolebox-logs-title {
  margin: 0;
  font: var(--dsw-font-s-strong-14, 600 14px/20px system-ui);
}

.rolebox-logs-live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  flex: none;
}

.rolebox-logs-live-dot-on {
  background: var(--rolebox-logs-ok, rgb(0, 160, 90));
}

.rolebox-logs-live-dot-pending {
  background: var(--rolebox-logs-warn, rgb(224, 145, 0));
}

.rolebox-logs-live-dot-off {
  background: var(--rolebox-logs-border-strong, rgba(0, 0, 0, 0.12));
}

.rolebox-logs-live-label {
  color: var(--dsw-alias-label-primary);
}

.rolebox-logs-live-time {
  font-variant-numeric: tabular-nums;
}

.rolebox-logs-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.rolebox-logs-select {
  max-width: 100%;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--rolebox-logs-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-logs-radius, 6px);
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--rolebox-logs-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-logs-radius, 6px);
  background: var(--rolebox-logs-surface, rgb(245, 246, 247));
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
  cursor: pointer;
  transition: background 120ms var(--rolebox-logs-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-logs-button:hover {
  background: var(--rolebox-logs-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-logs-button:disabled {
  cursor: default;
  opacity: 0.65;
}

.rolebox-logs-button[aria-pressed="true"] {
  border-color: var(--rolebox-logs-info, rgb(40, 110, 220));
}

.rolebox-logs-button-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex: none;
}

.rolebox-logs-spinner {
  width: 10px;
  height: 10px;
  flex: none;
  border: 1.5px solid var(--rolebox-logs-border-strong, rgba(0, 0, 0, 0.12));
  border-top-color: var(--rolebox-logs-info, rgb(40, 110, 220));
  border-radius: 50%;
  animation: rolebox-logs-spin 700ms linear 120ms infinite;
}

@keyframes rolebox-logs-spin {
  to {
    transform: rotate(360deg);
  }
}

.rolebox-logs-source {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-source-path {
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 100%;
}

.rolebox-logs-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-fact {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  min-width: 0;
}

.rolebox-logs-fact-label {
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
}

.rolebox-logs-fact-value {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}

.rolebox-logs-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rolebox-logs-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 6px;
  align-items: baseline;
  padding: 3px 4px;
  border-radius: var(--rolebox-logs-radius, 6px);
  border-bottom: 1px solid var(--rolebox-logs-border, rgba(0, 0, 0, 0.04));
}

.rolebox-logs-row:hover {
  background: var(--rolebox-logs-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-logs-time {
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rolebox-logs-level {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  padding: 0 5px;
  border-radius: var(--rolebox-logs-radius, 6px);
  border: 1px solid var(--rolebox-logs-border, rgba(0, 0, 0, 0.04));
  background: var(--rolebox-logs-surface, rgb(245, 246, 247));
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.rolebox-logs-level-debug {
  background: color-mix(in srgb, var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6)) 8%, transparent);
}

.rolebox-logs-level-info {
  background: color-mix(in srgb, var(--rolebox-logs-info, rgb(40, 110, 220)) 8%, transparent);
}

.rolebox-logs-level-warn {
  background: color-mix(in srgb, var(--rolebox-logs-warn, rgb(224, 145, 0)) 8%, transparent);
}

.rolebox-logs-level-error {
  background: color-mix(in srgb, var(--rolebox-logs-danger, rgb(236, 19, 19)) 8%, transparent);
}

.rolebox-logs-level-fatal {
  background: color-mix(in srgb, var(--rolebox-logs-danger, rgb(236, 19, 19)) 8%, transparent);
  border-color: var(--rolebox-logs-danger, rgb(236, 19, 19));
}

.rolebox-logs-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.rolebox-logs-message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rolebox-logs-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 8px;
  min-width: 0;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-channel,
.rolebox-logs-code,
.rolebox-logs-scope,
.rolebox-logs-fields {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rolebox-logs-code {
  color: var(--dsw-alias-label-primary);
}

.rolebox-logs-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 8px;
}

.rolebox-logs-empty-icon {
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
}

.rolebox-logs-empty-title {
  font: var(--dsw-font-s-strong-14, 600 14px/20px system-ui);
}

.rolebox-logs-empty-hint {
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
}

.rolebox-logs-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--rolebox-logs-danger, rgb(236, 19, 19));
  border-radius: var(--rolebox-logs-radius, 6px);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
}

.rolebox-logs-error-glyph {
  display: inline-flex;
  align-items: center;
  color: var(--rolebox-logs-danger, rgb(236, 19, 19));
  flex: none;
}

.rolebox-logs-error-text {
  flex: 1 1 120px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.rolebox-logs-state {
  margin: 0;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
}

.rolebox-logs-state-error {
  color: var(--dsw-alias-label-primary);
}

.rolebox-logs-retry {
  padding: 2px 8px;
  border: 1px solid var(--rolebox-logs-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-logs-radius, 6px);
  background: var(--rolebox-logs-surface, rgb(245, 246, 247));
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
  cursor: pointer;
}

.rolebox-logs-status {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-status-error {
  color: var(--dsw-alias-label-primary);
}

.rolebox-logs-more {
  color: var(--rolebox-logs-ink-muted, rgba(15, 17, 21, 0.6));
  font: var(--dsw-font-xxs-11, 11px/16px system-ui);
}

.rolebox-logs-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;

/** The class names the panel component applies, one place per name. */
export const logsClass = {
  root: "rolebox-logs",
  panel: "rolebox-logs-panel",
  header: "rolebox-logs-header",
  titleRow: "rolebox-logs-title-row",
  title: "rolebox-logs-title",
  live: "rolebox-logs-live",
  liveDot: "rolebox-logs-live-dot",
  liveDotOn: "rolebox-logs-live-dot-on",
  liveDotPending: "rolebox-logs-live-dot-pending",
  liveDotOff: "rolebox-logs-live-dot-off",
  liveLabel: "rolebox-logs-live-label",
  liveTime: "rolebox-logs-live-time",
  controls: "rolebox-logs-controls",
  select: "rolebox-logs-select",
  button: "rolebox-logs-button",
  buttonGlyph: "rolebox-logs-button-glyph",
  spinner: "rolebox-logs-spinner",
  source: "rolebox-logs-source",
  sourcePath: "rolebox-logs-source-path",
  facts: "rolebox-logs-facts",
  fact: "rolebox-logs-fact",
  factLabel: "rolebox-logs-fact-label",
  factValue: "rolebox-logs-fact-value",
  list: "rolebox-logs-list",
  row: "rolebox-logs-row",
  time: "rolebox-logs-time",
  level: "rolebox-logs-level",
  levelDebug: "rolebox-logs-level-debug",
  levelInfo: "rolebox-logs-level-info",
  levelWarn: "rolebox-logs-level-warn",
  levelError: "rolebox-logs-level-error",
  levelFatal: "rolebox-logs-level-fatal",
  body: "rolebox-logs-body",
  message: "rolebox-logs-message",
  meta: "rolebox-logs-meta",
  channel: "rolebox-logs-channel",
  code: "rolebox-logs-code",
  scope: "rolebox-logs-scope",
  fields: "rolebox-logs-fields",
  empty: "rolebox-logs-empty",
  emptyIcon: "rolebox-logs-empty-icon",
  emptyTitle: "rolebox-logs-empty-title",
  emptyHint: "rolebox-logs-empty-hint",
  error: "rolebox-logs-error",
  errorGlyph: "rolebox-logs-error-glyph",
  errorText: "rolebox-logs-error-text",
  state: "rolebox-logs-state",
  stateError: "rolebox-logs-state-error",
  retry: "rolebox-logs-retry",
  status: "rolebox-logs-status",
  statusError: "rolebox-logs-status-error",
  more: "rolebox-logs-more",
  srOnly: "rolebox-logs-sr",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Probe for an already-injected style by its data-plugin-css marker, then
// append the style tag once. typeof document guards the non-DOM case (tests run
// in bun without a document global).
if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" +
      JSON.stringify("rolebox/RoleboxLogsPanel") +
      "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/RoleboxLogsPanel";
  tag.textContent = logsCss;
  document.head.appendChild(tag);
}
