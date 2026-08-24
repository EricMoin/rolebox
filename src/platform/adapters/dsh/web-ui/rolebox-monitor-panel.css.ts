/**
 * RoleboxMonitorPanel CSS — namespaced settings-page styling for the
 * monitoring panel (`rolebox-monitor-panel.tsx`).
 *
 * The panel renders inside the dsh settings panel (`settings.section`
 * slot), so the styles here follow the same design-token discipline as the
 * dock contribution (`role-switch-dock.css.ts`): a `rolebox-monitor-`
 * prefixed namespace, colors/layout driven entirely by the `--dsw-*` alias
 * set of the dsh web app (no hardcoded colors, no new `--dsh-*` tokens),
 * and the shipped dock-row vocabulary (13px primary/tertiary text, the
 * `--dsw-alias-border-l1` hairline, `--dsw-alias-interactive-bg-hover`
 * hover, `--dsw-alias-state-error-primary` errors, focus-visible rings in
 * the `--dsw-alias-label-tertiary` focus language).
 *
 * Layout highlights:
 *   - `.rolebox-monitor` — the settings-page seat: inset padding, primary
 *     text color, the dock's 13px font.
 *   - `.rolebox-monitor-header` — the page head row (title + Refresh
 *     control + live-region status seat); the seat is `flex: auto`,
 *     right-aligned, ellipsized, and turns error-colored via
 *     `.rolebox-monitor-status-error`.
 *   - `.rolebox-monitor-state` — the loading / empty seat; the error
 *     variant (`.rolebox-monitor-state-error`) pairs the alert text with a
 *     Retry button (`.rolebox-monitor-retry`).
 *   - `.rolebox-monitor-body` — the section stack (grid gap).
 *   - `.rolebox-monitor-graph` — one engine-graph card: bordered rounded
 *     block holding the head (id + phase badge) and a definition list.
 *   - `.rolebox-monitor-kv-row` — the shared definition-list row (label
 *     left, value right) used by graph cards, counters, and gauges.
 *   - `.rolebox-monitor-loop` — the loop row (id / agent / phase /
 *     right-aligned round progress).
 *   - `.rolebox-monitor-metric-name` / `.rolebox-monitor-metric-value` —
 *     monospace readings for counter/gauge/histogram names and values.
 *
 * Injection: the module injects the CSS into the document on load using the
 * exact pattern the dsh client packages ship (mirror of
 * `role-switch-dock.css.ts`): a guarded `style[data-plugin-css=...]` probe
 * plus a `document.head` append with the `data-plugin` / `data-plugin-css`
 * markers. The `typeof document` guard keeps module load safe in non-DOM
 * environments (the tests mock react and run in bun without a DOM —
 * `document` is undefined there and the block is skipped).
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
}

.rolebox-monitor-panel {
  width: 100%;
}

.rolebox-monitor-header {
  box-sizing: border-box;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  display: flex;
}

.rolebox-monitor-title {
  flex: none;
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
}

.rolebox-monitor-refresh {
  box-sizing: border-box;
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

.rolebox-monitor-refresh:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.rolebox-monitor-refresh:focus-visible {
  outline: 2px solid var(--dsw-alias-label-tertiary);
  outline-offset: -2px;
}

.rolebox-monitor-refresh:disabled {
  cursor: default;
  opacity: 0.45;
}

.rolebox-monitor-status {
  min-width: 0;
  flex: auto;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-monitor-status-error {
  color: var(--dsw-alias-state-error-primary);
}

.rolebox-monitor-state {
  padding: 16px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-monitor-state-error {
  color: var(--dsw-alias-state-error-primary);
}

.rolebox-monitor-error-text {
  margin-right: 10px;
}

.rolebox-monitor-retry {
  box-sizing: border-box;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

.rolebox-monitor-retry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.rolebox-monitor-retry:focus-visible {
  outline: 2px solid var(--dsw-alias-label-tertiary);
  outline-offset: -2px;
}

.rolebox-monitor-body {
  padding-top: 4px;
  display: grid;
  gap: 16px;
}

.rolebox-monitor-section {
  min-width: 0;
  display: grid;
  gap: 6px;
}

.rolebox-monitor-section-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

.rolebox-monitor-graph {
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 8px 10px;
  display: grid;
  gap: 6px;
}

.rolebox-monitor-graph-head {
  align-items: center;
  gap: 10px;
  display: flex;
  justify-content: space-between;
}

.rolebox-monitor-graph-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-monitor-phase {
  flex: none;
  color: var(--dsw-alias-state-business-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-monitor-kv {
  margin: 0;
  display: grid;
  gap: 2px;
}

.rolebox-monitor-kv-row {
  align-items: baseline;
  gap: 10px;
  display: flex;
  justify-content: space-between;
}

.rolebox-monitor-kv-row dt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-monitor-kv-row dd {
  flex: none;
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-monitor-graph-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
}

.rolebox-monitor-loop {
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  display: flex;
}

.rolebox-monitor-loop-id {
  min-width: 0;
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-monitor-loop-agent {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-monitor-loop-phase {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-monitor-loop-progress {
  flex: auto;
  text-align: right;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-monitor-metric-group {
  display: grid;
  gap: 4px;
}

.rolebox-monitor-metric-group-title {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.rolebox-monitor-metric-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.rolebox-monitor-metric-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.rolebox-monitor-sessions {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}
`;

/** Plain class-name map — the `rolebox-monitor-` prefixed names used by the component. */
export const monitorClass = {
  panel: "rolebox-monitor-panel",
  header: "rolebox-monitor-header",
  title: "rolebox-monitor-title",
  refresh: "rolebox-monitor-refresh",
  status: "rolebox-monitor-status",
  statusError: "rolebox-monitor-status-error",
  state: "rolebox-monitor-state",
  stateError: "rolebox-monitor-state-error",
  errorText: "rolebox-monitor-error-text",
  retry: "rolebox-monitor-retry",
  body: "rolebox-monitor-body",
  section: "rolebox-monitor-section",
  sectionTitle: "rolebox-monitor-section-title",
  graph: "rolebox-monitor-graph",
  graphHead: "rolebox-monitor-graph-head",
  graphId: "rolebox-monitor-graph-id",
  phase: "rolebox-monitor-phase",
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
  sessions: "rolebox-monitor-sessions",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors the shipped guard+append of QueueDock.module.css (client.js:
// 6318-6323) and the sibling `role-switch-dock.css.ts`: probe for an
// already-injected style by its data-plugin-css marker, then append the
// style tag once. `typeof document` guards the non-DOM case (tests run in
// bun without a document global).
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
