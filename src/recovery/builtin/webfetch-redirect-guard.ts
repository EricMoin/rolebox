import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:webfetch-redirect");

/**
 * Patterns that indicate a redirect loop or HTTP error in webfetch output.
 */
const WEBFETCH_ERROR_PATTERNS = [
  /redirect loop/i,
  /too many redirects/i,
  /redirect.*error/i,
  /HTTP.*redirect/i,
  /3\d{2}.*redirect/i,
  /too many redirects|redirect loop|redirect limit/i,
  /connection refused/i,
  /ETIMEDOUT|ECONNREFUSED|ECONNRESET/i,
  /DNS.*error|ENOTFOUND/i,
  /SSL.*error|certificate.*error/i,
  /status.*(?:404|403|500|502|503)/i,
];

/**
 * Creates the webfetch-redirect-guard built-in hook.
 *
 * Intercepts `webfetch` tool results and detects redirect loops,
 * HTTP errors, or network failures in the output text. Injects a
 * warning and recovery suggestion via `ctx.inject()`.
 *
 * No engine dependency — pure guard with direct injection.
 *
 * @returns A configured BuiltInHookDefinition
 */
export function createWebFetchRedirectGuardHook(): BuiltInHookDefinition {
  return {
    name: "webfetch-redirect-guard",
    configKey: "webfetch_redirect_guard",
    events: ["tool.execute.after"],
    phase: "after",
    priority: 10,
    filter: { tools: ["webfetch"] },
    module: {
      onToolAfter: async (
        ctx: unknown,
        input: { tool: string; args: unknown; output: unknown },
      ) => {
        const hookCtx = ctx as { inject: (text: string) => void };

        const outputText = extractOutputText(input.output);
        if (!outputText) return;

        const matched = WEBFETCH_ERROR_PATTERNS.some((p) => p.test(outputText));
        if (!matched) return;

        log.debug("Webfetch error detected", {
          args: input.args,
          match: outputText.slice(0, 120),
        });

        hookCtx.inject(
          `\n[GUARD] webfetch encountered a network or redirect error. ` +
            `Check that the URL is correct and accessible. If the issue ` +
            `persists, try a simpler URL or verify the target server ` +
            `is reachable.\n`,
        );
      },
    },
  };
}

/**
 * Extract the textual output from a webfetch result.
 */
function extractOutputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.body === "string") return obj.body;
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}
