/**
 * SuggestDock CSS — the composer tool-row button for draft suggestions and the
 * hint card that holds a suggested text above it.
 *
 * One self-mounted `<style data-plugin-css="rolebox/SuggestDock">` element is
 * appended to `document.head` on module load, exactly like
 * `role-switch-dock.css.ts`. There is no inline style injection.
 *
 * The custom properties below are the rolebox design tokens (the same names
 * `role-switch-dock.css.ts` declares). Custom properties are scoped by the
 * selector that declares them, and this button does not live inside
 * `.rolebox-dock`, so the small subset it uses is re-declared on
 * `.rolebox-suggest` over the host's `--dsw-*` variables. Every use below also
 * carries the shipped fallback, so a host without those variables still
 * renders the control.
 */

/** The namespaced CSS text injected into the document on module load. */
export const suggestCss = `
.rolebox-suggest {
  box-sizing: border-box;
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  margin: 0;
  padding: 0;

  --rolebox-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-accent: var(--dsw-alias-state-business-tertiary, rgb(228, 237, 253));
  --rolebox-ink: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  --rolebox-ink-muted: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
  --rolebox-ink-glyph: var(--dsw-alias-label-tertiary, rgb(129, 133, 140));
  --rolebox-accent: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-focus-ring: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-popover-surface: var(--dsw-specific-menu, rgb(255, 255, 255));
  --rolebox-border-hairline: var(--dsw-alias-border-l2, rgba(15, 17, 21, 0.12));
  --rolebox-radius-control: 8px;
  --rolebox-dur-fast: 130ms;
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);
}

.rolebox-suggest-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  height: 28px;
  margin: 0;
  padding: 0 8px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  background: transparent;
  border: none;
  border-radius: var(--rolebox-radius-control, 8px);
  cursor: pointer;
  transition:
    background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-suggest-button:hover:not(:disabled) {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink-glyph, rgb(129, 133, 140));
}

.rolebox-suggest-button:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

.rolebox-suggest-button:disabled {
  cursor: default;
  opacity: 0.45;
}

/* A held suggestion turns the pill's label accent-colored so it reads as ready
   to be filled; the hint card above it carries the actual Fill/Dismiss
   actions. There is no injected/clear state on the pill any more. */
.rolebox-suggest[data-has-suggestion="true"] .rolebox-suggest-button {
  color: var(--rolebox-accent, rgb(65, 118, 230));
  background: var(--rolebox-surface-accent, rgb(228, 237, 253));
}

.rolebox-suggest-glyph {
  display: grid;
  place-items: center;
}

.rolebox-suggest-label {
  display: inline-block;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The state-aware explanation: above the pill, right-aligned, and inert to the
   pointer so it can never swallow the click it describes. The wrapper stays
   interactive even when the button is disabled, so a wrapper :hover is what
   makes a disabled control explain itself; :focus-within covers the keyboard
   path while the button is enabled/focusable. */
.rolebox-suggest-tip {
  box-sizing: border-box;
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  display: block;
  width: max-content;
  max-width: 260px;
  padding: 8px 10px;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  background: var(--rolebox-popover-surface, rgb(255, 255, 255));
  border: 1px solid var(--rolebox-border-hairline, rgba(15, 17, 21, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition:
    opacity var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)),
    transform var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

.rolebox-suggest:hover .rolebox-suggest-tip,
.rolebox-suggest:focus-within .rolebox-suggest-tip {
  opacity: 1;
  transform: translateY(0);
}

/* A manual request that produced no draft raises a transient notice in the
   tooltip area. The data-notice attribute forces that (pointer-inert) tooltip
   visible for its short window: no focus is taken and no click is intercepted. */
.rolebox-suggest[data-notice] .rolebox-suggest-tip {
  opacity: 1;
  transform: translateY(0);
}

/* While the hint card is open it owns the space above the pill: the tooltip is
   removed from layout (not merely transparent) so it can never overlap the
   card or its buttons. */
.rolebox-suggest[data-has-suggestion="true"] .rolebox-suggest-tip {
  display: none;
}

/* The hint card: an absolutely positioned panel above the pill. It is the only
   interactive overlay (the tooltip stays pointer-inert); its buttons are real
   <button>s, take no focus on their own and never move focus into the composer
   row. */
.rolebox-suggest-card {
  box-sizing: border-box;
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 61;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: max-content;
  max-width: 300px;
  padding: 10px 12px;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  background: var(--rolebox-popover-surface, rgb(255, 255, 255));
  border: 1px solid var(--rolebox-border-hairline, rgba(15, 17, 21, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  box-shadow: 0 6px 18px rgba(15, 17, 21, 0.14);
  pointer-events: auto;
}

.rolebox-suggest-card-eyebrow {
  display: block;
  color: var(--rolebox-accent, rgb(65, 118, 230));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.2;
  text-transform: uppercase;
}

.rolebox-suggest-card-text {
  display: block;
  max-width: 300px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.rolebox-suggest-card-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.rolebox-suggest-card-action {
  box-sizing: border-box;
  height: 24px;
  margin: 0;
  padding: 0 10px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  background: transparent;
  border: 1px solid var(--rolebox-border-hairline, rgba(15, 17, 21, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  cursor: pointer;
}

.rolebox-suggest-card-action:hover {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-suggest-card-action:focus-visible {
  outline: 2px solid var(--rolebox-focus-ring, rgb(65, 118, 230));
  outline-offset: -2px;
}

/* Fill is the primary action: the only one that writes the composer. */
.rolebox-suggest-card-fill {
  color: var(--rolebox-accent, rgb(65, 118, 230));
  background: var(--rolebox-surface-accent, rgb(228, 237, 253));
  border-color: transparent;
}

.rolebox-suggest-tip-title {
  display: block;
  font-weight: 600;
}

.rolebox-suggest-tip-body {
  display: block;
  margin-top: 2px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}

@keyframes rolebox-suggest-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

.rolebox-suggest-button[data-state="loading"] .rolebox-suggest-glyph {
  animation: rolebox-suggest-pulse 900ms var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1)) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-suggest-button,
  .rolebox-suggest-tip,
  .rolebox-suggest-button[data-state="loading"] .rolebox-suggest-glyph {
    transition: none;
    animation: none;
  }
}
`;

/** Plain class-name map — the `rolebox-suggest-` prefixed names used by the component. */
export const suggestClass = {
  root: "rolebox-suggest",
  button: "rolebox-suggest-button",
  glyph: "rolebox-suggest-glyph",
  label: "rolebox-suggest-label",
  tip: "rolebox-suggest-tip",
  tipTitle: "rolebox-suggest-tip-title",
  tipBody: "rolebox-suggest-tip-body",
  card: "rolebox-suggest-card",
  cardEyebrow: "rolebox-suggest-card-eyebrow",
  cardText: "rolebox-suggest-card-text",
  cardActions: "rolebox-suggest-card-actions",
  cardAction: "rolebox-suggest-card-action",
  cardFill: "rolebox-suggest-card-fill",
  cardDismiss: "rolebox-suggest-card-dismiss",
} as const;

if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" + JSON.stringify("rolebox/SuggestDock") + "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/SuggestDock";
  tag.textContent = suggestCss;
  document.head.appendChild(tag);
}
