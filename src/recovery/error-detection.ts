import type { ErrorPattern, RecoveryError, RecoveryErrorCategory } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("recovery:detect");

export class PatternRegistry {
  private patterns: ErrorPattern[] = [];

  register(pattern: ErrorPattern): void {
    this.patterns.push(pattern);
    log.debug("Registered error pattern", { name: pattern.name, category: pattern.category });
  }

  /** Detect all matching errors (a single error may match multiple patterns) */
  detect(error: unknown): RecoveryError[] {
    const results: RecoveryError[] = [];
    for (const pattern of this.patterns) {
      try {
        const match = pattern.match(error);
        if (match) results.push(match);
      } catch (err) {
        log.debug("Error pattern threw during match", { name: pattern.name, err });
      }
    }
    return results;
  }

  /** Detect the first matching error */
  detectFirst(error: unknown): RecoveryError | null {
    for (const pattern of this.patterns) {
      try {
        const match = pattern.match(error);
        if (match) return match;
      } catch {
        // Continue to next pattern
      }
    }
    return null;
  }

  /** Detect errors of a specific category */
  detectCategory(error: unknown, category: RecoveryErrorCategory): RecoveryError | null {
    for (const pattern of this.patterns) {
      if (pattern.category !== category) continue;
      try {
        const match = pattern.match(error);
        if (match) return match;
      } catch {
        // Continue
      }
    }
    return null;
  }

  clear(): void {
    this.patterns = [];
  }
}

// ── Helper: extract error message from various error formats ──
function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.error === "object" && obj.error !== null) {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
      if (typeof inner.type === "string") return inner.type;
    }
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.title === "string") return obj.title;
  }
  return String(error ?? "");
}

// ── Helper: check if string contains any of the patterns ──
function containsAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

// ── Helper: check if string matches any regex ──
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function createDefaultPatterns(): ErrorPattern[] {
  return [
    // 1. API / Session errors
    {
      name: "api-error",
      category: "session_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        // Check for common API error indicators
        if (typeof error === "object" && error !== null) {
          const obj = error as Record<string, unknown>;
          const errVal = obj.error;
          const hasType = typeof errVal === "object" && errVal !== null && "type" in errVal;
          if (hasType || obj.code || obj.status) {
            return {
              category: "session_error",
              errorType: "api_error",
              message: msg,
              raw: error,
              timestamp: Date.now(),
            };
          }
        }
        return null;
      },
    },
    // 2. Timeout errors
    {
      name: "timeout",
      category: "session_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (containsAny(msg, ["timeout", "timed out", "deadline exceeded", "ETIMEDOUT"])) {
          return {
            category: "session_error",
            errorType: "timeout",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    // 3. Tool unavailable
    {
      name: "tool-unavailable",
      category: "session_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (matchesAny(msg, [/tool.*not found/i, /unknown tool/i, /unavailable tool/i])) {
          return {
            category: "session_error",
            errorType: "unavailable_tool",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    // 4. Context window / token limit errors (provider-agnostic)
    {
      name: "token-limit",
      category: "context_window",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (containsAny(msg, [
          "context_length_exceeded",
          "maximum context length",
          "reduce the length",
          "too many tokens",
          "token limit",
          "context window",
          "context_length",
          "maximum_tokens",
        ])) {
          return {
            category: "context_window",
            errorType: "token_limit",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    // 5. Edit tool errors
    {
      name: "edit-not-found",
      category: "edit_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (msg.includes("oldString not found") || msg.includes("oldString not found in content")) {
          return {
            category: "edit_error",
            errorType: "oldstring_not_found",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    {
      name: "edit-multiple-matches",
      category: "edit_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (msg.includes("oldString found multiple times") || msg.includes("multiple matches")) {
          return {
            category: "edit_error",
            errorType: "multiple_matches",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    {
      name: "edit-same-content",
      category: "edit_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        if (msg.includes("oldString and newString must be different")) {
          return {
            category: "edit_error",
            errorType: "same_content",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    // 6. JSON parse errors in tool arguments
    {
      name: "json-parse-error",
      category: "json_error",
      match: (error): RecoveryError | null => {
        const msg = extractMessage(error);
        if (!msg) return null;
        const jsonPatterns: RegExp[] = [
          /unexpected token/i,
          /unexpected end of json/i,
          /json parse error/i,
          /invalid json/i,
          /expected property name/i,
          /unterminated string/i,
          /trailing comma/i,
          /unescaped.*quote/i,
        ];
        if (matchesAny(msg, jsonPatterns)) {
          return {
            category: "json_error",
            errorType: "json_parse",
            message: msg,
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
    // 7. Empty response
    {
      name: "empty-response",
      category: "empty_response",
      match: (error): RecoveryError | null => {
        if (typeof error === "object" && error !== null) {
          const obj = error as Record<string, unknown>;
          const output = typeof obj.output === "string" ? obj.output : "";
          if (output.trim().length < 5) {
            return {
              category: "empty_response",
              errorType: "empty_output",
              message: "Tool output was empty or too short",
              raw: error,
              timestamp: Date.now(),
            };
          }
        }
        if (typeof error === "string" && error.trim().length < 5) {
          return {
            category: "empty_response",
            errorType: "empty_output",
            message: "Response was empty or too short",
            raw: error,
            timestamp: Date.now(),
          };
        }
        return null;
      },
    },
  ];
}
