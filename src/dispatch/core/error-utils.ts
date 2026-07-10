/**
 * Extract a human-readable error message from various session.error shapes.
 *
 * Opencode session.error payloads vary (Error | string | { name, data: { message } }).
 * String(obj) would yield "[object Object]" and hide the real cause, so dig out a message.
 */
export function extractSessionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error.trim() || "Unknown session error";
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    const data = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
    const msg = data.message ?? o.message;
    const name = typeof o.name === "string" ? o.name : undefined;
    if (typeof msg === "string" && msg.trim()) {
      return name && name !== msg ? `${name}: ${msg}` : msg;
    }
    if (name && name.trim()) return name;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      return String(error);
    }
  }
  return error !== undefined ? String(error) : "Unknown session error";
}
