/**
 * RoleSwitchDock CSS — the rolebox dock strip seated above the dsh composer.
 *
 * The dock answers a STATUS question ("which role is running?"), so the strip
 * leads with the current value rather than with a category label. This module
 * owns the visual system for that strip.
 *
 * Design posture (see docs/dsh-plugin-contract.md):
 *   - One material. `--rolebox-surface` (host `--dsw-specific-tip`) is the
 *     single surface token, shared with the monitor panel so both rolebox
 *     surfaces read as one product.
 *   - Value is the title. `.rolebox-dock-value` renders the active role NAME
 *     in the header; the shipped static label ("Role") is gone.
 *   - Active role is carried by FIVE redundant channels, never by a coloured
 *     side border (a banned anti-slop tell): an inherited font-weight step on
 *     the row, a reserved 20px trailing mark seat holding a check glyph, the
 *     host active-nav fill, `aria-current`, and the spelled-out Active/Base
 *     chip in the header (which survives total loss of hue perception).
 *   - State is never encoded as coloured text. Measured against the host
 *     palette, `label-tertiary` on the tip surface is 3.42:1 and
 *     `state-success-primary` on its own tint is 2.09:1 — both fail. State is
 *     therefore a pale tint fill plus the state WORD in `--dsw-alias-label-primary`.
 *   - Geometry is preserved from the shipped dock replica: the composer
 *     geometry vars and the open-bottom radius (`12px 12px 0 0`) keep the
 *     strip seated on the composer card below it.
 *   - Motion is meaningful only: the disclosure, the chevron, hover, the value
 *     swap, and busy. Focus rings are deliberately instantaneous. The error
 *     path has no shake (refused: decorative, vestibular-triggering, and it
 *     communicates nothing the copy does not). Everything runs on the host's
 *     single easing curve (`--ds-ease-in-out`): an earlier pair of invented
 *     curves made the opening cover half its distance in the first fifth of
 *     its duration and the closing hesitate through the first half, which
 *     reads as a stutter rather than as easing.
 *   - The collapsed region skips its own layout (`content-visibility`), because
 *     a 0fr grid track and `visibility: hidden` clip and skip paint but do NOT
 *     skip layout — the invisible role list was being laid out on every pass.
 *
 * Token discipline: every `var(--rolebox-...)` CONSUMPTION carries a comma and
 * a fallback, because the CSS-contract tests scan for bare `var(--<token>)`
 * and flag anything outside `--dsw-*` (plus the four `--dsh-composer-*` frame
 * vars). Definitions are plain declarations and are never flagged. The test
 * suite enforces that no bare `var(--rolebox-*)` consumption ever appears.
 *
 * Injection: the module injects the CSS into the document on load using the
 * pattern the dsh client packages ship — a guarded `style[data-plugin-css=...]`
 * probe plus a `document.head` append with the `data-plugin` / `data-plugin-css`
 * markers. The `typeof document` guard keeps module load safe in non-DOM
 * environments (the tests mock react and run in bun without a DOM).
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

  --rolebox-surface: var(--dsw-specific-tip, rgb(245, 246, 247));
  --rolebox-surface-active: var(--dsw-specific-sidebar-nav-item-active, rgb(235, 238, 242));
  --rolebox-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-accent: var(--dsw-alias-state-business-tertiary, rgb(228, 237, 253));
  --rolebox-surface-danger: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
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

  --rolebox-radius-chip: 6px;
  --rolebox-radius-control: 8px;
  --rolebox-radius-card: 12px;
  --rolebox-radius-panel: 12px 12px 0 0;

  --rolebox-row-height: 40px;
  --rolebox-mark-seat: 20px;

  --rolebox-dur-instant: 90ms;
  --rolebox-dur-fast: 130ms;
  --rolebox-dur-base: 200ms;
  --rolebox-dur-exit: 160ms;
  /* ONE curve — the host's own (--ds-ease-in-out). The previous enter/exit pair
     was invented and measurably wrong: (0.2, 0, 0, 1) covers 50% of the
     distance in the first 20% of the duration and 87.8% by the halfway point,
     so the back half of every opening crawled through its last 12%. */
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);

  --rolebox-shadow-raised: 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.06);
  --rolebox-shadow-sticky: 0 2px 4px rgba(0, 0, 0, 0.05), 0 8px 24px rgba(0, 0, 0, 0.1);
}

.rolebox-dock-panel {
  background: var(--rolebox-surface, var(--dsw-specific-tip, rgb(245, 246, 247)));
  border-radius: var(--rolebox-radius-panel, 12px 12px 0 0);
  width: 100%;
  padding: 0;
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

.rolebox-dock-header-row {
  box-sizing: border-box;
  width: 100%;
  height: var(--rolebox-row-height, 40px);
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: flex;
  border-radius: var(--rolebox-radius-panel, 12px 12px 0 0);
  overflow: hidden;
}

.rolebox-dock-header {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  height: var(--rolebox-row-height, 40px);
  margin-left: var(--rolebox-space-1, 4px);
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: var(--rolebox-radius-control, 8px);
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  padding: 0 var(--rolebox-space-3, 12px);
  display: flex;
  font: inherit;
}

.rolebox-dock-header:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-dock-lead {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  flex: none;
  place-items: center;
  display: grid;
}

.rolebox-dock-value {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}

.rolebox-dock-chip {
  box-sizing: border-box;
  flex: none;
  height: 20px;
  padding: 0 var(--rolebox-space-2, 8px);
  border-radius: var(--rolebox-radius-chip, 6px);
  align-items: center;
  display: inline-flex;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-chip-active {
  background: var(--rolebox-surface-accent, rgb(228, 237, 253));
  color: var(--rolebox-ink, rgb(15, 17, 21));
}

.rolebox-dock-chip-base {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}

.rolebox-dock-chevron {
  flex: none;
  color: var(--rolebox-ink-glyph, rgb(129, 133, 140));
  place-items: center;
  display: grid;
  transform-origin: center;
  transition: transform var(--rolebox-dur-exit, 160ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-chevron[data-open="true"] {
  transform: rotate(180deg);
  transition: transform var(--rolebox-dur-base, 200ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-status {
  box-sizing: border-box;
  min-width: 0;
  flex: 0 1 auto;
  max-width: 55%;
  margin-right: var(--rolebox-space-1, 4px);
  align-items: center;
  gap: var(--rolebox-space-1, 4px);
  display: inline-flex;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-dock-status-error {
  height: 24px;
  padding: 0 var(--rolebox-space-2, 8px);
  border: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
  border-radius: var(--rolebox-radius-chip, 6px);
  background: var(--rolebox-surface-danger, rgba(236, 19, 19, 0.05));
  color: var(--rolebox-ink, rgb(15, 17, 21));
}

.rolebox-dock-status-glyph {
  flex: none;
  color: var(--rolebox-ink-danger, rgb(236, 19, 19));
  place-items: center;
  display: grid;
}
.rolebox-dock-status-sr {
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

.rolebox-dock-disclosure {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition:
    /* Height and opacity share a duration AND a curve, so the content appears
       exactly as fast as the box reveals it. They used to disagree (200ms of
       height against 130ms of opacity), so the content finished appearing while
       the panel was still growing. */
    grid-template-rows var(--rolebox-dur-base, 200ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    opacity var(--rolebox-dur-base, 200ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    visibility 0s linear 0s;
}

.rolebox-dock-disclosure[data-open="false"] {
  grid-template-rows: 0fr;
  opacity: 0;
  visibility: hidden;
  transition:
    /* The close fade ran at 90ms against a 160ms box, so the content vanished
       while the panel was still about half open and the remainder then snapped
       shut. Now the content stays visible and is pushed out by the closing box —
       which is what actually reads as a collapse. */
    grid-template-rows var(--rolebox-dur-exit, 160ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    opacity var(--rolebox-dur-exit, 160ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    visibility 0s linear var(--rolebox-dur-exit, 160ms);
}

.rolebox-dock-disclosure-inner {
  min-height: 0;
  overflow: hidden;
  padding: 0 var(--rolebox-space-1, 4px) var(--rolebox-space-1, 4px);
  transform: translateY(0);
  transform-origin: top center;
  transition: transform var(--rolebox-dur-base, 200ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-disclosure[data-open="false"] .rolebox-dock-disclosure-inner {
  transform: translateY(-4px);
  transition-duration: var(--rolebox-dur-exit, 160ms);
}

/* ── Collapsed-subtree layout skip ───────────────────────────────────────────
   grid-template-rows: 0fr clips the closed region and visibility: hidden skips
   its paint — but NEITHER skips layout. The whole role list was therefore laid
   out on every layout pass while invisible, at a cost that grew with the
   library (measured by forced full layout: 0.3ms at 3 roles, 0.6ms at 60,
   1.3ms at 200; a flat 0.1ms once skipped). During the disclosure animation
   that cost lands on every frame.
   content-visibility is a discrete property, so transition-behavior:
   allow-discrete defers the flip to the END of the close, after the fade has
   finished, while opening flips it immediately. Both the declaration and the
   behaviour live inside @supports, so a browser without allow-discrete keeps
   exactly the previous behaviour instead of losing the close animation. */
@supports (transition-behavior: allow-discrete) {
  .rolebox-dock-disclosure-inner {
    transition:
      transform var(--rolebox-dur-base, 200ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
      content-visibility 0s linear 0s;
    transition-behavior: normal, allow-discrete;
  }

  .rolebox-dock-disclosure[data-open="false"] .rolebox-dock-disclosure-inner {
    content-visibility: hidden;
    transition:
      transform var(--rolebox-dur-exit, 160ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
      content-visibility 0s linear var(--rolebox-dur-exit, 160ms);
    transition-behavior: normal, allow-discrete;
  }
}

.rolebox-dock-filter {
  box-sizing: border-box;
  height: var(--rolebox-row-height, 40px);
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  padding: 0 var(--rolebox-space-3, 12px);
  display: flex;
  box-shadow: inset 0 -1px 0 var(--dsw-alias-border-l1);
}

.rolebox-dock-filter:focus-within {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
  border-radius: var(--rolebox-radius-control, 8px);
}

.rolebox-dock-filter-lead {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  place-items: center;
  display: grid;
}

.rolebox-dock-filter-input {
  min-width: 0;
  flex: auto;
  padding: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-dock-filter-input::placeholder {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}

.rolebox-dock-count {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  font-weight: 400;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
}

.rolebox-dock-filter-clear {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--rolebox-radius-chip, 6px);
  background: transparent;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  cursor: pointer;
  place-items: center;
  display: grid;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-filter-clear:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-dock-filter-clear:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-dock-list {
  max-height: 200px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent;
}

.rolebox-dock-row {
  box-sizing: border-box;
  border-radius: var(--rolebox-radius-control, 8px);
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  width: 100%;
  height: var(--rolebox-row-height, 40px);
  padding: 0 var(--rolebox-space-2, 8px) 0 var(--rolebox-space-3, 12px);
  display: flex;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  font: inherit;
  color: inherit;
  font-weight: 400;
  transition:
    background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    opacity var(--rolebox-dur-instant, 90ms) linear;
}

.rolebox-dock-row[aria-current="true"] {
  background: var(--rolebox-surface-active, rgb(235, 238, 242));
  font-weight: 500;
}

.rolebox-dock-row:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-dock-row[aria-current="true"]:hover {
  background: var(--rolebox-surface-active, rgb(235, 238, 242));
}

.rolebox-dock-row:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-dock-row:disabled {
  cursor: default;
  opacity: 0.45;
}

.rolebox-dock-name {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 13px;
  line-height: 20px;
  font-weight: inherit;
}

.rolebox-dock-meta {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  line-height: 14px;
  font-weight: inherit;
}

.rolebox-dock-mark {
  flex: none;
  width: var(--rolebox-mark-seat, 20px);
  height: var(--rolebox-mark-seat, 20px);
  place-items: center;
  display: grid;
}

.rolebox-dock-mark-active {
  color: var(--rolebox-accent, rgb(65, 118, 230));
}

.rolebox-dock-empty {
  box-sizing: border-box;
  min-height: var(--rolebox-row-height, 40px);
  padding: var(--rolebox-space-3, 12px);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--rolebox-space-1, 4px);
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.rolebox-dock-empty-title {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.rolebox-dock-empty-body {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-size: 11px;
  font-weight: 400;
  line-height: 14px;
  overflow-wrap: anywhere;
}

.rolebox-dock-empty-action {
  box-sizing: border-box;
  height: 32px;
  margin-top: var(--rolebox-space-1, 4px);
  padding: 0 var(--rolebox-space-3, 12px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  background: transparent;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-dock-empty-action:hover {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-dock-empty-action:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

@keyframes rolebox-dock-seat-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.rolebox-dock-value {
  animation: rolebox-dock-seat-in var(--rolebox-dur-exit, 160ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)) both;
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-dock-disclosure,
  .rolebox-dock-disclosure[data-open="false"] {
    transition-duration: 1ms;
    transition-delay: 0s;
  }
  .rolebox-dock-disclosure-inner,
  .rolebox-dock-disclosure[data-open="false"] .rolebox-dock-disclosure-inner {
    transition: none;
    transform: none;
  }
  .rolebox-dock-chevron,
  .rolebox-dock-row,
  .rolebox-dock-chip,
  .rolebox-dock-filter-clear,
  .rolebox-dock-empty-action {
    transition: none;
  }
  .rolebox-dock-value {
    animation: none;
  }
}
`;

/** Plain class-name map — the `rolebox-dock-` prefixed names used by the component. */
export const dockClass = {
  dock: "rolebox-dock",
  panel: "rolebox-dock-panel",
  headerRow: "rolebox-dock-header-row",
  header: "rolebox-dock-header",
  lead: "rolebox-dock-lead",
  value: "rolebox-dock-value",
  chip: "rolebox-dock-chip",
  chipActive: "rolebox-dock-chip-active",
  chipBase: "rolebox-dock-chip-base",
  chevron: "rolebox-dock-chevron",
  status: "rolebox-dock-status",
  statusError: "rolebox-dock-status-error",
  statusGlyph: "rolebox-dock-status-glyph",
  statusSr: "rolebox-dock-status-sr",
  disclosure: "rolebox-dock-disclosure",
  disclosureInner: "rolebox-dock-disclosure-inner",
  filter: "rolebox-dock-filter",
  filterLead: "rolebox-dock-filter-lead",
  filterInput: "rolebox-dock-filter-input",
  filterClear: "rolebox-dock-filter-clear",
  count: "rolebox-dock-count",
  list: "rolebox-dock-list",
  row: "rolebox-dock-row",
  name: "rolebox-dock-name",
  meta: "rolebox-dock-meta",
  mark: "rolebox-dock-mark",
  markActive: "rolebox-dock-mark-active",
  empty: "rolebox-dock-empty",
  emptyTitle: "rolebox-dock-empty-title",
  emptyBody: "rolebox-dock-empty-body",
  emptyAction: "rolebox-dock-empty-action",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors the shipped guard+append of QueueDock.module.css: probe for an
// already-injected style by its data-plugin-css marker, then append the style
// tag once. `typeof document` guards the non-DOM case (tests run in bun
// without a document global).
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
