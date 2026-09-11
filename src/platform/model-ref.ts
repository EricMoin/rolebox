/**
 * Platform-neutral model-reference parsing.
 *
 * rolebox stores fully-resolved models (aliases already applied) as
 * `"<provider>/<model-id>"`, where the model id itself may contain slashes
 * (e.g. `"openrouter-anthropic/anthropic/claude-opus-4.8"`). The provider is the
 * segment before the first slash; everything after is the model id.
 *
 * This lives in the platform layer (no SDK imports) so every adapter can share
 * one parsing contract instead of re-deriving it per platform.
 *
 * @module
 */

/** A resolved model reference split into its provider and model id. */
export interface ModelRef {
  /** Provider segment before the first slash (e.g. `"openrouter-anthropic"`). */
  provider: string;
  /** Model id — everything after the first slash (may contain slashes). */
  id: string;
}

/**
 * Parse a resolved model string into a `{ provider, id }` pair.
 *
 * Splits on the **first** slash so multi-segment model ids survive intact.
 *
 * @param model - Resolved model string, or undefined.
 * @returns The split pair, or null when the model is empty/`"default"`/malformed
 *   (no slash, leading slash, or trailing slash).
 */
export function splitModel(model: string | undefined): ModelRef | null {
  if (!model || model === "default") return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return null;
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
