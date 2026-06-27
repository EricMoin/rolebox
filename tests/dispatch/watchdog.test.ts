import { describe, it, expect, mock } from "bun:test";
import { TaskWatchdogManager } from "../../src/dispatch/watchdog";
import {
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
} from "../../src/dispatch/config";

function noop(): void {}

interface DepMocks {
  onReconcile: ReturnType<typeof mock>;
  onSweep: ReturnType<typeof mock>;
  onDebounceElapsed: ReturnType<typeof mock>;
}

function createMocks(): DepMocks {
  return {
    onReconcile: mock(noop),
    onSweep: mock(noop),
    onDebounceElapsed: mock(noop),
  };
}

function createManager(mocks: DepMocks = createMocks()): TaskWatchdogManager {
  return new TaskWatchdogManager(mocks, {
    watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
    globalSweepIntervalMs: GLOBAL_SWEEP_INTERVAL_MS,
    idleDebounceMs: IDLE_DEBOUNCE_MS,
  });
}

describe("TaskWatchdogManager", () => {
  // ── 1. registerTask + unregisterTask ────────────────────────────────
  describe("registerTask / unregisterTask", () => {
    it("registerTask adds task to registry", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      expect(mgr.getRegisteredTaskIds()).toEqual(["task-1"]);
    });

    it("unregisterTask removes task from registry", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.unregisterTask("task-1");
      expect(mgr.getRegisteredTaskIds()).toEqual([]);
    });

    it("registerTask is idempotent — second call is a no-op", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-1");
      expect(mgr.getRegisteredTaskIds()).toEqual(["task-1"]);

      // Only one watchdog callback should fire on trigger
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).toHaveBeenCalledTimes(1);
    });

    it("unregisterTask of unknown task is a no-op", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.unregisterTask("no-such-task");
      expect(mgr.getRegisteredTaskIds()).toEqual([]);
    });
  });

  // ── 2. Global sweep lifecycle ──────────────────────────────────────
  describe("global sweep lifecycle", () => {
    it("sweep calls onSweep for all registered tasks", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-2");
      mgr.registerTask("task-3");

      mgr.triggerSweep();
      expect(m.onSweep).toHaveBeenCalledTimes(3);
      expect(m.onSweep).toHaveBeenNthCalledWith(1, "task-1");
      expect(m.onSweep).toHaveBeenNthCalledWith(2, "task-2");
      expect(m.onSweep).toHaveBeenNthCalledWith(3, "task-3");
    });

    it("sweep does nothing when no tasks are registered", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.triggerSweep();
      expect(m.onSweep).not.toHaveBeenCalled();
    });

    it("after unregistering last task, sweep is a no-op", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.unregisterTask("task-1");

      mgr.triggerSweep();
      expect(m.onSweep).not.toHaveBeenCalled();
    });
  });

  // ── 3. resetWatchdog ───────────────────────────────────────────────
  describe("resetWatchdog", () => {
    it("triggerWatchdog calls onReconcile once for registered task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).toHaveBeenCalledTimes(1);
      expect(m.onReconcile).toHaveBeenCalledWith("task-1");
    });

    it("resetWatchdog does not cause extra onReconcile calls", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.resetWatchdog("task-1");
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).toHaveBeenCalledTimes(1);
    });

    it("resetWatchdog is no-op for unregistered task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.resetWatchdog("no-such-task");
      mgr.triggerWatchdog("no-such-task");
      expect(m.onReconcile).not.toHaveBeenCalled();
    });

    it("triggerWatchdog is no-op after unregister", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.unregisterTask("task-1");
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).not.toHaveBeenCalled();
    });
  });

  // ── 4. startDebounce + cancelDebounce ───────────────────────────────
  describe("startDebounce / cancelDebounce", () => {
    it("startDebounce sets isDebouncing to true", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      expect(mgr.isDebouncing("task-1")).toBe(true);
    });

    it("cancelDebounce sets isDebouncing to false", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.cancelDebounce("task-1");
      expect(mgr.isDebouncing("task-1")).toBe(false);
    });

    it("triggerDebounce does NOT fire if debounce was cancelled", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.cancelDebounce("task-1");
      mgr.triggerDebounce("task-1");
      expect(m.onDebounceElapsed).not.toHaveBeenCalled();
    });

    it("triggerDebounce calls onDebounceElapsed with correct taskId", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.triggerDebounce("task-1");
      expect(m.onDebounceElapsed).toHaveBeenCalledTimes(1);
      expect(m.onDebounceElapsed).toHaveBeenCalledWith("task-1");
    });

    it("startDebounce replaces any existing debounce for that task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.startDebounce("task-1");
      mgr.triggerDebounce("task-1");
      expect(m.onDebounceElapsed).toHaveBeenCalledTimes(1);
    });

    it("startDebounce is no-op for unregistered task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.startDebounce("no-such-task");
      expect(mgr.isDebouncing("no-such-task")).toBe(false);
    });
  });

  // ── 5. isDebouncing ────────────────────────────────────────────────
  describe("isDebouncing", () => {
    it("isDebouncing is true only for the debounced task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-2");

      mgr.startDebounce("task-1");
      expect(mgr.isDebouncing("task-1")).toBe(true);
      expect(mgr.isDebouncing("task-2")).toBe(false);
    });

    it("isDebouncing becomes false after triggerDebounce", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      expect(mgr.isDebouncing("task-1")).toBe(true);

      mgr.triggerDebounce("task-1");
      expect(mgr.isDebouncing("task-1")).toBe(false);
    });

    it("isDebouncing is false for unknown task", () => {
      const m = createMocks();
      const mgr = createManager(m);

      expect(mgr.isDebouncing("no-such-task")).toBe(false);
    });
  });

  // ── 6. dispose() ───────────────────────────────────────────────────
  describe("dispose", () => {
    it("dispose clears all registered tasks", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-2");
      mgr.dispose();
      expect(mgr.getRegisteredTaskIds()).toEqual([]);
    });

    it("triggerWatchdog is no-op after dispose", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.dispose();
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).not.toHaveBeenCalled();
    });

    it("triggerSweep is no-op after dispose", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.dispose();
      mgr.triggerSweep();
      expect(m.onSweep).not.toHaveBeenCalled();
    });

    it("triggerDebounce is no-op after dispose", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.dispose();
      mgr.triggerDebounce("task-1");
      expect(m.onDebounceElapsed).not.toHaveBeenCalled();
    });

    it("dispose is safe to call multiple times", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.dispose();
      mgr.dispose();
      mgr.dispose();
      expect(mgr.getRegisteredTaskIds()).toEqual([]);
    });

    it("registerTask is no-op after dispose", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.dispose();
      mgr.registerTask("task-1");
      expect(mgr.getRegisteredTaskIds()).toEqual([]);
    });

    it("dispose with active debounce clears it", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.startDebounce("task-1");
      mgr.dispose();
      expect(mgr.isDebouncing("task-1")).toBe(false);
    });
  });

  // ── 7. Idempotent registerTask ─────────────────────────────────────
  describe("idempotent registerTask", () => {
    it("registerTask twice creates only one watchdog", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-1");

      // Trigger the watchdog — only one onReconcile should fire
      mgr.triggerWatchdog("task-1");
      expect(m.onReconcile).toHaveBeenCalledTimes(1);
    });

    it("registerTask twice does not duplicate in sweep", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-1");
      mgr.registerTask("task-1");
      expect(mgr.getRegisteredTaskIds()).toEqual(["task-1"]);

      mgr.triggerSweep();
      // Should only sweep once, not twice
      expect(m.onSweep).toHaveBeenCalledTimes(1);
    });
  });

  // ── 8. Multiple tasks ──────────────────────────────────────────────
  describe("multiple tasks", () => {
    it("each task has independent watchdog", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-a");
      mgr.registerTask("task-b");
      mgr.registerTask("task-c");

      mgr.triggerWatchdog("task-a");
      expect(m.onReconcile).toHaveBeenCalledTimes(1);
      expect(m.onReconcile).toHaveBeenCalledWith("task-a");

      mgr.triggerWatchdog("task-b");
      expect(m.onReconcile).toHaveBeenCalledTimes(2);
      expect(m.onReconcile).toHaveBeenCalledWith("task-b");
    });

    it("sweep fires onSweep for all 3 tasks", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-a");
      mgr.registerTask("task-b");
      mgr.registerTask("task-c");

      mgr.triggerSweep();
      expect(m.onSweep).toHaveBeenCalledTimes(3);
    });

    it("unregistering one task does not affect others", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-a");
      mgr.registerTask("task-b");
      mgr.unregisterTask("task-a");

      expect(mgr.getRegisteredTaskIds()).toEqual(["task-b"]);

      mgr.triggerSweep();
      expect(m.onSweep).toHaveBeenCalledTimes(1);
      expect(m.onSweep).toHaveBeenCalledWith("task-b");
    });

    it("debounce per task is independent", () => {
      const m = createMocks();
      const mgr = createManager(m);

      mgr.registerTask("task-a");
      mgr.registerTask("task-b");

      mgr.startDebounce("task-a");
      expect(mgr.isDebouncing("task-a")).toBe(true);
      expect(mgr.isDebouncing("task-b")).toBe(false);

      mgr.startDebounce("task-b");
      expect(mgr.isDebouncing("task-b")).toBe(true);

      mgr.triggerDebounce("task-a");
      expect(m.onDebounceElapsed).toHaveBeenCalledTimes(1);
      expect(m.onDebounceElapsed).toHaveBeenCalledWith("task-a");
      expect(mgr.isDebouncing("task-a")).toBe(false);
      expect(mgr.isDebouncing("task-b")).toBe(true);
    });
  });
});
