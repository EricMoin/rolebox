/**
 * RoleSwitchDock CSS — namespaced replicas of the dsh dock-row styling.
 *
 * The dock contribution (`role-switch-dock.tsx`) renders its picker with the
 * same visual posture as the shipped dsh dock strips, so the styles here are
 * faithful re-implementations of the reference rules in
 * `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`:
 *
 *   - `.rolebox-dock`            — QueueDock's `.dock` outer seat
 *     (client.js:6316, `_7yHdaG_dock`): box-sizing, the composer-relative
 *     width/max-width/margin/padding (side clearance + dock inset +
 *     stack-gap overhang), `flex: none` so the slot list keeps the dock on
 *     its own row above the composer card.
 *   - `.rolebox-dock-panel`      — QueueDock's `.panel` (same line): the
 *     tip-colored inner panel with the open-bottom radius
 *     (`12px 12px 0 0`) and the `::after` inset hairline (1px
 *     `--dsw-alias-border-l1`, border-bottom omitted — the composer card
 *     below closes the edge).
 *   - `.rolebox-dock-header`     — QueueDock's `.header` (same line): the
 *     36px toggle row (lead seat, title, status seat).
 *   - `.rolebox-dock-title` / `.rolebox-dock-status` — TodoPanel's
 *     `.title` / `.progress` seats (client.js:6109, `lXshSW_title` /
 *     `lXshSW_progress`): 13px/500 primary title, flex-auto 13px/400
 *     tertiary status text with ellipsis.
 *   - `.rolebox-dock-list` / `.rolebox-dock-row` — QueueDock's `.list` /
 *     `.row` (client.js:6316): the bounded (max-height 180px) scroll list
 *     and the 36px rows with the `row + row` inset divider, hover
 *     background and focus-visible outline.
 *
 * Injection: the module injects the CSS into the document on load using the
 * exact pattern the dsh client packages ship (e.g.
 * client.js:6318-6323 for QueueDock.module.css): a guarded
 * `style[data-plugin-css=...]` probe plus a `document.head` append with the
 * `data-plugin` / `data-plugin-css` markers. The `typeof document` guard
 * keeps module load safe in non-DOM environments (the tests mock react and
 * run in bun without a DOM — `document` is undefined there and the block is
 * skipped).
 *
 * This module is BROWSER code: no node builtins, no DOM access outside the
 * guarded injection block.
 *
 * @module
 */

/** The namespaced CSS text injected into the document on module load. */
export const dockCss = `
.rolebox-dock {
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
  padding: 0 var(--dsh-composer-dock-inset);
  flex: none;
}

.rolebox-dock-panel {
  background: var(--dsw-specific-tip);
  border-radius: 12px 12px 0 0;
  width: 100%;
  padding: 2px 0;
  position: relative;
  overflow: hidden;
}

.rolebox-dock-panel::after {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: inherit;
  content: "";
  pointer-events: none;
  border-bottom: none;
  position: absolute;
  inset: 0;
}

.rolebox-dock-header {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 8px;
  align-items: center;
  gap: 10px;
  padding: 4px 12px;
  display: flex;
  font: inherit;
}

.rolebox-dock-header:focus-visible {
  outline: 2px solid var(--dsw-alias-label-tertiary);
  outline-offset: -2px;
}

.rolebox-dock-lead {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  place-items: center;
  display: grid;
}

.rolebox-dock-title {
  color: var(--dsw-alias-label-primary);
  flex: none;
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
}

.rolebox-dock-status {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: auto;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  overflow: hidden;
}

.rolebox-dock-status-error {
  color: var(--dsw-alias-state-error-primary);
}

.rolebox-dock-list {
  max-height: 180px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}

.rolebox-dock-row {
  box-sizing: border-box;
  border-radius: 8px;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 4px 5px 4px 12px;
  display: flex;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  font: inherit;
  color: inherit;
}

.rolebox-dock-row + .rolebox-dock-row {
  box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1);
}

.rolebox-dock-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.rolebox-dock-row:focus-visible {
  outline: 2px solid var(--dsw-alias-label-tertiary);
  outline-offset: -2px;
}

.rolebox-dock-row:disabled {
  cursor: default;
  opacity: 0.45;
}

.rolebox-dock-name {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  flex: auto;
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
}

.rolebox-dock-meta {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  flex: 0 1 auto;
}

.rolebox-dock-current {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
}
`;

/** Plain class-name map — the `rolebox-dock-` prefixed names used by the component. */
export const dockClass = {
  dock: "rolebox-dock",
  panel: "rolebox-dock-panel",
  header: "rolebox-dock-header",
  lead: "rolebox-dock-lead",
  title: "rolebox-dock-title",
  status: "rolebox-dock-status",
  statusError: "rolebox-dock-status-error",
  list: "rolebox-dock-list",
  row: "rolebox-dock-row",
  name: "rolebox-dock-name",
  meta: "rolebox-dock-meta",
  current: "rolebox-dock-current",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors the shipped guard+append of QueueDock.module.css (client.js:
// 6318-6323): probe for an already-injected style by its data-plugin-css
// marker, then append the style tag once. `typeof document` guards the
// non-DOM case (tests run in bun without a document global).
if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" + JSON.stringify("rolebox/RoleSwitchDock") + "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/RoleSwitchDock";
  tag.textContent = dockCss;
  document.head.appendChild(tag);
}
