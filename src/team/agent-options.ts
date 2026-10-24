/**
 * Team member agent options — resolve the provider/model (and sampling limits)
 * a durable team peer runs with.
 *
 * A DSH team peer is an independent agent whose model must be chosen before the
 * session is created. Two sources can supply it:
 *
 *   - the role definition, composed by the platform registrar into
 *     `agentOptions` (a `provider/model` split from `role.yaml`, degraded to
 *     model-only when the declared provider route has no registered adapter);
 *   - the host's own default selection (`agentDefaultModel`), which is the only
 *     usable model on a headless host whose roles declare no model.
 *
 * The two cannot be mixed blindly: pairing an unregistered provider's model id
 * with the default provider silently routes a peer to a model it never asked
 * for. This module therefore keeps the pairing rules explicit and pure, so the
 * entry point and their tests share one decision.
 *
 * @module
 */

/** The DSH agent options a team peer session is created/resumed with. */
export interface TeamAgentOptions {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface ResolveTeamAgentOptionsInput {
  /** The role's raw `model` declaration (`role.config.model`), possibly `provider/model`. */
  roleModel?: string;
  /** Options the platform registrar composed for the role. */
  composed?: TeamAgentOptions;
  /** The host's default selection, when the host exposes one. */
  fallback?: TeamAgentOptions;
}

export interface ResolvedTeamAgentOptions {
  /** The options to spawn with, or `undefined` when no usable selection exists. */
  agentOptions?: TeamAgentOptions;
  /** True when the host default supplied the provider (and possibly the model). */
  usedFallback: boolean;
}

/** Copy only well-formed fields so callers always receive a fresh object. */
function copy(options: TeamAgentOptions | undefined): TeamAgentOptions {
  const result: TeamAgentOptions = {};
  if (!options) return result;
  if (typeof options.provider === "string" && options.provider) result.provider = options.provider;
  if (typeof options.model === "string" && options.model) result.model = options.model;
  if (typeof options.reasoningEffort === "string" && options.reasoningEffort) result.reasoningEffort = options.reasoningEffort;
  if (typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens)) result.maxTokens = options.maxTokens;
  return result;
}

/**
 * Resolve the agent options for a team peer.
 *
 * Precedence:
 *   1. A complete composed selection (provider AND model) is used as-is.
 *   2. Without a usable host default there is nothing to spawn with.
 *   3. A role that declared its own provider (`roleModel` contains `/`) but
 *      whose composed selection lost the provider (the provider route was
 *      unregistered, so the registrar degraded it to model-only) or lost its
 *      model falls back to the FULL host default — its model id is never
 *      paired with the default provider.
 *   4. A role that declared only a model (no `/`) keeps that model and takes
 *      the provider from the host default.
 *   5. Anything else uses the full host default.
 *
 * `reasoningEffort`/`maxTokens` are preserved: a role-declared value wins,
 * otherwise the host default's value is kept. Both returned objects are fresh;
 * neither input is mutated.
 *
 * @param input - Role declaration, composed options and host fallback.
 * @returns The spawn options and whether the host default was used.
 */
export function resolveTeamAgentOptions({ roleModel, composed, fallback }: ResolveTeamAgentOptionsInput): ResolvedTeamAgentOptions {
  const composedOptions = copy(composed);
  const fallbackOptions = copy(fallback);
  if (composedOptions.provider && composedOptions.model) return { agentOptions: composedOptions, usedFallback: false };
  if (!fallbackOptions.provider || !fallbackOptions.model) return { agentOptions: undefined, usedFallback: false };
  const merged: TeamAgentOptions = { ...fallbackOptions };
  if (composedOptions.reasoningEffort) merged.reasoningEffort = composedOptions.reasoningEffort;
  if (composedOptions.maxTokens !== undefined) merged.maxTokens = composedOptions.maxTokens;
  const declaredProvider = typeof roleModel === "string" && roleModel.includes("/");
  if (!declaredProvider && composedOptions.model && !composedOptions.provider) {
    return { agentOptions: { ...merged, model: composedOptions.model }, usedFallback: true };
  }
  return { agentOptions: merged, usedFallback: true };
}
