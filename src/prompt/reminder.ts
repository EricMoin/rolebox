/**
 * Unified system-reminder builder — single source of truth for all
 * `<system-reminder>` XML blocks across the dispatch and graph subsystems.
 *
 * Output format (Scheme B: structured minimal):
 * ```
 * <system-reminder>
 * [MARKER]
 * key: value
 * key: value
 *
 * → action instruction
 * </system-reminder>
 * ```
 *
 * Rules enforced here that every call-site formerly replicated by hand:
 * - No markdown bold (`**…**`). Fields use plain `key: value`.
 * - No consecutive spaces for visual alignment. Fields are one-per-line by
 *   default; `inline: true` fields join with a single space.
 * - Marker string is passed through verbatim — it is a contract string
 *   matched by `isDispatchNotification()`.
 * - Empty/null-value fields are omitted (no "N/A").
 * - Action lines are prefixed with `→ ` and separated from the data block
 *   by a blank line. Multiple actions each get their own `→ ` line.
 * - Body is embedded as free text and may contain line breaks.
 */

export interface ReminderField {
  label: string;
  value: string;
  /** Join with preceding field(s) using a single space (same line). */
  inline?: boolean;
}

export interface BuildReminderOpts {
  /** Contract marker, emitted verbatim. Omit for marker-less reminders. */
  marker?: string;
  /** Key-value data fields. */
  fields?: ReminderField[];
  /** Next-step instruction(s). Multiple lines: each line gets `→ ` prefix. */
  action?: string;
  /** Free-form body (approval notes, multi-line explanations, etc.). */
  body?: string;
  /**
   * Compact single-line mode — all content on one line inside the
   * `<system-reminder>` wrapper. Fields are space-joined; action
   * follows after ` → `; body appends. No newlines anywhere.
   */
  compact?: boolean;
}

// ── Internals ───────────────────────────────────────────────────────────────

const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";
const ACTION_PREFIX = "→ ";

function isEmptyValue(field: ReminderField): boolean {
  return field.value === "" || field.value === undefined || (field.value as unknown) === null;
}

/**
 * Render fields block. Non-inline fields are one per line (`label: value`).
 * Inline fields are joined with the preceding line via a single space.
 *
 * Trailing consecutive spaces are forbidden — this intentionally avoids
 * the visual-alignment anti-pattern that wastes tokens across 11 call-sites.
 */
function renderFields(fields: ReminderField[]): string[] {
  const nonEmpty = fields.filter((f) => !isEmptyValue(f));
  if (nonEmpty.length === 0) return [];

  const lines: string[] = [];
  let buf = "";

  for (const f of nonEmpty) {
    const segment = `${f.label}: ${f.value}`;
    if (f.inline && buf.length > 0) {
      buf += " " + segment;
    } else if (buf.length > 0) {
      // flush previous non-inline or end-of-inline chain
      lines.push(buf);
      buf = segment;
    } else {
      buf = segment;
    }
  }
  if (buf.length > 0) lines.push(buf);

  return lines;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a `<system-reminder>` block.
 *
 * @example Plain marker
 *   buildReminder({ marker: "[GRAPH NODE COMPLETED]" })
 *
 * @example Marker + fields + action
 *   buildReminder({
 *     marker: "[GRAPH NODE COMPLETED]",
 *     fields: [
 *       { label: "Graph", value: "g1" },
 *       { label: "Node", value: "n1" },
 *     ],
 *     action: "Use graph_status to inspect the result.",
 *   })
 *
 * @example Marker + body (approval gate)
 *   buildReminder({
 *     marker: "[BLOCKED: NEEDS APPROVAL]",
 *     body: "The result is ready for review.",
 *   })
 */
export function buildReminder(opts: BuildReminderOpts): string {
  // ── Compact (single-line) mode ────────────────────────────────────────
  if (opts.compact) {
    const parts: string[] = [];
    if (opts.marker) parts.push(opts.marker);
    const fieldLines = opts.fields ? renderFields(opts.fields) : [];
    for (const fl of fieldLines) parts.push(fl);
    const data = parts.join(" ");
    const compactLines: string[] = [REMINDER_OPEN];

    let body = data;
    if (opts.action !== undefined && opts.action !== "") {
      const actionPart = opts.action.split("\n").map((s) => s.trim()).filter((s) => s.length > 0).join(" ");
      body = body.length > 0 ? `${body} ${ACTION_PREFIX}${actionPart}` : `${ACTION_PREFIX}${actionPart}`;
    }
    if (opts.body !== undefined && opts.body !== "") {
      body = body.length > 0 ? `${body} ${opts.body}` : opts.body;
    }

    compactLines.push(body, REMINDER_CLOSE);
    return compactLines.join("");
  }

  // ── Normal (multi-line) mode ───────────────────────────────────────────
  const lines: string[] = [REMINDER_OPEN];
  if (opts.marker) lines.push(opts.marker);

  // Data fields
  const fieldLines = opts.fields ? renderFields(opts.fields) : [];
  for (const fl of fieldLines) lines.push(fl);

  // Action block — separated by a blank line from preceding content
  if (opts.action !== undefined && opts.action !== "") {
    lines.push(""); // blank separator
    const actionLines = opts.action.split("\n");
    for (const al of actionLines) {
      const trimmed = al.trim();
      if (trimmed.length > 0) {
        lines.push(`${ACTION_PREFIX}${trimmed}`);
      }
    }
  }

  // Free-form body (embedded as-is)
  if (opts.body !== undefined && opts.body !== "") {
    lines.push("", opts.body);
  }

  lines.push(REMINDER_CLOSE);
  return lines.join("\n");
}
