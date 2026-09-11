import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedFunction } from "../types.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../utils/timeout.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("hooks-context");

export function appendCorrection(
  corrections: Map<string, string>,
  sessionID: string,
  text: string,
): void {
  const existing = corrections.get(sessionID);
  corrections.set(sessionID, existing ? existing + "\n" + text : text);
}

export function collectAllFunctions(
  fnMap: Map<string, ResolvedFunction[]>,
): ResolvedFunction[] {
  const result: ResolvedFunction[] = [];
  for (const funcs of fnMap.values()) result.push(...funcs);
  return result;
}

export async function fetchLastAssistantText(
  client: ISessionClient,
  sessionID: string,
): Promise<string | null> {
  try {
    const msgs = await withTimeout(
      client.messages(sessionID),
      DEFAULT_TIMEOUT_MS,
      `fetchLastAssistantText:${sessionID}`,
      log,
    );
    if (msgs === null) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role !== "assistant") continue;
      const text = msgs[i].parts
        .filter((p) => p.type === "text" && "text" in p && typeof (p as { text?: string }).text === "string")
        .map((p) => (p as { text: string }).text)
        .join("");
      return text.length > 0 ? text : null;
    }
    return null;
  } catch {
    return null;
  }
}
