import { truncateText } from "../utils/text-format.ts";

// ── Text Escaping ──────────────────────────────────────────────────────

/**
 * Escape backslashes then double quotes for AppleScript string literals.
 */
export function escapeAppleScriptText(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escape single quotes for PowerShell single-quoted strings.
 * Replaces `'` with `''` (double the single quote).
 */
export function escapePowerShellSingleQuotedText(input: string): string {
  return input.replace(/'/g, "''");
}

/**
 * Escape for bash single-quoted strings.
 * Replaces `'` with `'\''` (close quote, escaped quote, reopen quote).
 */
export function escapeBashText(input: string): string {
  return input.replace(/'/g, "'\\''");
}

// ── Platform-Specific Script Builders ─────────────────────────────────

/**
 * Generate a complete PowerShell script that creates a Windows toast
 * notification using `[Windows.UI.Notifications.ToastNotificationManager]`.
 * Returns a single-line script with `; ` separators.
 */
export function buildWindowsToastScript(
  title: string,
  message: string,
): string {
  const escapedTitle = escapePowerShellSingleQuotedText(title);
  const escapedMessage = escapePowerShellSingleQuotedText(message);

  const lines = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$RawXml = [xml] $Template.GetXml()",
    `($RawXml.toast.visual.binding.text | Where-Object {\\$_.id -eq '1'}).AppendChild($RawXml.CreateTextNode('${escapedTitle}')) | Out-Null`,
    `($RawXml.toast.visual.binding.text | Where-Object {\\$_.id -eq '2'}).AppendChild($RawXml.CreateTextNode('${escapedMessage}')) | Out-Null`,
    "$SerializedXml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$SerializedXml.LoadXml($RawXml.OuterXml)",
    "$Toast = [Windows.UI.Notifications.ToastNotification]::new($SerializedXml)",
    "$Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenCode')",
    "$Notifier.Show($Toast)",
  ];

  return lines.join("; ");
}

// ── Text Truncation ───────────────────────────────────────────────────

/**
 * Truncate a string with a trailing "…" if it exceeds `maxLen`.
 * Returns `""` when `maxLen <= 0`.
 *
 * One-line delegation to the canonical `truncateText` in
 * `src/utils/text-format.ts` (same "…" and same inclusive budget).
 */
export function truncate(str: string, maxLen: number): string {
  return truncateText(str, maxLen);
}

// ── macOS Notification (osascript) ────────────────────────────────────

/**
 * Build the full `osascript` command string for a macOS notification.
 */
export function buildAppleScriptNotification(
  title: string,
  message: string,
): string {
  const escapedTitle = escapeAppleScriptText(title);
  const escapedMessage = escapeAppleScriptText(message);
  return `display notification "${escapedMessage}" with title "${escapedTitle}"`;
}

// ── Linux Notification (notify-send) ─────────────────────────────────

/**
 * Build the argument array for `notify-send`.
 * Title and message are passed as separate args so no escaping is needed.
 */
export function buildNotifySendCommand(
  title: string,
  message: string,
): string[] {
  return ["--urgency=normal", title, message];
}
