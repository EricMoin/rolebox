/**
 * Typed entry point to the plugin handler map for the suites that drive the
 * real hook pipeline.
 *
 * `createPluginHooks` has two return paths: the handler map `HookService`
 * assembles for opencode, and `buildNoOpHandlers()` — the degraded fallback
 * that keeps opencode alive when hook-service never initialized. That fallback
 * is annotated `Record<string, unknown>` on purpose (its keys are checked
 * against the host `Hooks` contract by `satisfies Hooks`), so the union of the
 * two paths erases every handler signature and `hooks["chat.message"](...)`
 * does not type-check against production.
 *
 * These suites exercise the healthy path, so they narrow through the guard
 * below rather than widening production to fit a test: the map under test is
 * the one production returns, typed exactly as production declares it.
 */
import { createPluginHooks } from "../../src/core/composition.ts";
import type { CreatePluginHooksConfig } from "../../src/core/composition.ts";
import type { HookService } from "../../src/core/services/hook-service.ts";

/** The handler map `HookService` assembles for opencode — production's own type. */
export type PluginHookHandlers = ReturnType<HookService["getHandlers"]>;

/**
 * Structural check that a value is a usable handler map.
 *
 * The degraded fallback carries the same keys as the assembled map (all of
 * them no-ops), so this cannot tell the two paths apart — a suite that received
 * the fallback still fails on its behavioural assertions. What it rejects is a
 * map whose handlers are missing, i.e. the empty wrapper of a hook-service that
 * never ran, and it narrows to production's declared handler type.
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
 * handler map with production's type, throwing instead of handing back a map
 * without handlers, so a suite cannot silently drive no-ops.
 */
export async function createHealthyPluginHooks(
  config: CreatePluginHooksConfig,
): Promise<PluginHookHandlers> {
  const hooks = await createPluginHooks(config);
  if (!isPluginHookHandlers(hooks)) {
    throw new Error("createPluginHooks returned a handler map without the expected handlers");
  }
  return hooks;
}
