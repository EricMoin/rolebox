/**
 * Typed entry point to the plugin handler map for the suites that drive the
 * real hook pipeline.
 *
 * `createPluginHooks` returns `Record<string, unknown>` now that the core no
 * longer imports the host's `Hooks` type: the hook provider is
 * platform-neutral and the host-shaped signatures live with the hosting
 * entry/adapter. These suites drive the opencode path, so they narrow through
 * the test-local host-shaped interface below and cast once — tests may know
 * the host contract even though production core does not.
 */
import { createPluginHooks } from "../../src/core/composition.ts";
import type { CreatePluginHooksConfig } from "../../src/core/composition.ts";
import { normalizeOpencodeEvent } from "../../src/platform/adapters/opencode/event-bridge.ts";

/**
 * The opencode-shaped handler map these suites drive. It mirrors the handlers
 * `HookService` assembles plus the adapter-provided `config` contribution;
 * every signature is the host's, not the core's.
 */
export interface PluginHookHandlers {
  tool: Record<string, unknown>;
  event: (input: { event: unknown }) => Promise<void>;
  "chat.message": (
    input: { agent?: string; sessionID: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: { [key: string]: unknown } },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { sessionID?: string; tool?: string; callID?: string; args?: unknown },
    output: unknown,
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string; agent?: string },
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.session.compacting": (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
  config?: (config: Record<string, unknown>) => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * Configuration accepted by the helper: the production config with only the
 * now-required `normalizeEvent` made optional (the helper supplies the
 * opencode normalizer by default).
 */
type HealthyHooksConfig = Omit<CreatePluginHooksConfig, "normalizeEvent"> & {
  normalizeEvent?: CreatePluginHooksConfig["normalizeEvent"];
};

/**
 * Structural check that a value is a usable handler map.
 *
 * The degraded fallback carries the same keys as the assembled map (all of
 * them no-ops), so this cannot tell the two paths apart — a suite that received
 * the fallback still fails on its behavioural assertions. What it rejects is a
 * map whose handlers are missing, i.e. the empty wrapper of a hook-service that
 * never ran, and it narrows (once) to the host-shaped interface.
 */
function isPluginHookHandlers(value: unknown): value is PluginHookHandlers {
  if (typeof value !== "object" || value === null) return false;
  return (
    "event" in value &&
    typeof value.event === "function" &&
    "chat.message" in value &&
    typeof value["chat.message"] === "function" &&
    "dispose" in value &&
    typeof value.dispose === "function"
  );
}

/**
 * `createPluginHooks` for the healthy path: calls production and returns its
 * handler map with the host-shaped type, throwing instead of handing back a
 * map without handlers, so a suite cannot silently drive no-ops.
 */
export async function createHealthyPluginHooks(
  config: HealthyHooksConfig,
): Promise<PluginHookHandlers> {
  const hooks = await createPluginHooks({
    ...config,
    normalizeEvent: config.normalizeEvent ?? normalizeOpencodeEvent,
  });
  if (!isPluginHookHandlers(hooks)) {
    throw new Error("createPluginHooks returned a handler map without the expected handlers");
  }
  return hooks;
}
