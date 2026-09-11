/**
 * Monitor renderer — public API re-exports.
 *
 * All rendering logic has been split into focused modules under
 * `src/cli/commands/renderer/`. This file maintains backward
 * compatibility by re-exporting the same public surface as before.
 *
 * @module
 */

export {
  filterAndSortTasks,
  renderSystemPulse,
  renderRecovery,
  renderMetrics,
  renderNotifications,
  renderTaskDetail,
  renderHuman,
  renderJson,
  renderPrometheus,
  DiffRenderer,
} from "../renderer/index.ts";

export type { HumanRenderOptions } from "../renderer/index.ts";
