import type { OpencodeClient } from "@opencode-ai/sdk";
import { SUMMARIZER_TIMEOUT_MS, SUMMARY_INPUT_CHAR_CAP } from "./constants.js";

const SUMMARY_SYSTEM_PROMPT =
  "Output a concise progress summary as plain text with no preamble. " +
  "Include: what was accomplished this round, current state, and context " +
  "for the next round. Do not include actions or tool calls — only the summary.";

type SummarizeResult =
  | { ok: true; summary: string }
  | { ok: false };

type SummarizeFn = (
  agent: string,
  conversation: string,
) => Promise<SummarizeResult>;

export function createSummarizerFn(
  client: OpencodeClient,
  opts?: { timeoutMs?: number },
): SummarizeFn {
  const timeoutMs = opts?.timeoutMs ?? SUMMARIZER_TIMEOUT_MS;

  return async function summarize(
    agent: string,
    conversation: string,
  ): Promise<SummarizeResult> {
    try {
      const createResult = await client.session.create({});
      if ((createResult as { error?: unknown }).error) return { ok: false };

      const sessionId = (
        (createResult as { data?: { id?: string } }).data
      )?.id;
      if (!sessionId) return { ok: false };

      try {
        const capped =
          conversation.length > SUMMARY_INPUT_CHAR_CAP
            ? conversation.slice(-SUMMARY_INPUT_CHAR_CAP)
            : conversation;

        const promptPromise = client.session.prompt({
          path: { id: sessionId },
          body: {
            agent,
            system: SUMMARY_SYSTEM_PROMPT,
            parts: [{ type: "text", text: capped }],
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        );

        const promptResult = await Promise.race([promptPromise, timeoutPromise]);

        if ((promptResult as { error?: unknown }).error) return { ok: false };

        const data = (promptResult as {
          data?: { parts: Array<{ type: string; text?: string }> };
        }).data;
        const text =
          data?.parts
            ?.filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("")
            .trim() ?? "";

        if (!text) return { ok: false };

        return { ok: true, summary: text };
      } finally {
        client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    } catch {
      return { ok: false };
    }
  };
}
