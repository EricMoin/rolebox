/**
 * Shared DispatchManager factory.
 *
 * Platform-agnostic: does NOT import from @opencode-ai/plugin or
 * @earendil-works/pi-coding-agent. Both platform entry points
 * (DispatchService on OpenCode, pi-extension on Pi) use this factory
 * to construct a DispatchManager with identical configuration and
 * lineage registration logic.
 *
 * @module
 */

import { DispatchManager } from "./core/manager.ts";
import {
  mergeConfig,
  resolveEnvConfig,
  DEFAULT_CONFIG,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_SYNC_RESERVED_SLOTS,
} from "./config.ts";
import type { DispatchManagerConfig } from "./config.ts";
import type { IConcurrencyManager } from "./concurrency/concurrency.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";
import { RoleMode } from "../constants.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("dispatch-factory");

/** Options for createDispatchManager. */
export interface CreateDispatchManagerOptions {
  /** Platform-specific session client (OpenCode SDK, Pi process spawn, etc.). */
  sessionClient: ISessionClient;
  /** Fully resolved roles (with subagents already expanded). */
  resolvedRoles: ResolvedRole[];
  /** Directory used for task state persistence. */
  storeDirectory: string;
  /** Optional primary role override (if omitted, the factory finds the first primary role). */
  primaryRole?: ResolvedRole;
  /** Optional config overrides applied with highest precedence. */
  configOverrides?: Partial<DispatchManagerConfig>;
}

/** Return value of createDispatchManager. */
export interface CreateDispatchManagerResult {
  manager: DispatchManager;
  resolvedSubagents: Map<string, { parentFullId: string }>;
  subagentModelKey: Map<string, string>;
  /** Set if `recover()` failed. The manager is still usable with empty state. */
  recoverError?: Error;
}

/**
 * Result of {@link buildSubagentLineage}.
 */
export interface SubagentLineageResult {
  resolvedSubagents: Map<string, { parentFullId: string }>;
  subagentModelKey: Map<string, string>;
}

/**
 * Builds resolvedSubagents and subagentModelKey maps from resolved roles.
 * Models cascade down: a child without an explicit model inherits its
 * parent's model.
 *
 * Exported separately so callers that already have a cached
 * DispatchManager (e.g., DispatchService on hot-reload) can rebuild
 * lineage maps without constructing a new manager.
 */
export function buildSubagentLineage(
  resolvedRoles: ResolvedRole[],
): SubagentLineageResult {
  const resolvedSubagents = new Map<string, { parentFullId: string }>();
  const subagentModelKey = new Map<string, string>();

  function registerSubagentLineage(
    subagents: ResolvedSubAgent[],
    parentFullId: string,
    parentModel: string | undefined,
  ): void {
    for (const sub of subagents) {
      resolvedSubagents.set(sub.id, { parentFullId });
      const model = sub.config.model ?? parentModel;
      const key = model ? model : "default";
      subagentModelKey.set(sub.id, key);
      if (sub.subagents.length > 0) {
        registerSubagentLineage(sub.subagents, sub.id, model);
      }
    }
  }

  for (const role of resolvedRoles) {
    registerSubagentLineage(role.subagents, role.id, role.config.model);
  }

  return { resolvedSubagents, subagentModelKey };
}

/**
 * Create a fully initialized DispatchManager.
 *
 * Handles subagent lineage registration, config merge (default → primary
 * role dispatch config → env overrides → configOverrides), custom
 * concurrency policy resolution, manager construction, setStoreDirectory,
 * and recover().
 *
 * If recover() fails, the error is returned as `recoverError` in the
 * result rather than thrown. The manager is still usable with empty state.
 * Platform entry points decide how to handle recovery failure (OpenCode
 * degrades gracefully; Pi aborts initialization).
 */
export async function createDispatchManager(
  opts: CreateDispatchManagerOptions,
): Promise<CreateDispatchManagerResult> {
  const {
    sessionClient,
    resolvedRoles,
    storeDirectory,
    primaryRole,
    configOverrides,
  } = opts;

  // 1. Build subagent lineage maps.
  const { resolvedSubagents, subagentModelKey } =
    buildSubagentLineage(resolvedRoles);

  // 2. Determine primary role if not provided.
  const primaries = resolvedRoles.filter(
    (r) => r.config.mode === RoleMode.Primary,
  );
  let effectivePrimaryRole = primaryRole;
  if (!effectivePrimaryRole) {
    if (primaries.length > 1) {
      // Multiple primaries: prefer the first (in resolvedRoles array order)
      // that carries a dispatch config block (the config-bearing role);
      // otherwise keep the historical first-primary pick.
      effectivePrimaryRole =
        primaries.find((r) => r.dispatchConfig !== undefined) ?? primaries[0];
    } else {
      effectivePrimaryRole = primaries[0];
    }
  }
  if (primaries.length > 1) {
    log.warn(
      `multiple roles declare mode: primary (${primaries.map((r) => r.id).join(", ")}); ` +
        `using "${effectivePrimaryRole?.id ?? "none"}" as the dispatch primary`,
    );
  }

  // 3. Merge config with precedence: default → role dispatch config → env → overrides.
  const mergedConfig = mergeConfig(
    DEFAULT_CONFIG,
    effectivePrimaryRole?.dispatchConfig,
    resolveEnvConfig(),
  );
  const finalConfig = configOverrides
    ? { ...mergedConfig, ...configOverrides }
    : mergedConfig;

  // 4. Resolve custom concurrency policy from primary role config.
  let customConcurrency: IConcurrencyManager | undefined;
  if (effectivePrimaryRole?.dispatchConfig?.concurrency_policy) {
    customConcurrency = effectivePrimaryRole.dispatchConfig.concurrency_policy(
      finalConfig.maxConcurrent,
      finalConfig.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
      finalConfig.syncReservedSlots ?? DEFAULT_SYNC_RESERVED_SLOTS,
      finalConfig.retryAfterMs,
    );
  }

  // 5. Construct DispatchManager.
  const manager = new DispatchManager(
    sessionClient,
    finalConfig,
    subagentModelKey,
    customConcurrency,
  );

  // 6. Set store directory and recover.
  manager.setStoreDirectory(storeDirectory);
  let recoverError: Error | undefined;
  try {
    await manager.recover();
  } catch (err) {
    recoverError = err instanceof Error ? err : new Error(String(err));
  }

  return { manager, resolvedSubagents, subagentModelKey, recoverError };
}
