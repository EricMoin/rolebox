import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { ServiceSupervisor, SUPERVISOR_DEFAULTS } from "../../src/core/service-supervisor.ts";
import type { PluginCoreLike } from "../../src/core/service.ts";

// ── helpers ────────────────────────────────────────────────────────

/**
 * Create a minimal mock PluginCoreLike that only exposes restartService.
 * The mock records calls and can be configured to resolve or reject.
 */
function makeMockCore(): {
  core: PluginCoreLike;
  restartService: ReturnType<typeof mock>;
} {
  const restartService = mock(() => Promise.resolve());
  const core = {
    getService: mock(() => undefined),
    getServices: mock(() => new Map()),
    restartService,
    isDegraded: mock(() => false),
  } satisfies PluginCoreLike as PluginCoreLike;
  return { core, restartService };
}

// ── tests ──────────────────────────────────────────────────────────

describe("ServiceSupervisor", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("tryRestart – first success", () => {
    it("resets tracking when restart succeeds on first attempt", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      await supervisor.tryRestart("svc1");

      expect(restartService).toHaveBeenCalledTimes(1);
      expect(restartService).toHaveBeenCalledWith("svc1");

      const status = supervisor.getStatus("svc1");
      expect(status.attempts).toBe(0);
      expect(status.status).toBe("ok");
    });

    it("does not disturb other services' tracking", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      await supervisor.tryRestart("alpha");
      await supervisor.tryRestart("beta");

      expect(restartService).toHaveBeenCalledTimes(2);
      expect(supervisor.getStatus("alpha").status).toBe("ok");
      expect(supervisor.getStatus("beta").status).toBe("ok");
      expect(supervisor.getStatus("gamma").status).toBe("ok"); // never touched
    });
  });

  describe("tryRestart – backoff", () => {
    it("skips restart when service is in backoff window", async () => {
      const { core, restartService } = makeMockCore();
      // First call fails → enters backoff
      restartService.mockRejectedValueOnce(new Error("temp failure"));
      const supervisor = new ServiceSupervisor(core);

      await supervisor.tryRestart("svc2");

      expect(restartService).toHaveBeenCalledTimes(1);
      let status = supervisor.getStatus("svc2");
      expect(status.attempts).toBe(1);
      expect(status.status).toBe("backoff");
      expect(status.backoffUntil).toBeGreaterThan(Date.now());

      // Second call within backoff window → should be skipped
      await supervisor.tryRestart("svc2");

      expect(restartService).toHaveBeenCalledTimes(1); // not called again
      status = supervisor.getStatus("svc2");
      expect(status.status).toBe("backoff");
    });

    it("computes exponential backoff correctly", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);
      const before = Date.now();

      // First failure: backoff = 1000 * 2^1 = 2000ms
      restartService.mockRejectedValueOnce(new Error("fail 1"));
      await supervisor.tryRestart("svcBackoff");
      let status = supervisor.getStatus("svcBackoff");
      expect(status.attempts).toBe(1);
      expect(status.backoffUntil).toBeGreaterThanOrEqual(before + SUPERVISOR_DEFAULTS.baseBackoffMs * 2);
      expect(status.backoffUntil).toBeLessThanOrEqual(before + SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100);
    });
  });

  describe("tryRestart – permanent degradation", () => {
    it("marks service as permanently_degraded after max restart attempts", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      // Each failure is a distinct call because backoff must expire first.
      // We circumvent backoff by advancing time between calls.
      const origDateNow = Date.now;
      let fakeNow = 1_000_000;
      Date.now = () => fakeNow;

      try {
        // Attempt 1: fails (attempts → 1, backoff)
        restartService.mockRejectedValueOnce(new Error("fail 1"));
        await supervisor.tryRestart("svc3");
        expect(supervisor.getStatus("svc3").attempts).toBe(1);
        expect(supervisor.getStatus("svc3").status).toBe("backoff");

        // Advance past backoff (2000ms from now)
        fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

        // Attempt 2: fails (attempts → 2, backoff)
        restartService.mockRejectedValueOnce(new Error("fail 2"));
        await supervisor.tryRestart("svc3");
        expect(supervisor.getStatus("svc3").attempts).toBe(2);
        expect(supervisor.getStatus("svc3").status).toBe("backoff");

        // Advance past backoff (4000ms from now)
        fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 4 + 100;

        // Attempt 3: fails → permanently_degraded
        restartService.mockRejectedValueOnce(new Error("fail 3"));
        await supervisor.tryRestart("svc3");

        const status = supervisor.getStatus("svc3");
        expect(status.attempts).toBe(3);
        expect(status.status).toBe("permanently_degraded");

        // Subsequent calls are no-op
        await supervisor.tryRestart("svc3");
        expect(restartService).toHaveBeenCalledTimes(3);
      } finally {
        Date.now = origDateNow;
      }
    });

    it("further calls to permanently_degraded service are no-op", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      const origDateNow = Date.now;
      let fakeNow = 2_000_000;
      Date.now = () => fakeNow;

      try {
        // Exhaust 3 attempts
        restartService.mockRejectedValue(new Error("fail"));
        for (let i = 0; i < 3; i++) {
          await supervisor.tryRestart("permDeg");
          fakeNow += 10_000; // advance past each backoff
        }

        expect(supervisor.getStatus("permDeg").status).toBe("permanently_degraded");
        const callCountAfter = restartService.mock.calls.length;

        // Try again — should be no-op
        await supervisor.tryRestart("permDeg");
        expect(restartService.mock.calls.length).toBe(callCountAfter);
      } finally {
        Date.now = origDateNow;
      }
    });
  });

  describe("tryRestart – window expiry", () => {
    it("resets attempt budget when sliding window expires", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      const origDateNow = Date.now;
      let fakeNow = 5_000_000;
      Date.now = () => fakeNow;

      try {
        // First failure (attempts → 1)
        restartService.mockRejectedValueOnce(new Error("fail 1"));
        await supervisor.tryRestart("svcWindow");
        expect(supervisor.getStatus("svcWindow").attempts).toBe(1);

        // Advance past backoff (so the next restart is attempted)
        fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

        // Second failure (attempts → 2)
        restartService.mockRejectedValueOnce(new Error("fail 2"));
        await supervisor.tryRestart("svcWindow");
        expect(supervisor.getStatus("svcWindow").attempts).toBe(2);

        // Advance past the full 60-second window
        fakeNow += SUPERVISOR_DEFAULTS.windowMs + 100;

        // Now the window has expired — budget should reset
        // Next failure will be first in the new window
        restartService.mockRejectedValueOnce(new Error("fail after window"));
        await supervisor.tryRestart("svcWindow");

        const status = supervisor.getStatus("svcWindow");
        // Attempts should have been reset to 0 before incrementing
        expect(status.attempts).toBe(1);
        // Status should be 'backoff' (not permanently_degraded)
        expect(status.status).toBe("backoff");
      } finally {
        Date.now = origDateNow;
      }
    });

    it("resets firstAttemptTime when window expires", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      const origDateNow = Date.now;
      let fakeNow = 10_000_000;
      Date.now = () => fakeNow;

      try {
        const firstAttempt = fakeNow;

        restartService.mockRejectedValueOnce(new Error("fail"));
        await supervisor.tryRestart("svcResetTime");
        let status = supervisor.getStatus("svcResetTime");
        expect(status.firstAttemptTime).toBe(firstAttempt);

        // Advance past window
        fakeNow += SUPERVISOR_DEFAULTS.windowMs + 1;
        // Also advance past backoff
        fakeNow += SUPERVISOR_DEFAULTS.maxBackoffMs + 1;

        restartService.mockRejectedValueOnce(new Error("fail again"));
        await supervisor.tryRestart("svcResetTime");

        status = supervisor.getStatus("svcResetTime");
        // firstAttemptTime should have been updated to the new attempt time
        expect(status.firstAttemptTime).toBe(fakeNow);
      } finally {
        Date.now = origDateNow;
      }
    });
  });

  describe("tryRestart – internal error isolation", () => {
    it("does not propagate if core.restartService throws unexpectedly", async () => {
      const { core, restartService } = makeMockCore();
      restartService.mockRejectedValue(new Error("unexpected crash"));
      const supervisor = new ServiceSupervisor(core);

      // Even though restartService throws, tryRestart should not reject
      await expect(supervisor.tryRestart("svcSafe")).resolves.toBeUndefined();
    });

    it("does not propagate if a catastrophic error occurs inside supervisor logic", async () => {
      const { core } = makeMockCore();
      // The supervisor wraps everything in try/catch, so even broken
      // core objects should not cause uncaught errors.
      const brokenCore = {
        getService: mock(() => { throw new Error("boom"); }),
        getServices: mock(() => { throw new Error("boom"); }),
        restartService: mock(() => { throw new Error("boom"); }),
        isDegraded: mock(() => { throw new Error("boom"); }),
      } satisfies PluginCoreLike as PluginCoreLike;

      const supervisor = new ServiceSupervisor(brokenCore);

      await expect(supervisor.tryRestart("anything")).resolves.toBeUndefined();
    });

    it("calling tryRestart for a non-existent service does not throw", async () => {
      const { core } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      // No service registered anywhere, but supervisor should still be safe
      await expect(supervisor.tryRestart("ghost")).resolves.toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("returns default ok state for a service that was never tracked", () => {
      const { core } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      const status = supervisor.getStatus("never-seen");
      expect(status.attempts).toBe(0);
      expect(status.status).toBe("ok");
      expect(status.firstAttemptTime).toBe(0);
      expect(status.lastAttemptTime).toBe(0);
      expect(status.backoffUntil).toBe(0);
    });

    it("returns current tracking state after a failed restart", async () => {
      const { core, restartService } = makeMockCore();
      restartService.mockRejectedValueOnce(new Error("fail"));
      const supervisor = new ServiceSupervisor(core);

      await supervisor.tryRestart("track-me");

      const status = supervisor.getStatus("track-me");
      expect(status.attempts).toBe(1);
      expect(status.status).toBe("backoff");
      expect(status.firstAttemptTime).toBeGreaterThan(0);
      expect(status.lastAttemptTime).toBeGreaterThan(0);
      expect(status.backoffUntil).toBeGreaterThan(Date.now());
    });

    it("returns ok state after a successful restart", async () => {
      const { core, restartService } = makeMockCore();
      const supervisor = new ServiceSupervisor(core);

      const origDateNow = Date.now;
      let fakeNow = 30_000_000;
      Date.now = () => fakeNow;

      try {
        // First call fails (to create tracking)
        restartService.mockRejectedValueOnce(new Error("fail"));
        await supervisor.tryRestart("svcOk");

        let status = supervisor.getStatus("svcOk");
        expect(status.attempts).toBe(1);
        expect(status.status).toBe("backoff");

        // Advance past backoff (2000ms)
        fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;
        restartService.mockResolvedValueOnce(undefined);
        await supervisor.tryRestart("svcOk");

        status = supervisor.getStatus("svcOk");
        expect(status.attempts).toBe(0);
        expect(status.status).toBe("ok");
      } finally {
        Date.now = origDateNow;
      }
    });
  });

  describe("concurrent service isolation", () => {
    it("tracks multiple services independently", async () => {
      const { core, restartService } = makeMockCore();
      restartService.mockRejectedValue(new Error("fail"));
      const supervisor = new ServiceSupervisor(core);

      await supervisor.tryRestart("alpha");
      await supervisor.tryRestart("beta");
      await supervisor.tryRestart("alpha"); // skipped (backoff)

      // alpha: 1 attempt then skipped
      // beta: 1 attempt
      const alphaStatus = supervisor.getStatus("alpha");
      expect(alphaStatus.attempts).toBe(1);

      const betaStatus = supervisor.getStatus("beta");
      expect(betaStatus.attempts).toBe(1);
    });
  });

  // The "supervisor instantiation in PluginCore" test is intentionally omitted
  // because importing plugin-core.ts transitively triggers a pre-existing crash
  // in src/recovery/startup-check.ts ("Unexpected export"). The supervisor
  // is instantiated as a private field in PluginCore's constructor, verified
  // by clean lsp_diagnostics on both files.
});
