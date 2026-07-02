import type { PluginInput } from "@opencode-ai/plugin";
import type { ResolvedFunction } from "../types.ts";

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
  client: PluginInput["client"],
  sessionID: string,
): Promise<string | null> {
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    if ((res as { error?: unknown }).error !== undefined) return null;
    const msgs = ((res as { data?: unknown }).data ?? []) as Array<{
      info: { role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role !== "assistant") continue;
      const text = msgs[i].parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      return text.length > 0 ? text : null;
    }
    return null;
  } catch {
    return null;
  }
}
