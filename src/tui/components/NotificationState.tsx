/**
 * TUI notification state panel.
 *
 * Adapted from the CLI renderer's `renderNotifications()` in status-format.ts.
 * Renders only when `snap.notifications` is present.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import type { ThemeColors } from "../helpers.ts";
import {
  rgbaToCSS, BOLD, DIM, G_SUB,
} from "../helpers.ts";
import type {
  MonitorSnapshot,
} from "../../cli/commands/monitor/monitor-reader.ts";

// ── Glyphs ───────────────────────────────────────────────────────────

const G_ENABLED  = "\u2713";  // ✓
const G_DISABLED = "\u2717";  // ✗

// ── Render: notification state panel ─────────────────────────────────

export function renderNotificationState(props: { c: ThemeColors; snap: MonitorSnapshot | null }) {
  const { c, snap } = props;
  const notif = snap?.notifications;

  if (!notif) return null;

  const parts: unknown[] = [];

  // Enabled / disabled
  const enabledGlyph = notif.enabled ? G_ENABLED : G_DISABLED;
  const enabledColor = notif.enabled ? c.success : c.error;
  parts.push(
    <text>
      <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  enabled"}</span>
      <span fg={rgbaToCSS(enabledColor)}>{" " + enabledGlyph}</span>
    </text>,
  );

  // Quiet hours
  if (notif.quietHoursActive) {
    parts.push(
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  quiet hours"}</span>
        <span fg={rgbaToCSS(c.warning)}> active</span>
      </text>,
    );
  }

  // Throttle stats
  if (notif.throttleStats) {
    parts.push(
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  throttle"}</span>
        <span fg={rgbaToCSS(c.text)}>{" " + notif.throttleStats.recentCount + "/" + notif.throttleStats.windowMs + "ms"}</span>
      </text>,
    );
  }

  // Recent events (last 3)
  if (notif.recentEvents.length > 0) {
    parts.push(<text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " recent events"}</text>);
    const recent = notif.recentEvents.slice(-3);
    for (const evt of recent) {
      const ts = evt.ts.length > 19 ? evt.ts.slice(0, 19) : evt.ts;
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"    " + ts}</span>
          <span fg={rgbaToCSS(c.text)}>{" " + evt.type}</span>
        </text>,
      );
    }
  }

  if (parts.length === 0) return null;

  return (
    <box marginBottom={1}>
      <text fg={rgbaToCSS(c.textMuted)} attributes={BOLD}>{"\u2500 notification"}</text>
      {parts}
    </box>
  );
}
