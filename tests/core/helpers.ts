/**
 * Shared fixtures for the tests/core suite.
 */

import type { ISessionClient } from "../../src/platform/ports/session-client.ts";

/**
 * Inert ISessionClient double: every method resolves to the empty value.
 *
 * Typed as the port itself rather than through a cast, so a change to
 * ISessionClient breaks this fixture instead of silently leaving the
 * PluginContext fixtures behind the contract they claim to implement.
 */
export function makeSessionClient(): ISessionClient {
  return {
    list: async () => [],
    get: async () => null,
    messages: async () => [],
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    fork: async () => null,
    status: async () => null,
    prompt: async () => null,
    promptSync: async () => null,
    create: async () => null,
    abort: async () => false,
  };
}
