/**
 * Pi NotificationManager wiring tests (subtask S3).
 *
 * Verifies the Pi-side notification wiring exported from
 * `src/pi-extension.ts`:
 *   1. `wirePiNotifications()` parses role `notifications:` configs and
 *      global config from ROLEBOX_NOTIFICATIONS_CONFIG /
 *      ROLEBOX_NOTIFICATIONS_ENABLED (mirroring notification-service.ts).
 *   2. Emitting `session.idle` / `session.error` through the PiEventBridge
 *      invokes the configured channel (mock channel injected via the
 *      channel-factory registry with a `log`-kind config entry).
 *   3. `unsubscribe()` / `manager.dispose()` tear down cleanly — events
 *      emitted afterwards never reach the manager.
 *   4. The wired manager is exposed via `getPiNotificationManager()` for
 *      the later hook-pipeline subtask.
 *
 * The mock channel is injected by registering a channel factory for the
 * built-in `log` kind (the factory registry is consulted before the
 * built-in switch in createChannel). The role config declares a plain
 * `{ kind: "log", enabled: true }` channel, which survives config parsing,
 * and the registered factory substitutes the mock implementation.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  wirePiNotifications,
  getPiNotificationManager,
  extractSessionId,
  extractEventAgent,
} from "../src/pi-extension.ts";
import type { PiNotificationWireResult } from "../src/pi-extension.ts";
import { PiEventBridge } from "../src/platform/adapters/pi/event-bridge.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { ResolvedRole } from "../src/types.ts";
import { registerChannelFactory } from "../src/notifications/channels.ts";
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_EVENT_TYPES,
} from "../src/notifications/types.ts";
import type { NotificationMessage } from "../src/notifications/types.ts";
import type { NotificationConfig } from "../src/notifications/types.ts";
import type { SessionInfo } from "../src/session/types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const ROLE_ID = "test-role";
const ENV_CONFIG = "ROLEBOX_NOTIFICATIONS_CONFIG";
const ENV_ENABLED = "ROLEBOX_NOTIFICATIONS_ENABLED";

// ── Mock channel (injected via the channel-factory registry) ──────────────

const mockSends: NotificationMessage[] = [];

registerChannelFactory(NOTIFICATION_CHANNEL_KINDS.Log, async () => ({
  kind: NOTIFICATION_CHANNEL_KINDS.Log,
  send: async (message: NotificationMessage) => {
    mockSends.push(message);
  },
  dispose: async () => {},
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const mockSession: SessionInfo = {
  id: "sess",
  projectID: "test",
  directory: "/tmp",
  title: "Test Session",
  version: "1",
  time: { created: 0, updated: 0 },
};

function createMockClient(): ISessionClient {
  return {
    list: async () => [],
    get: async () => mockSession,
    messages: async () => [],
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    fork: async () => null,
    status: async () => ({ type: "idle" }),
    prompt: async () => ({ id: "sess" }),
    promptSync: async () => ({ parts: [] }),
    create: async () => null,
    abort: async () => true,
  };
}

function makeRole(notifications: unknown): ResolvedRole {
  return {
    id: ROLE_ID,
    config: {
      name: "Test Role",
      description: "Test role for notification wiring",
      prompt: "You are a test role.",
      notifications: notifications as NotificationConfig,
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** Role with a `log`-kind channel (resolved to the mock via factory). */
function roleWithChannels(): ResolvedRole {
  return makeRole({ channels: [{ kind: "log", enabled: true }] });
}

function wire(bridge: PiEventBridge, roles: ResolvedRole[] = [roleWithChannels()]): PiNotificationWireResult {
  return wirePiNotifications({
    eventBridge: bridge,
    resolvedRoles: roles,
    client: createMockClient(),
    dir: process.cwd(),
  });
}

/** Write a YAML global notification config into the temp dir. */
function writeConfig(yaml: string): string {
  const p = join(tmpDir, "notifications.yaml");
  writeFileSync(p, yaml);
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 800): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-notif-"));
});

afterEach(() => {
  delete process.env[ENV_CONFIG];
  delete process.env[ENV_ENABLED];
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Pi notification wiring", () => {
  it("session.idle through the bridge invokes the role-configured channel (debounced)", async () => {
    mockSends.length = 0;
    // Fast global idle delay via ROLEBOX_NOTIFICATIONS_CONFIG (also proves
    // the env file path is honored: without it the default 1500ms delay
    // would never fire within waitFor's timeout).
    process.env[ENV_CONFIG] = writeConfig("idleDelayMs: 20\n");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: "sess-idle", agent: ROLE_ID },
      });

      // Idle notifications are debounced — nothing fires synchronously.
      expect(mockSends).toHaveLength(0);

      expect(await waitFor(() => mockSends.length === 1)).toBe(true);
      expect(mockSends[0].eventType).toBe(NOTIFICATION_EVENT_TYPES.Idle);
      expect(mockSends[0].sessionId).toBe("sess-idle");
      expect(mockSends[0].agent).toBe(ROLE_ID);
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("session.error through the bridge invokes the channel immediately", async () => {
    mockSends.length = 0;

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.error",
        rawType: "process.error",
        properties: { sessionID: "sess-err", agent: ROLE_ID, error: "boom" },
      });

      expect(await waitFor(() => mockSends.length === 1)).toBe(true);
      expect(mockSends[0].eventType).toBe(NOTIFICATION_EVENT_TYPES.Error);
      expect(mockSends[0].sessionId).toBe("sess-err");
      expect(mockSends[0].agent).toBe(ROLE_ID);
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("emits without a matching role agent fall back to global channels (none) — no send", async () => {
    mockSends.length = 0;

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.error",
        rawType: "process.error",
        properties: { sessionID: "sess-norole" },
      });
      await sleep(60);
      expect(mockSends).toHaveLength(0);
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("ROLEBOX_NOTIFICATIONS_ENABLED=false/0 disables notifications (global layer)", async () => {
    // Global channels come from the config file; the disable flag is honored
    // on the global config path (events without a role-agent merge).
    const globalChannelsYaml = "channels:\n  - kind: log\n    enabled: true\n";

    for (const flag of ["false", "0"]) {
      mockSends.length = 0;
      process.env[ENV_CONFIG] = writeConfig(globalChannelsYaml);
      process.env[ENV_ENABLED] = flag;

      const bridge = new PiEventBridge();
      const wiring = wire(bridge);

      try {
        await bridge.emit({
          type: "session.error",
          rawType: "process.error",
          properties: { sessionID: "sess-off" },
        });
        await sleep(60);
        expect(mockSends).toHaveLength(0);
      } finally {
        wiring.unsubscribe();
        await wiring.manager.dispose();
      }
    }
  });

  it("global channels from ROLEBOX_NOTIFICATIONS_CONFIG are honored without a role agent", async () => {
    mockSends.length = 0;
    process.env[ENV_CONFIG] = writeConfig(
      "channels:\n  - kind: log\n    enabled: true\n",
    );

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.error",
        rawType: "process.error",
        properties: { sessionID: "sess-global" },
      });
      expect(await waitFor(() => mockSends.length === 1)).toBe(true);
      expect(mockSends[0].sessionId).toBe("sess-global");
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("missing ROLEBOX_NOTIFICATIONS_CONFIG file falls back to defaults without throwing", async () => {
    mockSends.length = 0;
    process.env[ENV_CONFIG] = join(tmpDir, "does-not-exist.yaml");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge); // must not throw

    try {
      await bridge.emit({
        type: "session.error",
        rawType: "process.error",
        properties: { sessionID: "sess-missing", agent: ROLE_ID },
      });
      expect(await waitFor(() => mockSends.length === 1)).toBe(true);
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("message.updated through the bridge cancels a pending idle notification", async () => {
    mockSends.length = 0;
    // Idle delay must exceed the 100ms scheduler activity-grace period so
    // the message.updated activity actually cancels the pending timer.
    process.env[ENV_CONFIG] = writeConfig("idleDelayMs: 250\n");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: "sess-act", agent: ROLE_ID },
      });
      // Past the grace period, before the 250ms fire time.
      await sleep(130);
      await bridge.emit({
        type: "message.updated",
        rawType: "message_update",
        properties: { sessionID: "sess-act", agent: ROLE_ID },
      });
      // Well past the original fire time — the timer was cancelled.
      await sleep(250);
      expect(mockSends).toHaveLength(0);
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("session.deleted through the bridge cleans up silently", async () => {
    mockSends.length = 0;
    process.env[ENV_CONFIG] = writeConfig("idleDelayMs: 20\n");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      await bridge.emit({
        type: "session.deleted",
        rawType: "session_shutdown",
        properties: { sessionID: "sess-del", agent: ROLE_ID },
      });
      await sleep(40);
      expect(mockSends).toHaveLength(0);

      // Deletion cleared scheduler state — a new idle for the same session
      // fires again instead of being swallowed as "already notified".
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: "sess-del", agent: ROLE_ID },
      });
      expect(await waitFor(() => mockSends.length === 1)).toBe(true);
      expect(mockSends[0].sessionId).toBe("sess-del");
    } finally {
      wiring.unsubscribe();
      await wiring.manager.dispose();
    }
  });

  it("unsubscribe() removes bridge subscriptions — later events never reach the manager", async () => {
    mockSends.length = 0;
    process.env[ENV_CONFIG] = writeConfig("idleDelayMs: 40\n");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);
    wiring.unsubscribe();

    await bridge.emit({
      type: "session.error",
      rawType: "process.error",
      properties: { sessionID: "sess-unsub", agent: ROLE_ID },
    });
    await bridge.emit({
      type: "session.idle",
      rawType: "agent_end",
      properties: { sessionID: "sess-unsub", agent: ROLE_ID },
    });
    await sleep(100);
    expect(mockSends).toHaveLength(0);

    // dispose() is idempotent.
    await wiring.manager.dispose();
    await wiring.manager.dispose();
  });

  it("dispose() before the idle delay fires cancels the pending notification", async () => {
    mockSends.length = 0;
    process.env[ENV_CONFIG] = writeConfig("idleDelayMs: 80\n");

    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    await bridge.emit({
      type: "session.idle",
      rawType: "agent_end",
      properties: { sessionID: "sess-pend", agent: ROLE_ID },
    });
    // Dispose clears the pending scheduler timer before it can fire.
    await wiring.manager.dispose();

    await sleep(150);
    expect(mockSends).toHaveLength(0);
    wiring.unsubscribe();
  });

  it("exposes the wired manager via getPiNotificationManager()", () => {
    const bridge = new PiEventBridge();
    const wiring = wire(bridge);

    try {
      expect(getPiNotificationManager()).toBe(wiring.manager);
    } finally {
      wiring.unsubscribe();
      void wiring.manager.dispose();
    }
  });

  it("extractSessionId / extractEventAgent read canonical properties", () => {
    expect(extractSessionId({ sessionID: "a" })).toBe("a");
    expect(extractSessionId({ sessionId: "b" })).toBe("b");
    expect(extractSessionId({ info: { id: "c" } })).toBe("c");
    expect(extractSessionId({ info: { sessionId: "d" } })).toBe("d");
    expect(extractSessionId({})).toBeUndefined();

    expect(extractEventAgent({ agent: "x" })).toBe("x");
    expect(extractEventAgent({ agentID: "y" })).toBe("y");
    expect(extractEventAgent({ info: { agent: "z" } })).toBe("z");
    expect(extractEventAgent({})).toBeUndefined();
  });
});
