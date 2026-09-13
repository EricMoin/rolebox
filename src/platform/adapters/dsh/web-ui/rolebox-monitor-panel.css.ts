/**
 * RoleboxMonitorPanel CSS — the rolebox monitoring section of the dsh
 * settings panel (`settings.section` slot).
 *
 * The panel answers an ATTENTION question ("does anything need me?"), so the
 * body leads with a derived verdict band and then lists evidence. This module
 * shares the dock's visual system (`role-switch-dock.css.ts`): one surface
 * token, the same 4pt spacing scale, the same radius set, the same chip
 * language, and the same 11/13/20px type tiers.
 *
 * Design posture:
 *   - Verdict first. `.rolebox-monitor-attention` is the panel's only focal
 *     point and is the first child of the body.
 *   - State is never coloured text. The host palette measures
 *     `state-success-primary` at 2.09:1 and `state-warn-primary` at 1.99:1 as
 *     marks on their own tints — both fail 3:1 for non-text. Green and amber
 *     therefore CANNOT be foreground marks here. State is a pale tint fill
 *     plus the normalised state WORD in `--dsw-alias-label-primary`; the raw
 *     backend phase string stays in the DOM beside it, so a user never has to
 *     memorise the phase vocabulary and an unknown phase degrades to a
 *     neutral treatment rather than to a false success or failure.
 *   - Reference data is demoted. Metrics and sessions cap their rows and sit
 *     last, so the page reads verdict -> identity -> detail.
 *   - Motion is meaningful only: the in-flight spinner (delayed 120ms so a
 *     fast refresh does not flash), the loading skeleton, hover and the
 *     metrics overflow toggle. The attention band deliberately has NO entrance
 *     animation — it re-renders on every refresh, and a repeated entrance
 *     animation is a banned anti-slop tell. The header seat is the live region
 *     that announces the verdict instead.
 *
 * Token discipline: this module may reference ONLY `--dsw-*` host tokens (the
 * monitor CSS-contract test does not whitelist the `--dsh-composer-*` frame
 * vars), and every `var(--rolebox-...)` CONSUMPTION must carry a comma and a
 * fallback so the bare-`var()` scan never flags it.
 *
 * Injection: identical guarded pattern to `role-switch-dock.css.ts` — a
 * `style[data-plugin-css=...]` probe plus a `document.head` append under a
 * `typeof document` guard.
 *
 * This module is BROWSER code: no node builtins, no DOM access outside the
 * guarded injection block.
 *
 * @module
 */

/** The namespaced CSS text injected into the document on module load. */
export const monitorCss = `
.rolebox-monitor {
  box-sizing: border-box;
  padding: 12px 16px;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);

  --rolebox-surface: var(--dsw-specific-tip, rgb(245, 246, 247));
  --rolebox-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-skeleton: var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04));
  --rolebox-surface-skeleton-hi: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-running: var(--dsw-alias-state-business-tertiary, rgb(228, 237, 253));
  --rolebox-surface-complete: var(--dsw-alias-state-success-tertiary, rgb(230, 250, 237));
  --rolebox-surface-blocked: var(--dsw-alias-state-warn-tertiary, rgb(254, 245, 231));
  --rolebox-surface-failed: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  --rolebox-border-hairline: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  --rolebox-border-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  --rolebox-border-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-ink: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  --rolebox-ink-muted: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
  --rolebox-ink-glyph: var(--dsw-alias-label-tertiary, rgb(129, 133, 140));
  --rolebox-ink-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-accent: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-focus-ring: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --rolebox-space-1: 4px;
  --rolebox-space-2: 8px;
  --rolebox-space-3: 12px;
  --rolebox-space-4: 16px;
  --rolebox-space-6: 24px;

  --rolebox-radius-chip: 6px;
  --rolebox-radius-control: 8px;
  --rolebox-radius-card: 12px;

  --rolebox-dur-instant: 90ms;
  --rolebox-dur-fast: 130ms;
  --rolebox-dur-base: 200ms;
  --rolebox-dur-exit: 160ms;
  /* The host's own curve (--ds-ease-in-out); shared with the dock so both
     rolebox surfaces move identically. */
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);
  --rolebox-shadow-raised: 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.06);
  --rolebox-shadow-sticky: 0 2px 4px rgba(0, 0, 0, 0.05), 0 8px 24px rgba(0, 0, 0, 0.1);
}

.rolebox-monitor-panel {
  width: 100%;
}

.rolebox-monitor-header {
  box-sizing: border-box;
  align-items: center;
  gap: var(--rolebox-space-3, 12px);
  padding-bottom: var(--rolebox-space-3, 12px);
  display: flex;
}

.rolebox-monitor-title {
  flex: none;
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-l-20);
}

.rolebox-monitor-refresh {
  box-sizing: border-box;
  flex: none;
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  height: 36px;
  padding: 0 var(--rolebox-space-3, 12px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  background: transparent;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-monitor-refresh:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-monitor-refresh:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-monitor-refresh:disabled {
  cursor: default;
  opacity: 0.45;
}

@keyframes rolebox-monitor-spin {
  0% {
    opacity: 0;
    transform: rotate(0deg);
  }
  1% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: rotate(360deg);
  }
}

.rolebox-monitor-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  border-radius: 999px;
  animation: rolebox-monitor-spin 800ms linear infinite;
  animation-delay: 120ms;
}

.rolebox-monitor-status {
  min-width: 0;
  flex: auto;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxs-12);
}

.rolebox-monitor-status-error {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  border-bottom: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
}

.rolebox-monitor-attention {
  box-sizing: border-box;
  align-items: flex-start;
  gap: var(--rolebox-space-3, 12px);
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  border-radius: var(--rolebox-radius-card, 12px);
  border: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: var(--rolebox-space-3, 12px);
  row-gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-attention-alert {
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  border-color: var(--rolebox-border-danger, rgb(236, 19, 19));
}

.rolebox-monitor-attention-calm {
  background: transparent;
  border-color: transparent;
  padding: 0;
}

.rolebox-monitor-attention-glyph {
  grid-row: 1 / span 2;
  align-self: start;
  width: 16px;
  height: 20px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  place-items: center;
  display: grid;
}

.rolebox-monitor-attention-alert .rolebox-monitor-attention-glyph {
  color: var(--rolebox-ink-danger, rgb(236, 19, 19));
}

.rolebox-monitor-attention-title {
  min-width: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-monitor-attention-detail {
  min-width: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  overflow-wrap: anywhere;
}

.rolebox-monitor-state {
  padding: var(--rolebox-space-4, 16px) 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
}

.rolebox-monitor-state-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  white-space: nowrap;
  clip-path: inset(50%);
}

.rolebox-monitor-state-error {
  box-sizing: border-box;
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  border: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-13);
  display: flex;
  align-items: center;
  gap: var(--rolebox-space-3, 12px);
}

.rolebox-monitor-error-text {
  min-width: 0;
  margin-right: var(--rolebox-space-2, 8px);
  overflow-wrap: anywhere;
}

.rolebox-monitor-retry {
  box-sizing: border-box;
  flex: none;
  height: 32px;
  padding: 0 var(--rolebox-space-3, 12px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  background: transparent;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: inherit;
  cursor: pointer;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-monitor-retry:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-monitor-retry:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-monitor-loading {
  padding-top: var(--rolebox-space-4, 16px);
}

@keyframes rolebox-monitor-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

.rolebox-monitor-skeleton {
  display: grid;
  gap: var(--rolebox-space-6, 24px);
}

.rolebox-monitor-skeleton-card {
  box-sizing: border-box;
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  border: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface, rgb(245, 246, 247));
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-skeleton-bar {
  height: 12px;
  border-radius: var(--rolebox-radius-chip, 6px);
  background:
    linear-gradient(
      90deg,
      var(--rolebox-surface-skeleton, rgba(0, 0, 0, 0.04)) 0%,
      var(--rolebox-surface-skeleton-hi, rgba(38, 49, 72, 0.06)) 50%,
      var(--rolebox-surface-skeleton, rgba(0, 0, 0, 0.04)) 100%
    );
  background-size: 200% 100%;
  animation: rolebox-monitor-shimmer 1400ms linear infinite;
}

.rolebox-monitor-skeleton-bar-wide {
  height: 16px;
  width: 40%;
}

.rolebox-monitor-skeleton-bar-half {
  width: 62%;
}

.rolebox-monitor-body {
  padding-top: var(--rolebox-space-4, 16px);
  display: grid;
  gap: var(--rolebox-space-6, 24px);
}

.rolebox-monitor-section {
  min-width: 0;
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-section-title {
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
  display: flex;
  align-items: baseline;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-section-count {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-graph {
  box-sizing: border-box;
  border: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface, rgb(245, 246, 247));
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-graph-head {
  align-items: center;
  gap: var(--rolebox-space-3, 12px);
  display: flex;
  justify-content: space-between;
}
.rolebox-monitor-graph-state {
  flex: none;
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: inline-flex;
}

.rolebox-monitor-graph-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-monitor-chip {
  box-sizing: border-box;
  flex: none;
  height: 20px;
  padding: 0 var(--rolebox-space-2, 8px);
  border-radius: var(--rolebox-radius-chip, 6px);
  align-items: center;
  display: inline-flex;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-monitor-chip-failed {
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  border: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
}

.rolebox-monitor-chip-blocked {
  background: var(--rolebox-surface-blocked, rgb(254, 245, 231));
}

.rolebox-monitor-chip-running {
  background: var(--rolebox-surface-running, rgb(228, 237, 253));
}

.rolebox-monitor-chip-complete {
  background: var(--rolebox-surface-complete, rgb(230, 250, 237));
}

.rolebox-monitor-chip-unknown {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}
.rolebox-monitor-chip-idle {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}
.rolebox-monitor-chip-stopped {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
}

.rolebox-monitor-phase {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rolebox-monitor-kv {
  margin: 0;
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-kv-row {
  align-items: baseline;
  gap: var(--rolebox-space-3, 12px);
  display: flex;
  justify-content: space-between;
}

.rolebox-monitor-kv-row dt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
}

.rolebox-monitor-kv-row dd {
  flex: none;
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-graph-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
}

.rolebox-monitor-loop {
  align-items: center;
  gap: var(--rolebox-space-3, 12px);
  padding: var(--rolebox-space-2, 8px) 0;
  display: flex;
}

.rolebox-monitor-loop-id {
  min-width: 0;
  flex: none;
  max-width: 32%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-monitor-loop-phase {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
}

.rolebox-monitor-loop-agent {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
}

.rolebox-monitor-loop-progress {
  flex: none;
  margin-left: auto;
  text-align: right;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-metric-group {
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-metric-group-title {
  margin: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
}

.rolebox-monitor-metric-name {
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  overflow-wrap: anywhere;
  white-space: normal;
  text-overflow: clip;
}

.rolebox-monitor-metric-value {
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

.rolebox-monitor-more {
  box-sizing: border-box;
  justify-self: start;
  height: 28px;
  margin-top: var(--rolebox-space-1, 4px);
  padding: 0 var(--rolebox-space-2, 8px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-chip, 6px);
  background: transparent;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  cursor: pointer;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-monitor-more:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-monitor-more:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-monitor-sessions {
  margin: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-monitor-spinner {
    display: none;
  }
  .rolebox-monitor-skeleton-bar {
    animation: none;
  }
  .rolebox-monitor-chip,
  .rolebox-monitor-refresh,
  .rolebox-monitor-retry,
  .rolebox-monitor-more {
    transition: none;
  }
}
`;

/** Plain class-name map — the `rolebox-monitor-` prefixed names used by the component. */
export const monitorClass = {
  panel: "rolebox-monitor-panel",
  header: "rolebox-monitor-header",
  title: "rolebox-monitor-title",
  refresh: "rolebox-monitor-refresh",
  spinner: "rolebox-monitor-spinner",
  status: "rolebox-monitor-status",
  statusError: "rolebox-monitor-status-error",
  state: "rolebox-monitor-state",
  stateError: "rolebox-monitor-state-error",
  stateSr: "rolebox-monitor-state-sr",
  errorText: "rolebox-monitor-error-text",
  attentionGlyph: "rolebox-monitor-attention-glyph",
  retry: "rolebox-monitor-retry",
  loading: "rolebox-monitor-loading",
  skeleton: "rolebox-monitor-skeleton",
  skeletonCard: "rolebox-monitor-skeleton-card",
  skeletonBar: "rolebox-monitor-skeleton-bar",
  skeletonBarWide: "rolebox-monitor-skeleton-bar-wide",
  skeletonBarHalf: "rolebox-monitor-skeleton-bar-half",
  body: "rolebox-monitor-body",
  attention: "rolebox-monitor-attention",
  attentionAlert: "rolebox-monitor-attention-alert",
  attentionCalm: "rolebox-monitor-attention-calm",
  attentionTitle: "rolebox-monitor-attention-title",
  attentionDetail: "rolebox-monitor-attention-detail",
  section: "rolebox-monitor-section",
  sectionTitle: "rolebox-monitor-section-title",
  sectionCount: "rolebox-monitor-section-count",
  graph: "rolebox-monitor-graph",
  graphHead: "rolebox-monitor-graph-head",
  graphState: "rolebox-monitor-graph-state",
  graphId: "rolebox-monitor-graph-id",
  phase: "rolebox-monitor-phase",
  chip: "rolebox-monitor-chip",
  chipFailed: "rolebox-monitor-chip-failed",
  chipBlocked: "rolebox-monitor-chip-blocked",
  chipStopped: "rolebox-monitor-chip-stopped",
  chipIdle: "rolebox-monitor-chip-idle",
  chipComplete: "rolebox-monitor-chip-complete",
  chipRunning: "rolebox-monitor-chip-running",
  chipUnknown: "rolebox-monitor-chip-unknown",
  kv: "rolebox-monitor-kv",
  kvRow: "rolebox-monitor-kv-row",
  graphMeta: "rolebox-monitor-graph-meta",
  loop: "rolebox-monitor-loop",
  loopId: "rolebox-monitor-loop-id",
  loopAgent: "rolebox-monitor-loop-agent",
  loopPhase: "rolebox-monitor-loop-phase",
  loopProgress: "rolebox-monitor-loop-progress",
  metricGroup: "rolebox-monitor-metric-group",
  metricGroupTitle: "rolebox-monitor-metric-group-title",
  metricName: "rolebox-monitor-metric-name",
  metricValue: "rolebox-monitor-metric-value",
  more: "rolebox-monitor-more",
  sessions: "rolebox-monitor-sessions",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors `role-switch-dock.css.ts`: probe for an already-injected style by its
// data-plugin-css marker, then append the style tag once. `typeof document`
// guards the non-DOM case (tests run in bun without a document global).
if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" +
      JSON.stringify("rolebox/RoleboxMonitorPanel") +
      "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/RoleboxMonitorPanel";
  tag.textContent = monitorCss;
  document.head.appendChild(tag);
}
