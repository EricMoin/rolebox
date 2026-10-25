/**
 * CSS for the rolebox Tool-call rows (`tool.call.toolview` entries).
 *
 * The row is deliberately a HOST-SHAPED row, not a card: a 16px glyph lane, a
 * title, a muted summary and a state mark, all on the transcript's own
 * background. A rolebox call must read as one more tool call in the step, not
 * as a banner inside it. The only surfaces the row ever paints are the details
 * body (when expanded) and the error tint.
 *
 * Colours come from the host palette variables with literal fallbacks, so the
 * rows follow the active dsh theme without importing a theme module.
 *
 * @module
 */

/** Class names the row component uses (kept together so CSS and TSX cannot drift). */
export const toolViewClasses = {
  row: "rolebox-tool",
  head: "rolebox-tool-head",
  icon: "rolebox-tool-icon",
  title: "rolebox-tool-title",
  summary: "rolebox-tool-summary",
  state: "rolebox-tool-state",
  spinner: "rolebox-tool-spinner",
  chevron: "rolebox-tool-chevron",
  details: "rolebox-tool-details",
  section: "rolebox-tool-section",
  sectionLabel: "rolebox-tool-section-label",
  pre: "rolebox-tool-pre",
  error: "rolebox-tool-error",
} as const;

/** The namespaced CSS text injected once into the document. */
export const toolViewCss = `
.rolebox-tool {
  --rolebox-tool-ink: var(--dsw-alias-label-primary, #0f1115);
  --rolebox-tool-ink-muted: var(--dsw-alias-label-secondary, #61666b);
  --rolebox-tool-ink-glyph: var(--dsw-alias-label-tertiary, #81858c);
  --rolebox-tool-ink-danger: var(--dsw-alias-state-error-primary, #ec1313);
  --rolebox-tool-surface: var(--dsw-alias-bg-l1, rgba(38, 49, 72, 0.03));
  --rolebox-tool-border: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  --rolebox-tool-radius: 8px;
  --rolebox-tool-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  color: var(--rolebox-tool-ink);
  font-size: 13px;
  line-height: 20px;
}

.rolebox-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 2px 6px 2px 2px;
  border: 0;
  border-radius: var(--rolebox-tool-radius);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.rolebox-tool-head:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-tool-head:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 1px;
}

.rolebox-tool-head:disabled {
  cursor: default;
}

.rolebox-tool-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--rolebox-tool-ink-glyph);
}

.rolebox-tool-title {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  color: var(--rolebox-tool-ink);
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rolebox-tool-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--rolebox-tool-ink-muted);
  font-family: var(--rolebox-tool-mono);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rolebox-tool-summary::before {
  content: "·";
  margin-right: 6px;
  color: var(--rolebox-tool-ink-glyph);
  font-family: inherit;
}

.rolebox-tool-state {
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-left: auto;
  color: var(--rolebox-tool-ink-glyph);
}

.rolebox-tool[data-state="error"] .rolebox-tool-title,
.rolebox-tool[data-state="error"] .rolebox-tool-icon {
  color: var(--rolebox-tool-ink-danger);
}

.rolebox-tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--rolebox-tool-ink-glyph);
  border-top-color: transparent;
  border-radius: 50%;
  animation: rolebox-tool-spin 800ms linear infinite;
}

.rolebox-tool-chevron {
  transition: transform 130ms cubic-bezier(0.4, 0, 0.2, 1);
}

.rolebox-tool[data-open="true"] .rolebox-tool-chevron {
  transform: rotate(90deg);
}

.rolebox-tool-details {
  margin: 4px 0 6px 22px;
  padding: 8px 10px;
  border: 1px solid var(--rolebox-tool-border);
  border-radius: var(--rolebox-tool-radius);
  background: var(--rolebox-tool-surface);
}

.rolebox-tool-section + .rolebox-tool-section {
  margin-top: 8px;
}

.rolebox-tool-section-label {
  margin: 0 0 2px;
  color: var(--rolebox-tool-ink-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.rolebox-tool-pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  color: var(--rolebox-tool-ink);
  font-family: var(--rolebox-tool-mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.rolebox-tool-error {
  margin: 0 0 0 22px;
  overflow: hidden;
  color: var(--rolebox-tool-ink-danger);
  font-family: var(--rolebox-tool-mono);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@keyframes rolebox-tool-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-tool-spinner { animation: none; opacity: 0.6; }
  .rolebox-tool-chevron { transition: none; }
}
`;

if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" + JSON.stringify("rolebox/ToolViews") + "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "rolebox";
  tag.dataset.pluginCss = "rolebox/ToolViews";
  tag.textContent = toolViewCss;
  document.head.appendChild(tag);
}
