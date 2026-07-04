import type { ExtensionConfig, ExtensionEntry, RecoveryStrategyEntry, RecoveryPatternEntry, NotificationChannelEntry, TopologyModule, TerminationParserModule } from "./types.ts";
import { loadExtensionModule } from "./loader.ts";
import { createSubLogger } from "../logger.ts";
import { registerTopology } from "../graph/templates.ts";
import { registerTerminationParser } from "../graph/parser.ts";
import { addGraphTemplateValue } from "../constants.ts";
import { registerCondition } from "../function/conditions.ts";
import type { ConditionModule, RecoveryStrategyModule, RecoveryPatternModule, NotificationChannelModule, ObserveHandlerModule } from "./types.ts";

const log = createSubLogger("ext:registry");

/**
 * Central coordinator for the Plugin Extension Registry.
 * 
 * Each extension scope (conditions, graph_topologies, etc.) has its own
 * registration method. The loadExtensions() method dispatches each category
 * from the YAML config to the appropriate register method.
 * 
 * Individual register methods are filled in by subtasks 3-7. Until then,
 * they are stubs that log a "not yet implemented" warning.
 */
export class ExtensionRegistry {
  private loadedStrategies = new Map<string, RecoveryStrategyModule>();
  private loadedPatterns = new Map<string, RecoveryPatternModule>();

  getLoadedStrategies(): Map<string, RecoveryStrategyModule> { return this.loadedStrategies; }
  getLoadedPatterns(): Map<string, RecoveryPatternModule> { return this.loadedPatterns; }
  /**
   * Load and register all extensions from an ExtensionConfig.
   * Dispatches each category to its dedicated handler method.
   * Safe to call with undefined/null config (no-op).
   */
  async loadExtensions(
    config: ExtensionConfig | undefined | null,
    roleDir: string,
  ): Promise<void> {
    if (!config) return;

    if (config.conditions) {
      await this.loadConditions(config.conditions, roleDir);
    }
    if (config.graph_topologies) {
      await this.loadGraphTopologies(config.graph_topologies, roleDir);
    }
    if (config.termination_conditions) {
      await this.loadTerminationConditions(config.termination_conditions, roleDir);
    }
    if (config.recovery_strategies) {
      await this.loadRecoveryStrategies(config.recovery_strategies, roleDir);
    }
    if (config.recovery_patterns) {
      await this.loadRecoveryPatterns(config.recovery_patterns, roleDir);
    }
    if (config.notification_channels) {
      await this.loadNotificationChannels(config.notification_channels, roleDir);
    }
    if (config.notification_events) {
      await this.loadNotificationEvents(config.notification_events, roleDir);
    }
    if (config.observe_events) {
      await this.loadObserveEvents(config.observe_events, roleDir);
    }
  }

  // ── Per-scope loaders (stubs — filled in by subtasks 3-7) ────────

  protected async loadConditions(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      // Check if module exports the expected handler
      const conditionMod = mod as Partial<ConditionModule>;
      if (typeof conditionMod.handler === "function") {
        registerCondition(entry.name, conditionMod.handler);
        log.debug("Registered custom condition", { name: entry.name });
      } else {
        log.warn("Extension module missing handler function", {
          name: entry.name,
          module: entry.module,
          exports: Object.keys(mod),
        });
      }
    }
  }

  protected async loadGraphTopologies(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const topoMod = mod as Partial<TopologyModule>;
      if (typeof topoMod.expand === "function") {
        registerTopology(entry.name, topoMod.expand);
        addGraphTemplateValue(entry.name);
        log.debug("Registered custom graph topology", { name: entry.name });
      } else {
        log.warn("Topology module missing expand function", { name: entry.name, module: entry.module });
      }
    }
  }

  protected async loadTerminationConditions(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const termMod = mod as Partial<TerminationParserModule>;
      if (typeof termMod.parse === "function") {
        // Adapt the module's 2-param parse (value, availableAgents) to the
        // registry's 3-param signature (value, fullObj, availableAgents)
        registerTerminationParser(
          entry.name,
          (value, _fullObj, availableAgents) => termMod.parse!(value, availableAgents),
        );
        log.debug("Registered custom termination condition parser", { name: entry.name });
      } else {
        log.warn("Termination module missing parse function", { name: entry.name, module: entry.module });
      }
    }
  }
  protected async loadRecoveryStrategies(entries: RecoveryStrategyEntry[], roleDir: string): Promise<void> {
    // Import dynamically to avoid circular dependency
    const { addKnownStrategy } = await import("../recovery/config.ts");

    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const stratMod = mod as Partial<RecoveryStrategyModule>;
      if (stratMod.name && typeof stratMod.execute === "function") {
        // Register strategy name so parseChain accepts it
        addKnownStrategy(entry.name);
        this.loadedStrategies.set(entry.name, mod as RecoveryStrategyModule);
        log.debug("Registered custom recovery strategy name", { name: entry.name });
      } else {
        log.warn("Recovery strategy module missing name/execute", { name: entry.name, module: entry.module });
      }
    }
  }

  protected async loadRecoveryPatterns(entries: RecoveryPatternEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const patternMod = mod as Partial<RecoveryPatternModule>;
      if (patternMod.name && typeof patternMod.match === "function") {
        this.loadedPatterns.set(entry.name, mod as RecoveryPatternModule);
        log.debug("Loaded custom recovery pattern module", { name: entry.name });
      } else {
        log.warn("Recovery pattern module missing name/match", { name: entry.name, module: entry.module });
      }
    }
  }
  protected async loadNotificationChannels(entries: NotificationChannelEntry[], roleDir: string): Promise<void> {
    const { registerChannelFactory } = await import("../notifications/channels.ts");

    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const channelMod = mod as Partial<NotificationChannelModule>;
      if (typeof channelMod.create === "function") {
        registerChannelFactory(entry.kind, async (config) => {
          const channel = channelMod.create!(config);
          return {
            kind: entry.kind,
            send: channel.send,
            dispose: channel.dispose,
          };
        });
        log.debug("Registered custom notification channel", { kind: entry.kind });
      } else {
        log.warn("Notification channel module missing create function", { kind: entry.kind, module: entry.module });
      }
    }
  }

  protected async loadNotificationEvents(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      log.debug("Notification event type registered as open string", { name: entry.name });
    }
  }

  protected async loadObserveEvents(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    const { registerObserveHandler } = await import("../function/observe.ts");

    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const observeMod = mod as Partial<ObserveHandlerModule>;
      if (typeof observeMod.handle === "function") {
        registerObserveHandler(entry.name, observeMod.handle);
        log.debug("Registered custom observe event handler", { name: entry.name });
      } else {
        log.warn("Observe module missing handle function", { name: entry.name, module: entry.module });
      }
    }
  }

  /** Dispose all registered extensions. */
  async dispose(): Promise<void> {
    // Subtasks will override this to dispose registered resources
    log.debug("ExtensionRegistry disposed");
  }
}
