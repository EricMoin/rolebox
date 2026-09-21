/**
 * RoleboxRolesPanel CSS — the rolebox "Rolebox" page of the dsh settings
 * panel (`settings.section` slot).
 *
 * The page answers a CATALOGUE question ("what roles are loaded, and what can
 * each of them do?"), so the body leads with identity (name / id /
 * description) and follows with the definition's configuration — model, mode,
 * tool policy, max steps. Live session monitoring is NOT here any more; it
 * lives in the right-Sidebar page tab (`rolebox-monitor-panel.css.ts`). This
 * module shares that module's visual system: one surface token, the 4pt
 * spacing scale, the same radius set, the same chip treatment for the
 * tool-policy halves, and the same 11/13/20px type tiers — with
 * `--dsw-font-s-strong-14` as the one extra step, because a role CARD title
 * must outrank its own 13px body without reaching the 20px page title.
 *
 * Design posture:
 *   - Identity first, configuration second. Every card leads with the display
 *     name and the id, then the description, then the readings.
 *   - Silent blanks are banned. A missing model / mode / maxSteps renders an
 *     explicit fallback word ("default" / "primary" / "not set") in the muted
 *     ink, and a definition with no tool policy says "none declared" — never
 *     an empty chip the user has to interpret.
 *   - Counts before names. Each tool-policy half always shows its count; a
 *     long name list caps at `TOOL_NAME_LIMIT` and puts the full list in the
 *     `title`, so the card stays scannable without hiding anything.
 *   - Motion is meaningful only: the in-flight spinner (delayed 120ms so a
 *     fast refresh does not flash), the loading skeleton, and hover. The
 *     status seat is the live region that announces outcomes.
 *
 * Token discipline: this module may reference ONLY `--dsw-*` host tokens, and
 * every `var(--rolebox-...)` CONSUMPTION must carry a comma and a fallback so
 * the bare-`var()` scan never flags it.
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
export const rolesCss = `
.rolebox-roles {
  box-sizing: border-box;
  padding: 12px 16px;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);

  --rolebox-surface: var(--dsw-specific-tip, rgb(245, 246, 247));
  --rolebox-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-skeleton: var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04));
  --rolebox-surface-skeleton-hi: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-failed: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  --rolebox-border-hairline: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  --rolebox-border-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  --rolebox-border-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-ink: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  --rolebox-ink-muted: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
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

  --rolebox-dur-fast: 130ms;
  /* The host's own curve (--ds-ease-in-out); shared with the dock and the
     monitor tab so every rolebox surface moves identically. */
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);
}

.rolebox-roles-header {
  box-sizing: border-box;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--rolebox-space-3, 12px);
  padding-bottom: var(--rolebox-space-3, 12px);
  display: flex;
}

.rolebox-roles-title {
  flex: none;
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-l-20);
}

.rolebox-roles-count {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}

.rolebox-roles-refresh,
.rolebox-roles-reload,
.rolebox-roles-open-monitor {
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

/* The role-reload control is a filled surface: Refresh re-reads the list,
   Reload roles asks the server to re-resolve roles from disk. */
.rolebox-roles-reload {
  background: var(--rolebox-surface, rgb(245, 246, 247));
}

.rolebox-roles-refresh:hover,
.rolebox-roles-reload:hover,
.rolebox-roles-open-monitor:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-roles-refresh:focus-visible,
.rolebox-roles-reload:focus-visible,
.rolebox-roles-open-monitor:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-roles-refresh:disabled,
.rolebox-roles-reload:disabled {
  cursor: default;
  opacity: 0.45;
}

@keyframes rolebox-roles-spin {
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

.rolebox-roles-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  border-radius: 999px;
  animation: rolebox-roles-spin 800ms linear infinite;
  animation-delay: 120ms;
}

.rolebox-roles-status {
  min-width: 0;
  flex: 1 1 100%;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxs-12);
}

.rolebox-roles-status-error {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  border-bottom: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
}

.rolebox-roles-state {
  margin: 0;
  padding: var(--rolebox-space-4, 16px) 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
}

.rolebox-roles-state-error {
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

.rolebox-roles-alert-glyph {
  flex: none;
  color: var(--rolebox-ink-danger, rgb(236, 19, 19));
  display: inline-flex;
}

.rolebox-roles-error-text {
  min-width: 0;
  margin-right: var(--rolebox-space-2, 8px);
  overflow-wrap: anywhere;
}

.rolebox-roles-retry {
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

.rolebox-roles-retry:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-roles-retry:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-roles-skeleton {
  padding-top: var(--rolebox-space-2, 8px);
  display: grid;
  gap: var(--rolebox-space-3, 12px);
}

@keyframes rolebox-roles-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

.rolebox-roles-skeleton-card {
  box-sizing: border-box;
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  border: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface, rgb(245, 246, 247));
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-roles-skeleton-bar {
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
  animation: rolebox-roles-shimmer 1400ms linear infinite;
}

.rolebox-roles-skeleton-bar-wide {
  height: 16px;
  width: 40%;
}

.rolebox-roles-skeleton-bar-half {
  width: 62%;
}

.rolebox-roles-body {
  display: grid;
  gap: var(--rolebox-space-3, 12px);
}

.rolebox-roles-card {
  box-sizing: border-box;
  padding: var(--rolebox-space-3, 12px) var(--rolebox-space-4, 16px);
  border: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface, rgb(245, 246, 247));
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-roles-card-head {
  align-items: baseline;
  gap: var(--rolebox-space-3, 12px);
  display: flex;
  justify-content: space-between;
}

.rolebox-roles-role-name {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-s-strong-14);
}

.rolebox-roles-role-id {
  min-width: 0;
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  line-height: 14px;
}

.rolebox-roles-description {
  margin: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
  overflow-wrap: anywhere;
}

.rolebox-roles-kv {
  margin: 0;
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-roles-kv-row {
  align-items: baseline;
  gap: var(--rolebox-space-3, 12px);
  display: flex;
  justify-content: space-between;
}

.rolebox-roles-kv-row dt {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
}

.rolebox-roles-kv-row dd {
  min-width: 0;
  margin: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-roles-value {
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-weight: 400;
}

/* The explicit fallback word ("default" / "primary" / "not set"). Muted but
   present: a blank value would be indistinguishable from "not reported". */
.rolebox-roles-fallback {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-weight: 400;
}

.rolebox-roles-tools {
  padding-top: var(--rolebox-space-2, 8px);
  border-top: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-roles-tools-title {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
}

.rolebox-roles-tools-none {
  margin: 0;
  padding-top: var(--rolebox-space-2, 8px);
  border-top: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.04));
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxs-12);
}

.rolebox-roles-tool-row {
  min-width: 0;
  align-items: baseline;
  gap: var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-roles-tool-label {
  box-sizing: border-box;
  flex: none;
  height: 20px;
  padding: 0 var(--rolebox-space-2, 8px);
  border-radius: var(--rolebox-radius-chip, 6px);
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}

.rolebox-roles-tool-names {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  line-height: 20px;
}

.rolebox-roles-tool-empty {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  line-height: 20px;
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-roles-spinner {
    display: none;
  }
  .rolebox-roles-skeleton-bar {
    animation: none;
  }
  .rolebox-roles-refresh,
  .rolebox-roles-reload,
  .rolebox-roles-open-monitor,
  .rolebox-roles-retry {
    transition: none;
  }
}
`;

/** Plain class-name map — the `rolebox-roles-` prefixed names used by the component. */
export const rolesClass = {
  header: "rolebox-roles-header",
  title: "rolebox-roles-title",
  count: "rolebox-roles-count",
  refresh: "rolebox-roles-refresh",
  reload: "rolebox-roles-reload",
  openMonitor: "rolebox-roles-open-monitor",
  spinner: "rolebox-roles-spinner",
  status: "rolebox-roles-status",
  statusError: "rolebox-roles-status-error",
  state: "rolebox-roles-state",
  stateError: "rolebox-roles-state-error",
  alertGlyph: "rolebox-roles-alert-glyph",
  errorText: "rolebox-roles-error-text",
  retry: "rolebox-roles-retry",
  skeleton: "rolebox-roles-skeleton",
  skeletonCard: "rolebox-roles-skeleton-card",
  skeletonBar: "rolebox-roles-skeleton-bar",
  skeletonBarWide: "rolebox-roles-skeleton-bar-wide",
  skeletonBarHalf: "rolebox-roles-skeleton-bar-half",
  body: "rolebox-roles-body",
  card: "rolebox-roles-card",
  cardHead: "rolebox-roles-card-head",
  roleName: "rolebox-roles-role-name",
  roleId: "rolebox-roles-role-id",
  description: "rolebox-roles-description",
  kv: "rolebox-roles-kv",
  kvRow: "rolebox-roles-kv-row",
  value: "rolebox-roles-value",
  fallback: "rolebox-roles-fallback",
  tools: "rolebox-roles-tools",
  toolsTitle: "rolebox-roles-tools-title",
  toolsNone: "rolebox-roles-tools-none",
  toolRow: "rolebox-roles-tool-row",
  toolLabel: "rolebox-roles-tool-label",
  toolNames: "rolebox-roles-tool-names",
  toolEmpty: "rolebox-roles-tool-empty",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors `role-switch-dock.css.ts`: probe for an already-injected style by its
// data-plugin-css marker, then append the style tag once. `typeof document`
// guards the non-DOM case (tests run in bun without a document global).
if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" +
      JSON.stringify("rolebox/RoleboxRolesPanel") +
      "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/RoleboxRolesPanel";
  tag.textContent = rolesCss;
  document.head.appendChild(tag);
}
