/**
 * RoleboxMonitorPanel CSS — the rolebox RUN CONSOLE as a dsh RIGHT-SIDEBAR TAB
 * BODY (`sidebar.right.pane.tab` seat, keyed by the `rolebox-monitor` tab
 * type).
 *
 * The console answers, in order, "does anything need me?", "where am I?", "what
 * is each run doing?" and "what broke?". Its visual system rests on three
 * repeated units and nothing else:
 *
 *   1. the GLYPH LANE — a reading is an icon, an optional short word and a
 *      value (`▸ 8m`, `▤ 184.3k`). Twenty readings at 11px are unreadable as
 *      prose and instantly readable as shapes; the words are still in the
 *      accessibility tree and in every row's `title`, so nothing is lost but
 *      the noise.
 *   2. the CHIP — one shell for every categorical value: a run state (tinted by
 *      the state, carrying its glyph and its word), a session's role, a metric
 *      label. Two intensities, one shape.
 *   3. the STRIP — the only "many things at once" graphic: one cell per node,
 *      per round, per histogram bucket.
 *
 * There are no cards. A block is a section with a head row and hairline rules
 * between its rows, so the column reads as one instrument instead of a stack of
 * nested boxes, and the single raised surface is the attention band while it is
 * alarming — which is exactly what makes it the focal point.
 *
 * NARROW-COLUMN CHROME: this body is docked in the right Sidebar, which can be
 * narrowed to roughly 280px of content. Every reading lane WRAPS, every
 * identifier truncates with a `title` recovery, and nothing here sets a fixed
 * width.
 *
 * Design posture:
 *   - Verdict first. `.rolebox-monitor-attention` is the panel's only focal
 *     point and the first child of the body.
 *   - State is never coloured TEXT. The host palette measures
 *     `state-success-primary` at 2.09:1 and `state-warn-primary` at 1.99:1 as
 *     marks on their own tints — both fail 3:1 for non-text. A state is a tint
 *     fill plus the normalised state WORD in `--dsw-alias-label-primary`, with
 *     the raw backend phase always beside it.
 *   - Glyphs carry state by SHAPE first (play, check, cross, pause, ring, slash)
 *     and colour second; a reader who cannot separate the hues still reads the
 *     vocabulary. Where a glyph is the only mark (a node row, the node strip)
 *     the state word is one hover away in the row's `title`.
 *   - Measured against the real light tokens (not the fallbacks): running
 *     4.23:1, failed 4.50:1, done 3.71:1, blocked 2.79:1, dimmed stopped lower.
 *     The blocked amber therefore does NOT clear 3:1 — no amber alias does — so
 *     blocked cells also spike taller than the row and blocked glyphs keep their
 *     distinct shape, and the strip stays aria-hidden redundancy for the counts
 *     and rows that state the same thing in words.
 *   - Motion is meaningful only: the in-flight spinner (delayed so a fast
 *     refresh does not flash), the loading shimmer, hover and focus.
 *
 * Token discipline: this module may reference ONLY `--dsw-*` host tokens (the
 * monitor CSS-contract test does not whitelist the `--dsh-composer-*` frame
 * vars), and every `var(--rolebox-...)` CONSUMPTION must carry a comma and a
 * fallback so the bare-`var()` scan never flags it.
 *
 * Injection: a `style[data-plugin-css=...]` probe plus a `document.head`
 * append under a `typeof document` guard. This module is BROWSER code: no node
 * builtins, no DOM access outside that guard.
 *
 * @module
 */

/** The namespaced CSS text injected into the document on module load. */
export const monitorCss = `
.rolebox-monitor {
  box-sizing: border-box;
  padding: 12px 8px;
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
  --rolebox-border-hairline: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  --rolebox-border-subtle: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  --rolebox-border-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  --rolebox-border-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-ink: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  --rolebox-ink-muted: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
  --rolebox-ink-faint: var(--dsw-alias-label-tertiary, rgb(84, 85, 87));
  --rolebox-ink-danger: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-mark-running: var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  --rolebox-mark-failed: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  --rolebox-mark-blocked: var(--dsw-alias-state-warn-label, rgb(221, 134, 41));
  --rolebox-mark-done: var(--dsw-alias-label-tertiary, rgb(84, 85, 87));
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
  --rolebox-radius-mark: 2px;

  --rolebox-dur-fast: 130ms;
  /* The host's own curve (--ds-ease-in-out), shared with the dock. */
  --rolebox-ease: cubic-bezier(0.4, 0, 0.2, 1);
}

.rolebox-monitor-panel {
  width: 100%;
  /* A docked panel can be dragged very wide, and a console is not a document:
     past this measure the reading lanes would trail off into empty space
     instead of staying a block you can take in at one glance. */
  max-width: 680px;
}

/* ── Glyphs and type ──────────────────────────────────────────────────── */

.rolebox-monitor-icon {
  flex: none;
  display: block;
}

/* One box per glyph ROLE, so glyphs of different roles line up in their
   columns: structural marks (section heads, node/loop state, the error mark,
   the band verdict) are 16px SVGs in a 16px box; inline reading glyphs and the
   roster mark are 14px in a 14px box. The box keeps the column aligned, the
   SVG supplies the drawing. */
.rolebox-monitor-section-icon,
.rolebox-monitor-node-glyph,
.rolebox-monitor-loop-glyph,
.rolebox-monitor-error-glyph,
.rolebox-monitor-attention-glyph {
  width: 16px;
  height: 16px;
}

.rolebox-monitor-fact-icon,
.rolebox-monitor-session-glyph {
  width: 14px;
  height: 14px;
}

.rolebox-monitor-sr {
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

.rolebox-monitor-tone-calm {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}

.rolebox-monitor-tone-running {
  color: var(--rolebox-mark-running, rgb(65, 118, 230));
}

.rolebox-monitor-tone-blocked {
  color: var(--rolebox-mark-blocked, rgb(221, 134, 41));
}

.rolebox-monitor-tone-failed {
  color: var(--rolebox-mark-failed, rgb(236, 19, 19));
}

.rolebox-monitor-tone-stopped {
  color: var(--rolebox-mark-done, rgb(84, 85, 87));
}

/* ── Header ───────────────────────────────────────────────────────────── */

.rolebox-monitor-header {
  box-sizing: border-box;
  gap: var(--rolebox-space-1, 4px) var(--rolebox-space-2, 8px);
  padding-bottom: var(--rolebox-space-2, 8px);
  border-bottom: 1px solid var(--rolebox-border-subtle, rgba(0, 0, 0, 0.04));
  display: grid;
  /* The title track may shrink to nothing; the control never does. */
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.rolebox-monitor-title-row {
  min-width: 0;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-title {
  min-width: 0;
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-s-strong-14);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* How updates arrive, and when the snapshot was taken. Not a live region: the
   verdict seat announces, and a ticking timestamp beside it would drown it. */
.rolebox-monitor-live {
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  display: inline-flex;
}

.rolebox-monitor-live-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--rolebox-ink-faint, rgb(84, 85, 87));
}

.rolebox-monitor-live-dot-on {
  background: var(--rolebox-mark-running, rgb(65, 118, 230));
}

.rolebox-monitor-live-dot-pending {
  background: transparent;
  border: 1px solid var(--rolebox-ink-faint, rgb(84, 85, 87));
}

.rolebox-monitor-live-dot-off {
  background: transparent;
  border: 1px dashed var(--rolebox-ink-faint, rgb(84, 85, 87));
}

.rolebox-monitor-live-label {
  flex: none;
}

.rolebox-monitor-live-time {
  flex: none;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.rolebox-monitor-refresh {
  box-sizing: border-box;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  background: transparent;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxxs-strong-11);
  cursor: pointer;
  display: inline-flex;
  font: var(--dsw-font-xxs-12);
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

/* The Refresh control's own glyph, so it reads as a control at the top of a
   wide panel rather than as an empty slab. */
.rolebox-monitor-button-glyph {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  display: grid;
  place-items: center;
}

.rolebox-monitor-spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 2px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-top-color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  border-radius: 999px;
  animation: rolebox-monitor-spin 800ms linear infinite;
  animation-delay: 120ms;
}

.rolebox-monitor-status {
  min-width: 0;
  grid-column: 1 / -1;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
}

.rolebox-monitor-status-error {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  border-bottom: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
}

/* ── The chip: one shell for every categorical value ──────────────────── */

.rolebox-monitor-chip {
  box-sizing: border-box;
  flex: none;
  align-items: center;
  gap: var(--rolebox-space-1, 4px);
  height: 22px;
  padding: 0 7px;
  border-radius: var(--rolebox-radius-chip, 6px);
  display: inline-flex;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxs-strong-12);
  transition: background-color var(--rolebox-dur-fast, 130ms) var(--rolebox-ease, cubic-bezier(0.4, 0, 0.2, 1));
}

/* The quiet half of the family: a role name, a metric label. Same shell, no
   state tint, because it carries no state. */
.rolebox-monitor-chip-quiet {
  box-sizing: border-box;
  flex: none;
  max-width: 100%;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--rolebox-radius-chip, 6px);
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxs-12);
  display: inline-flex;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* The neutral chips differ in KIND, not only in alpha: idle is a soft fill,
   stopped is a fill plus a border, queued is hollow. The word stays the
   primary channel. */
.rolebox-monitor-chip-idle {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-monitor-chip-stopped {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
}

.rolebox-monitor-chip-pending {
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
}

.rolebox-monitor-chip-unknown {
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
}

.rolebox-monitor-raw {
  min-width: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── The glyph lane ───────────────────────────────────────────────────── */

.rolebox-monitor-facts,
.rolebox-monitor-node-facts,
.rolebox-monitor-attention-facts {
  min-width: 0;
  margin: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  display: flex;
}

.rolebox-monitor-fact {
  min-width: 0;
  align-items: center;
  gap: 5px;
  display: inline-flex;
}

.rolebox-monitor-fact-icon {
  flex: none;
  color: var(--rolebox-ink-faint, rgb(84, 85, 87));
  place-items: center;
  display: grid;
}

.rolebox-monitor-fact-word {
  margin: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  white-space: nowrap;
}

.rolebox-monitor-fact-value {
  min-width: 0;
  margin: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.rolebox-monitor-note {
  margin: 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  overflow-wrap: anywhere;
}

/* ── Verdict band ─────────────────────────────────────────────────────── */

.rolebox-monitor-attention {
  box-sizing: border-box;
  gap: var(--rolebox-space-2, 8px);
  padding: var(--rolebox-space-3, 12px);
  border: 1px solid transparent;
  border-radius: var(--rolebox-radius-card, 12px);
  display: grid;
}

.rolebox-monitor-attention-alert {
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  border-color: var(--rolebox-border-danger, rgb(236, 19, 19));
}

.rolebox-monitor-attention-calm {
  background: transparent;
  padding: var(--rolebox-space-2, 8px) 0 0;
}

.rolebox-monitor-attention-head {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--rolebox-space-1, 4px) var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-attention-glyph {
  flex: none;
  width: 16px;
  height: 16px;
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
  font: var(--dsw-font-s-strong-14);
}

.rolebox-monitor-attention-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-attention-item {
  min-width: 0;
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-attention-item-state {
  flex: none;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-strong-11);
}

.rolebox-monitor-attention-item-label {
  min-width: 0;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Body and section heads ───────────────────────────────────────────── */

.rolebox-monitor-body {
  padding-top: var(--rolebox-space-3, 12px);
  display: grid;
  gap: var(--rolebox-space-6, 24px);
}

.rolebox-monitor-section {
  min-width: 0;
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-section-title,
.rolebox-monitor-sub-title {
  min-width: 0;
  margin: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px var(--rolebox-space-1, 4px);
  display: flex;
}

.rolebox-monitor-section-title {
  padding-bottom: var(--rolebox-space-1, 4px);
  border-bottom: 1px solid var(--rolebox-border-subtle, rgba(0, 0, 0, 0.04));
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-monitor-sub-title {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-strong-11);
}

.rolebox-monitor-section-icon {
  flex: none;
  margin-right: 3px;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  place-items: center;
  display: grid;
}

.rolebox-monitor-section-count {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-sub-count {
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-section-note {
  margin-left: auto;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
}

/* ── Sessions ─────────────────────────────────────────────────────────── */

.rolebox-monitor-session-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
}

.rolebox-monitor-session-row {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px var(--rolebox-space-2, 8px);
  padding: 4px 0;
  border-top: 1px solid var(--rolebox-border-subtle, rgba(0, 0, 0, 0.04));
  display: flex;
}

.rolebox-monitor-session-row:first-child {
  border-top: none;
}

/* The docked session is emphasised by weight and glyph tone only: a ground or
   an inset would shift its column and break the lane's alignment. */
.rolebox-monitor-session-row-current .rolebox-monitor-session-id {
  font-weight: 500;
}

.rolebox-monitor-session-glyph {
  flex: none;
  width: 12px;
  height: 12px;
  place-items: center;
  display: grid;
}

.rolebox-monitor-session-id {
  min-width: 0;
  flex: 0 1 auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rolebox-monitor-session-marker {
  flex: none;
  margin-left: auto;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  white-space: nowrap;
}

/* ── Engine graphs ────────────────────────────────────────────────────── */

.rolebox-monitor-graph {
  min-width: 0;
  padding-top: var(--rolebox-space-3, 12px);
  border-top: 1px solid var(--rolebox-border-hairline, rgba(0, 0, 0, 0.1));
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-graph-head {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--rolebox-space-1, 4px) var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-graph-id {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rolebox-monitor-graph-state {
  flex: none;
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: inline-flex;
}

/* One cell per node, in declaration order: a position-preserving overview,
   never a sample. Hue is one channel of four — height, hollowness and dash
   pattern carry the rest, because the blocked amber does not clear 3:1. */
.rolebox-monitor-strip {
  display: flex;
  gap: 2px;
  height: 8px;
  margin: var(--rolebox-space-1, 4px) 0;
}

.rolebox-monitor-strip-cell {
  box-sizing: border-box;
  flex: 1 1 0;
  min-width: 3px;
  border-radius: var(--rolebox-radius-mark, 2px);
  background: var(--rolebox-mark-done, rgb(84, 85, 87));
}

.rolebox-monitor-strip-blocked {
  /* The spike: the node waiting on a human stands taller than the row.
     align-self is what keeps this ONE cell from stretching like the rest — the
     strip must NOT set align-items, or every cell without an explicit height
     collapses to its border box and disappears. */
  align-self: center;
  height: 12px;
  background: var(--rolebox-mark-blocked, rgb(221, 134, 41));
}

.rolebox-monitor-strip-complete {
  background: var(--rolebox-mark-done, rgb(84, 85, 87));
}

.rolebox-monitor-strip-running {
  background: var(--rolebox-mark-running, rgb(65, 118, 230));
}

.rolebox-monitor-strip-failed {
  background: var(--rolebox-mark-failed, rgb(236, 19, 19));
}

.rolebox-monitor-strip-stopped {
  background: var(--rolebox-mark-done, rgb(84, 85, 87));
  opacity: 0.55;
}

.rolebox-monitor-strip-pending {
  background: transparent;
  border: 1px solid var(--rolebox-ink-faint, rgb(84, 85, 87));
}

.rolebox-monitor-strip-unknown {
  background: transparent;
  border: 1px dashed var(--rolebox-ink-faint, rgb(84, 85, 87));
}

.rolebox-monitor-node-group {
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-node-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
}

.rolebox-monitor-node-row {
  min-width: 0;
  padding: var(--rolebox-space-1, 4px) 0;
  border-top: 1px solid var(--rolebox-border-subtle, rgba(0, 0, 0, 0.04));
  display: grid;
  gap: 1px;
}

.rolebox-monitor-node-row:first-child {
  border-top: none;
}

.rolebox-monitor-node-head {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-node-glyph {
  flex: none;
  width: 12px;
  height: 12px;
  place-items: center;
  display: grid;
}

.rolebox-monitor-node-id {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rolebox-monitor-node-time {
  flex: none;
  margin-left: auto;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}

/* ── Loops ────────────────────────────────────────────────────────────── */

.rolebox-monitor-loop-list {
  display: grid;
  gap: var(--rolebox-space-3, 12px);
}

.rolebox-monitor-loop {
  min-width: 0;
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

.rolebox-monitor-loop-head {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-loop-glyph {
  flex: none;
  width: 12px;
  height: 12px;
  place-items: center;
  display: grid;
}

.rolebox-monitor-loop-id {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rolebox-monitor-loop-bar {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--rolebox-space-1, 4px) var(--rolebox-space-2, 8px);
  display: flex;
}

/* The round bar: one cell per round, capped by ROUND_CELL_LIMIT. Filled cells
   take the ink rather than a state colour — the bar reports progress, and
   progress is not a state. */
.rolebox-monitor-progress {
  flex: none;
  align-items: center;
  gap: 2px;
  display: inline-flex;
}

.rolebox-monitor-progress-cell {
  flex: none;
  width: 8px;
  height: 6px;
  border-radius: var(--rolebox-radius-mark, 2px);
  background: var(--rolebox-surface-hover, rgba(38, 49, 72, 0.06));
}

.rolebox-monitor-progress-on {
  background: var(--rolebox-mark-done, rgb(84, 85, 87));
}

.rolebox-monitor-progress-text {
  margin-left: var(--rolebox-space-1, 4px);
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-strong-11);
  font-variant-numeric: tabular-nums;
}

/* A failure is read as a unit: tint, border and glyph — never a coloured edge
   stripe, which would read as decoration rather than as state. */
.rolebox-monitor-error {
  box-sizing: border-box;
  margin: var(--rolebox-space-1, 4px) 0 0;
  padding: var(--rolebox-space-2, 8px);
  border: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
  border-radius: var(--rolebox-radius-control, 8px);
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxxs-11);
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-error-glyph {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--rolebox-ink-danger, rgb(236, 19, 19));
  display: grid;
  place-items: center;
}

.rolebox-monitor-error-text {
  min-width: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
}

/* ── Metrics ──────────────────────────────────────────────────────────── */

.rolebox-monitor-metric-group {
  display: grid;
  gap: var(--rolebox-space-1, 4px);
}

/* A group boundary is air, not another row: successive groups separate. */
.rolebox-monitor-metric-group + .rolebox-monitor-metric-group {
  padding-top: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-metric-list {
  display: grid;
}

.rolebox-monitor-metric-row {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px var(--rolebox-space-2, 8px);
  padding: 4px 0;
  border-top: 1px solid var(--rolebox-border-subtle, rgba(0, 0, 0, 0.04));
  display: flex;
}

.rolebox-monitor-metric-row:first-child {
  border-top: none;
}

.rolebox-monitor-metric-name {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font-family: var(--rolebox-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.rolebox-monitor-metric-value {
  flex: none;
  margin-left: auto;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
}

.rolebox-monitor-metric-extra {
  flex: 1 1 100%;
  min-width: 0;
  display: grid;
  gap: 3px;
}

/* The distribution strip: one bar per non-empty bucket, width proportional to
   the observations that landed in it. The lengths are data, not design — the
   one place the component sets an inline length. */
.rolebox-monitor-chart {
  display: grid;
  gap: 3px;
}

.rolebox-monitor-chart-bars {
  align-items: flex-end;
  gap: 2px;
  height: 8px;
  display: flex;
}

.rolebox-monitor-chart-bar {
  flex: 1 1 2px;
  min-width: 2px;
  height: 100%;
  border-radius: 1px;
  background: var(--rolebox-mark-done, rgb(84, 85, 87));
  opacity: 0.75;
}

.rolebox-monitor-chart-axis {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
}

/* ── Controls ─────────────────────────────────────────────────────────── */

.rolebox-monitor-more {
  box-sizing: border-box;
  justify-self: start;
  height: 24px;
  padding: 0 var(--rolebox-space-2, 8px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-chip, 6px);
  background: transparent;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-strong-11);
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

/* ── States ───────────────────────────────────────────────────────────── */

.rolebox-monitor-state {
  margin: 0;
  padding: var(--rolebox-space-2, 8px) 0;
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xs-13);
  overflow-wrap: anywhere;
}

.rolebox-monitor-state-error {
  box-sizing: border-box;
  padding: var(--rolebox-space-3, 12px);
  border: 1px solid var(--rolebox-border-danger, rgb(236, 19, 19));
  border-radius: var(--rolebox-radius-card, 12px);
  background: var(--rolebox-surface-failed, rgba(236, 19, 19, 0.05));
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-13);
  display: flex;
  align-items: center;
  gap: var(--rolebox-space-3, 12px);
}

.rolebox-monitor-retry {
  box-sizing: border-box;
  flex: none;
  height: 30px;
  padding: 0 var(--rolebox-space-3, 12px);
  border: 1px solid var(--rolebox-border-strong, rgba(0, 0, 0, 0.12));
  border-radius: var(--rolebox-radius-control, 8px);
  background: transparent;
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xxxs-11);
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

/* The empty state wears a face: a bare sentence reads as a failure, and this
   console must be legible as CALM when nothing is happening. */
.rolebox-monitor-empty {
  display: grid;
  justify-items: center;
  gap: var(--rolebox-space-1, 4px);
  padding: var(--rolebox-space-4, 16px) var(--rolebox-space-2, 8px);
  text-align: center;
}

.rolebox-monitor-empty-icon {
  color: var(--rolebox-ink-faint, rgb(84, 85, 87));
  opacity: 0.65;
  margin-bottom: var(--rolebox-space-1, 4px);
  display: grid;
  place-items: center;
}

.rolebox-monitor-empty-title {
  color: var(--rolebox-ink, rgb(15, 17, 21));
  font: var(--dsw-font-xs-strong-13);
}

.rolebox-monitor-empty-hint {
  color: var(--rolebox-ink-muted, rgb(97, 102, 107));
  font: var(--dsw-font-xxxs-11);
  overflow-wrap: anywhere;
}

/* ── Loading skeleton ─────────────────────────────────────────────────── */

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
  display: grid;
  gap: var(--rolebox-space-2, 8px);
}

.rolebox-monitor-skeleton-row {
  align-items: center;
  gap: var(--rolebox-space-2, 8px);
  display: flex;
}

.rolebox-monitor-skeleton-icon {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
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

.rolebox-monitor-skeleton-bar {
  flex: 1 1 auto;
  height: 10px;
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
  width: 40%;
  height: 14px;
}

.rolebox-monitor-skeleton-bar-half {
  width: 62%;
  height: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .rolebox-monitor-spinner,
  .rolebox-monitor-skeleton-icon,
  .rolebox-monitor-skeleton-bar {
    animation: none;
  }
  .rolebox-monitor-spinner {
    display: none;
  }
  .rolebox-monitor-chip,
  .rolebox-monitor-refresh,
  .rolebox-monitor-retry,
  .rolebox-monitor-more {
    transition: none;
  }
}
`;
/** Plain class-name map — the prefixed names the component uses. */
export const monitorClass = {
  panel: "rolebox-monitor-panel",
  /** Visually hidden, still read: a label carried by a glyph. */
  srOnly: "rolebox-monitor-sr",
  icon: "rolebox-monitor-icon",
  buttonGlyph: "rolebox-monitor-button-glyph",
  chip: "rolebox-monitor-chip",
  chipQuiet: "rolebox-monitor-chip-quiet",
  chipFailed: "rolebox-monitor-chip-failed",
  chipBlocked: "rolebox-monitor-chip-blocked",
  chipStopped: "rolebox-monitor-chip-stopped",
  chipPending: "rolebox-monitor-chip-pending",
  chipIdle: "rolebox-monitor-chip-idle",
  chipComplete: "rolebox-monitor-chip-complete",
  chipRunning: "rolebox-monitor-chip-running",
  chipUnknown: "rolebox-monitor-chip-unknown",
  toneCalm: "rolebox-monitor-tone-calm",
  toneRunning: "rolebox-monitor-tone-running",
  toneBlocked: "rolebox-monitor-tone-blocked",
  toneFailed: "rolebox-monitor-tone-failed",
  toneStopped: "rolebox-monitor-tone-stopped",
  section: "rolebox-monitor-section",
  sectionTitle: "rolebox-monitor-section-title",
  sectionIcon: "rolebox-monitor-section-icon",
  sectionCount: "rolebox-monitor-section-count",
  sectionNote: "rolebox-monitor-section-note",
  subTitle: "rolebox-monitor-sub-title",
  subCount: "rolebox-monitor-sub-count",
  header: "rolebox-monitor-header",
  title: "rolebox-monitor-title",
  titleRow: "rolebox-monitor-title-row",
  live: "rolebox-monitor-live",
  liveDot: "rolebox-monitor-live-dot",
  liveDotOn: "rolebox-monitor-live-dot-on",
  liveDotPending: "rolebox-monitor-live-dot-pending",
  liveDotOff: "rolebox-monitor-live-dot-off",
  liveLabel: "rolebox-monitor-live-label",
  liveTime: "rolebox-monitor-live-time",
  refresh: "rolebox-monitor-refresh",
  spinner: "rolebox-monitor-spinner",
  status: "rolebox-monitor-status",
  statusError: "rolebox-monitor-status-error",
  body: "rolebox-monitor-body",
  facts: "rolebox-monitor-facts",
  fact: "rolebox-monitor-fact",
  factIcon: "rolebox-monitor-fact-icon",
  factWord: "rolebox-monitor-fact-word",
  factValue: "rolebox-monitor-fact-value",
  note: "rolebox-monitor-note",
  raw: "rolebox-monitor-raw",
  attention: "rolebox-monitor-attention",
  attentionAlert: "rolebox-monitor-attention-alert",
  attentionCalm: "rolebox-monitor-attention-calm",
  attentionHead: "rolebox-monitor-attention-head",
  attentionTitle: "rolebox-monitor-attention-title",
  attentionFacts: "rolebox-monitor-attention-facts",
  attentionList: "rolebox-monitor-attention-list",
  attentionItem: "rolebox-monitor-attention-item",
  attentionItemState: "rolebox-monitor-attention-item-state",
  attentionItemLabel: "rolebox-monitor-attention-item-label",
  attentionGlyph: "rolebox-monitor-attention-glyph",
  graph: "rolebox-monitor-graph",
  graphHead: "rolebox-monitor-graph-head",
  graphState: "rolebox-monitor-graph-state",
  graphId: "rolebox-monitor-graph-id",
  strip: "rolebox-monitor-strip",
  stripCell: "rolebox-monitor-strip-cell",
  stripRunning: "rolebox-monitor-strip-running",
  stripComplete: "rolebox-monitor-strip-complete",
  stripFailed: "rolebox-monitor-strip-failed",
  stripBlocked: "rolebox-monitor-strip-blocked",
  stripStopped: "rolebox-monitor-strip-stopped",
  stripPending: "rolebox-monitor-strip-pending",
  stripUnknown: "rolebox-monitor-strip-unknown",
  nodeGroup: "rolebox-monitor-node-group",
  nodeList: "rolebox-monitor-node-list",
  nodeRow: "rolebox-monitor-node-row",
  nodeHead: "rolebox-monitor-node-head",
  nodeGlyph: "rolebox-monitor-node-glyph",
  nodeId: "rolebox-monitor-node-id",
  nodeTime: "rolebox-monitor-node-time",
  nodeFacts: "rolebox-monitor-node-facts",
  loopList: "rolebox-monitor-loop-list",
  loop: "rolebox-monitor-loop",
  loopHead: "rolebox-monitor-loop-head",
  loopGlyph: "rolebox-monitor-loop-glyph",
  loopId: "rolebox-monitor-loop-id",
  loopBar: "rolebox-monitor-loop-bar",
  progress: "rolebox-monitor-progress",
  progressCell: "rolebox-monitor-progress-cell",
  progressOn: "rolebox-monitor-progress-on",
  progressText: "rolebox-monitor-progress-text",
  sessionList: "rolebox-monitor-session-list",
  sessionRow: "rolebox-monitor-session-row",
  sessionRowCurrent: "rolebox-monitor-session-row-current",
  sessionGlyph: "rolebox-monitor-session-glyph",
  sessionId: "rolebox-monitor-session-id",
  sessionMarker: "rolebox-monitor-session-marker",
  metricGroup: "rolebox-monitor-metric-group",
  metricList: "rolebox-monitor-metric-list",
  metricRow: "rolebox-monitor-metric-row",
  metricName: "rolebox-monitor-metric-name",
  metricValue: "rolebox-monitor-metric-value",
  metricExtra: "rolebox-monitor-metric-extra",
  chart: "rolebox-monitor-chart",
  chartBars: "rolebox-monitor-chart-bars",
  chartBar: "rolebox-monitor-chart-bar",
  chartAxis: "rolebox-monitor-chart-axis",
  error: "rolebox-monitor-error",
  errorGlyph: "rolebox-monitor-error-glyph",
  errorText: "rolebox-monitor-error-text",
  state: "rolebox-monitor-state",
  stateError: "rolebox-monitor-state-error",
  retry: "rolebox-monitor-retry",
  empty: "rolebox-monitor-empty",
  emptyIcon: "rolebox-monitor-empty-icon",
  emptyTitle: "rolebox-monitor-empty-title",
  emptyHint: "rolebox-monitor-empty-hint",
  loading: "rolebox-monitor-loading",
  skeleton: "rolebox-monitor-skeleton",
  skeletonCard: "rolebox-monitor-skeleton-card",
  skeletonRow: "rolebox-monitor-skeleton-row",
  skeletonIcon: "rolebox-monitor-skeleton-icon",
  skeletonBar: "rolebox-monitor-skeleton-bar",
  skeletonBarWide: "rolebox-monitor-skeleton-bar-wide",
  skeletonBarHalf: "rolebox-monitor-skeleton-bar-half",
  more: "rolebox-monitor-more",
} as const;

// ── Module-load CSS injection (the exact dsh pattern) ───────────────────────
// Mirrors the dock's sheet: probe for an already-injected style by its
// data-plugin-css marker, then append the style tag once. typeof document
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
