// ── Template rendering, variable building, and session info reading ──

import type { ISessionClient } from "../platform/ports/session-client.ts";
import { createSubLogger } from "../logger.ts";
import { truncate } from "./formatting.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../utils/timeout.ts";
import type {
  NotificationMessage,
  NotificationEventType,
  NotificationEventConfig,
  NotificationTemplateVars,
} from "./types.ts";

const log = createSubLogger("notification-content");

// ── Template Rendering ──────────────────────────────────────────────

/**
 * Simple `{var_name}` template replacement.
 *
 * Replaces all `{identifier}` placeholders with their corresponding value
 * from `vars`. Unknown variables remain as-is in the output.
 *
 * @param template - Template string containing `{var_name}` placeholders.
 * @param vars - Flat key-value map of template variables.
 * @returns The rendered string with variables substituted.
 */
export function renderTemplate(
  template: string,
  vars: NotificationTemplateVars,
): string {
  if (template.length === 0) return "";
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

// ── Template Variable Builder ───────────────────────────────────────

/**
 * Build a flat `NotificationTemplateVars` record from session and event params.
 *
 * Every key is guaranteed to exist (empty string for missing optional fields).
 * `timestamp` is set to the current time at call time.
 */
export function buildTemplateVars(params: {
  sessionId: string;
  eventType: NotificationEventType;
  agent?: string;
  roleName?: string;
  sessionTitle?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}): NotificationTemplateVars {
  return {
    session_id: params.sessionId,
    session_title: params.sessionTitle ?? params.sessionId,
    event_type: params.eventType as string,
    agent: params.agent ?? "",
    role_name: params.roleName ?? "",
    last_user_message: params.lastUserMessage ?? "",
    last_assistant_message: params.lastAssistantMessage ?? "",
    timestamp: new Date().toISOString(),
  };
}

// ── Message Part Extraction ─────────────────────────────────────────

/**
 * Extract text from message parts where `type === "text"`.
 * Trims each text segment, filters out empty strings, and joins with `\n`.
 */
export function extractMessageText(
  parts: Array<{ type: string; text?: string }>,
): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text as string).trim())
    .filter((t) => t.length > 0)
    .join("\n");
}

// ── Text Utilities ──────────────────────────────────────────────────

/**
 * Collapse multi-line whitespace into a single line.
 * Splits by newlines, trims each line, filters empties, and joins with a single space.
 */
export function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

/**
 * Get the last non-empty line from a multi-line string.
 * Splits by newlines, trims each line, filters empties, and returns the last
 * element, or `""` if there are no non-empty lines.
 */
export function getLastNonEmptyLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

// ── Session Info Reader ─────────────────────────────────────────────

/**
 * Read session title and last user/assistant messages from the opencode SDK.
 *
 * API calls are wrapped in try/catch — failures return an empty object
 * (never throws).
 *
 * The optional `dir` parameter controls which project workspace is queried.
 *
 * @param client - The opencode plugin client for SDK API calls.
 * @param sessionID - The session ID to read.
 * @param dir - Optional workspace directory (defaults to `process.cwd()`).
 * @returns Session title, last user message text, and last assistant message text.
 */
export async function readSessionInfo(
  client: ISessionClient,
  sessionID: string,
  dir?: string,
): Promise<{
  title?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}> {
  // 1. Get session title
  let title: string | undefined;
  try {
    const sessionResult = await withTimeout(
      client.get(sessionID, dir),
      DEFAULT_TIMEOUT_MS,
      `readSessionInfo.session.get:${sessionID}`,
      log,
    );
    if (sessionResult !== null) {
      title = sessionResult.title;
    }
  } catch (err) {
    log.warn(`Failed to get session ${sessionID}`, err);
  }

  // 2. Get messages (last user + last assistant)
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  try {
    const msgs = await withTimeout(
      client.messages(sessionID, { directory: dir }),
      DEFAULT_TIMEOUT_MS,
      `readSessionInfo.session.messages:${sessionID}`,
      log,
    );
    if (msgs === null) {
      // timeout — return title only
      return { title };
    }

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      const text = extractMessageText(msg.parts);

      if (text.length === 0) continue;

      if (msg.info.role === "user" && lastUserMessage === undefined) {
        lastUserMessage = text;
      } else if (
        msg.info.role === "assistant" &&
        lastAssistantMessage === undefined
      ) {
        lastAssistantMessage = text;
      }

      if (lastUserMessage !== undefined && lastAssistantMessage !== undefined) {
        break;
      }
    }
  } catch (err) {
    log.warn(`Failed to get messages for session ${sessionID}`, err);
  }

  return { title, lastUserMessage, lastAssistantMessage };
}

// ── Primary Content Builder ─────────────────────────────────────────

/**
 * Build a fully populated `NotificationMessage` by reading session info
 * and rendering event-appropriate templates.
 *
 * Default templates:
 * - Title: `"Rolebox · {event_type}"`
 * - Body: `"{session_title}"`
 *
 * Title is truncated to 256 characters, body to 4000 characters.
 * On any error, returns a minimal `NotificationMessage` with the raw fields.
 *
 * @param params - Parameters including session ID, event type, optional
 *                 event config, client, agent, role name, directory, and
 *                 any extra template variables (e.g. graph_id / node_id for
 *                 structured events) merged over the base vars before rendering.
 * @returns A fully populated `NotificationMessage`.
 */
export async function buildNotificationContent(params: {
  sessionID: string;
  eventType: NotificationEventType;
  eventConfig?: NotificationEventConfig;
  client: ISessionClient;
  agent?: string;
  roleName?: string;
  dir?: string;
  extraVars?: NotificationTemplateVars;
}): Promise<NotificationMessage> {
  const {
    sessionID,
    eventType,
    eventConfig,
    client,
    agent,
    roleName,
    dir,
    extraVars,
  } = params;

  let sessionTitle: string | undefined;
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;

  try {
    const info = await readSessionInfo(client, sessionID, dir);
    sessionTitle = info.title;
    lastUserMessage = info.lastUserMessage;
    lastAssistantMessage = info.lastAssistantMessage;
  } catch (err) {
    log.warn(
      `Error reading session info for notification content (${sessionID})`,
      err,
    );
  }

  const timestamp = new Date().toISOString();

  const baseVars = buildTemplateVars({
    sessionId: sessionID,
    eventType,
    agent,
    roleName,
    sessionTitle,
    lastUserMessage,
    lastAssistantMessage,
  });
  // Extra vars (e.g. graph_id / node_id for structured events) override the
  // base vars so event-specific templates can reference them.
  const vars = extraVars ? { ...baseVars, ...extraVars } : baseVars;

  try {
    const titleTemplate =
      eventConfig?.titleTemplate ?? "Rolebox · {event_type}";
    const messageTemplate =
      eventConfig?.messageTemplate ?? "{session_title}";

    const title = truncate(renderTemplate(titleTemplate, vars), 256);
    const body = truncate(renderTemplate(messageTemplate, vars), 4000);

    return {
      title,
      body,
      sessionId: sessionID,
      eventType,
      agent,
      roleName,
      timestamp,
      lastUserMessage,
      lastAssistantMessage,
    };
  } catch (err) {
    log.warn(
      `Error building notification content for session ${sessionID}`,
      err,
    );

    const titleTemplate =
      eventConfig?.titleTemplate ?? "Rolebox · {event_type}";
    const messageTemplate =
      eventConfig?.messageTemplate ?? "{session_title}";

    return {
      title: truncate(renderTemplate(titleTemplate, vars), 256),
      body: truncate(renderTemplate(messageTemplate, vars), 4000),
      sessionId: sessionID,
      eventType,
      agent,
      roleName,
      timestamp,
      lastUserMessage,
      lastAssistantMessage,
    };
  }
}
