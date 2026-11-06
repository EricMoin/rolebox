/**
 * SuggestDock CSS — the composer tool-row button for draft suggestions.
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
  display: inline-flex;
  align-items: center;
  flex: none;
  margin: 0;
  padding: 0;

  --rolebox-surface-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rolebox-surface-accent: var(--dsw-alias-state-business-tertiary, rgb(228, 237, 253));
  --rolebox-ink-muted: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
  --rolebox-ink-glyph: var(--dsw-alias-label-tertiary, rgb(129, 133, 140));
  --rolebox-accent: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-focus-ring: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-radius-control: 8px;
  --rolebox-dur-fast: 130ms;
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);
}

.rolebox-suggest-button {
  box-sizing: border-box;
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
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

/* An injected suggestion is a live, owned draft: the control becomes the
   clear affordance and adopts the accent so it reads as active rather than
   merely hovered. */
.rolebox-suggest-button[data-state="injected"] {
  color: var(--rolebox-accent, rgb(65, 118, 230));
  background: var(--rolebox-surface-accent, rgb(228, 237, 253));
}

.rolebox-suggest-glyph {
  display: grid;
  place-items: center;
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
