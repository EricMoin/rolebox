/**
 * IHookProvider — port interface for providing hook handlers to a host
 * platform's plugin system.
 *
 * Both the Opencode plugin (via HookService) and the Pi extension
 * (via PiLightweightServiceStack) produce handler sets consumed by
 * their respective host platforms. This port defines the common
 * contract so that Pi tool registration can be recognized as a
 * valid hook provider conforming to the same shape as opencode's
 * HookService.getHandlers().
 *
 * Must NOT import from @opencode-ai/plugin or @opencode-ai/sdk.
 */

/**
 * Port interface for hook handler provision.
 *
 * A hook provider assembles tool definitions, lifecycle handlers,
 * and agent configuration into a single handler map. The exact shape
 * of the returned map is platform-specific — opencode expects
 * `tool`, `event`, `config`, `chat.message`, `tool.execute.after`,
 * `tool.execute.before`, `experimental.chat.system.transform`,
 * `experimental.session.compacting`, and `dispose` keys — but the
 * port only requires that `tool` be present. Additional keys are
 * optional and platform-specific.
 */
export interface IHookProvider {
  /**
   * Return the assembled hook handlers.
   *
   * The returned map must at minimum contain a `tool` key whose
   * value is a record of named platform-native tool definitions.
   * Additional handler keys (`event`, `config`, `chat.message`,
   * `tool.execute.after`, `tool.execute.before`,
   * `experimental.*`, `dispose`) are platform-specific.
   */
  getHandlers(): Record<string, unknown>;
}
