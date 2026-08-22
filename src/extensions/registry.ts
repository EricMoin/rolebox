import type { ExtensionConfig, ExtensionEntry, RecoveryStrategyModule, RecoveryPatternModule } from "./types.ts";
import type { ExtensionPoint } from "./extension-point.ts";
import { createSubLogger } from "../logger.ts";
import {
  ConditionExtensionPoint,
  GraphTopologyExtensionPoint,
  TerminationConditionExtensionPoint,
  RecoveryStrategyExtensionPoint,
  RecoveryPatternExtensionPoint,
  NotificationChannelExtensionPoint,
  NotificationEventExtensionPoint,
  ObserveEventExtensionPoint,
} from "./points/index.ts";

const log = createSubLogger("ext:registry");

/**
 * Central coordinator for the Plugin Extension Registry.
 *
 * The registry holds a map of ExtensionPoints, one per scope.  When
 * loadExtensions() is called, it iterates over the config and delegates
 * each scope's entries to the matching ExtensionPoint.
 *
 * Public API:
 *   - loadExtensions(config, roleDir)
 *   - getLoadedStrategies()
 *   - getLoadedPatterns()
 *   - dispose()
 *   - registerExtensionPoint(point)   // for third-party or test points
 */
export class ExtensionRegistry {
  private readonly points = new Map<string, ExtensionPoint>();
  private readonly strategiesPoint: RecoveryStrategyExtensionPoint;
  private readonly patternsPoint: RecoveryPatternExtensionPoint;

  constructor() {
    // Instantiate all built-in extension points and hold references to
    // the two that expose loaded-module state.
    const conditions = new ConditionExtensionPoint();
    const graphTopologies = new GraphTopologyExtensionPoint();
    const terminationConditions = new TerminationConditionExtensionPoint();
    this.strategiesPoint = new RecoveryStrategyExtensionPoint();
    this.patternsPoint = new RecoveryPatternExtensionPoint();
    const notificationChannels = new NotificationChannelExtensionPoint();
    const notificationEvents = new NotificationEventExtensionPoint();
    const observeEvents = new ObserveEventExtensionPoint();

    // Register every point by its scope name.
    const builtins: ExtensionPoint[] = [
      conditions,
      graphTopologies,
      terminationConditions,
      this.strategiesPoint,
      this.patternsPoint,
      notificationChannels,
      notificationEvents,
      observeEvents,
    ];
    for (const point of builtins) {
      this.points.set(point.name, point);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Register an additional ExtensionPoint.  This lets third-party
   * scopes or test fixtures inject new points without modifying the
   * registry class.
   */
  registerExtensionPoint(point: ExtensionPoint): void {
    this.points.set(point.name, point);
  }

  getLoadedStrategies(): Map<string, RecoveryStrategyModule> {
    return this.strategiesPoint.getLoadedStrategies();
  }

  getLoadedPatterns(): Map<string, RecoveryPatternModule> {
    return this.patternsPoint.getLoadedPatterns();
  }

  /**
   * Load and register all extensions from an ExtensionConfig.
   * Dispatches each scope to its registered ExtensionPoint.
   * Safe to call with undefined/null config (no-op).
   */
  async loadExtensions(
    config: ExtensionConfig | undefined | null,
    roleDir: string,
  ): Promise<void> {
    if (!config) return;

    for (const [scope, entries] of Object.entries(config)) {
      if (!entries) continue;
      const point = this.points.get(scope);
      if (point) {
        await point.load(entries as ExtensionEntry[], roleDir);
      }
    }
  }

  /** Dispose all registered extension points. */
  async dispose(): Promise<void> {
    for (const point of this.points.values()) {
      if (point.dispose) {
        await point.dispose();
      }
    }
    log.debug("ExtensionRegistry disposed");
  }
}
