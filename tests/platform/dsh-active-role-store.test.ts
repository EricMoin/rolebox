/// <reference types="bun-types" />

/**
 * ActiveRoleStore tests — the per-workspace, session-keyed, versioned JSON
 * sidecar for dsh active-role selections (modeled on the FunctionRuntimeStore /
 * LoopStore house pattern).
 *
 * Verifies:
 *   - save → load round-trips entries (including an explicit `roleId: null`)
 *   - saveSync → load round-trips
 *   - the persisted file is versioned and matches the documented shape
 *   - load() fails soft on a missing / empty / corrupt / future-version file
 *   - a version-0 file migrates forward (missing roleId → null, missing
 *     updatedAt → 0) instead of being rejected
 *   - prune() applies the TTL and the session cap (newest kept)
 *   - the store is workspace-scoped (distinct directories → distinct files)
 *   - async saves are serialized and leave no orphan `.tmp` files
 *   - the module stays free of `@deepseek-ai/*` / `@opencode-ai/*` imports
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ActiveRoleStore,
  ACTIVE_ROLE_STORE_VERSION,
  DEFAULT_ACTIVE_ROLE_MAX_SESSIONS,
  DEFAULT_ACTIVE_ROLE_TTL_MS,
} from "../../src/platform/adapters/dsh/active-role-store.ts";
import type { ActiveRoleEntry } from "../../src/platform/adapters/dsh/active-role-store.ts";
import { shortHash } from "../../src/utils/state-paths.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<ActiveRoleEntry> = {}): ActiveRoleEntry {
  return {
    sessionId: "ses_1",
    roleId: "role-a",
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Path the store uses for `dir` — recomputed independently of the store. */
function stateFileFor(dir: string): string {
  return join(dir, ".rolebox", "state", `activerole-${shortHash(dir)}.json`);
}

describe("ActiveRoleStore persistence", () => {
  let tempDir: string;
  let store: ActiveRoleStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "active-role-store-"));
    store = new ActiveRoleStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("save → load round-trips a session-keyed map", async () => {
    const now = Date.now();
    const a = makeEntry({ sessionId: "ses_a", roleId: "role-a", updatedAt: now - 20 });
    const b = makeEntry({ sessionId: "ses_b", roleId: null, updatedAt: now - 10 });

    await store.save(
      new Map<string, ActiveRoleEntry>([
        [a.sessionId, a],
        [b.sessionId, b],
      ]),
    );

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("ses_a")).toEqual(a);
    expect(loaded!.get("ses_b")).toEqual(b);
  });

  it("saveSync → load round-trips", () => {
    const entry = makeEntry({ sessionId: "ses_sync", roleId: "role-sync", updatedAt: Date.now() });
    store.saveSync(new Map([[entry.sessionId, entry]]));

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.get("ses_sync")).toEqual(entry);
  });

  it("writes a versioned envelope matching the documented shape", async () => {
    await store.save(new Map([["ses_x", makeEntry({ sessionId: "ses_x", updatedAt: 1_000 })]]));

    const parsed = JSON.parse(readFileSync(stateFileFor(tempDir), "utf-8"));
    expect(parsed.version).toBe(ACTIVE_ROLE_STORE_VERSION);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions).toEqual([
      { sessionId: "ses_x", roleId: "role-a", updatedAt: 1_000 },
    ]);
  });

  it("missing file → load() returns null (fail soft)", () => {
    expect(store.load()).toBeNull();
  });

  it("empty file → load() returns null (fail soft)", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(stateFileFor(tempDir), "");
    expect(store.load()).toBeNull();
  });

  it("corrupt JSON → load() returns null without throwing", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(stateFileFor(tempDir), "not valid json {{{");
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("unknown future version → load() returns null", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(
      stateFileFor(tempDir),
      JSON.stringify({ version: 99, sessions: [makeEntry()] }),
    );
    expect(store.load()).toBeNull();
  });

  it("version-0 file migrates forward instead of being rejected", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(
      stateFileFor(tempDir),
      JSON.stringify({
        version: 0,
        sessions: [
          { sessionId: "legacy_1", roleId: "role-legacy" },
          { sessionId: "legacy_2" },
        ],
      }),
    );

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("legacy_1")).toEqual({
      sessionId: "legacy_1",
      roleId: "role-legacy",
      updatedAt: 0,
    });
    expect(loaded!.get("legacy_2")).toEqual({
      sessionId: "legacy_2",
      roleId: null,
      updatedAt: 0,
    });
  });

  it("skips malformed session rows but keeps valid ones", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(
      stateFileFor(tempDir),
      JSON.stringify({
        version: ACTIVE_ROLE_STORE_VERSION,
        sessions: [
          { sessionId: "good", roleId: "role-good", updatedAt: Date.now() },
          { roleId: "no-session-id", updatedAt: Date.now() },
          "garbage",
        ],
      }),
    );

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(1);
    expect(loaded!.get("good")!.roleId).toBe("role-good");
  });

  it("async saves are serialized and leave no orphan .tmp files", async () => {
    const first = new Map([["s1", makeEntry({ sessionId: "s1", roleId: "role-1" })]]);
    const second = new Map([["s1", makeEntry({ sessionId: "s1", roleId: "role-2" })]]);

    await Promise.all([store.save(first), store.save(second)]);

    expect(store.load()!.get("s1")!.roleId).toBe("role-2");
    const stateDir = join(tempDir, ".rolebox", "state");
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("ActiveRoleStore workspace scoping", () => {
  it("derives a distinct state file per workspace directory", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "active-role-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "active-role-b-"));
    try {
      expect(stateFileFor(dirA)).not.toBe(stateFileFor(dirB));

      const storeA = new ActiveRoleStore(dirA);
      const storeB = new ActiveRoleStore(dirB);
      await storeA.save(new Map([["s", makeEntry({ sessionId: "s", roleId: "role-a" })]]));
      await storeB.save(new Map([["s", makeEntry({ sessionId: "s", roleId: "role-b" })]]));

      expect(storeA.load()!.get("s")!.roleId).toBe("role-a");
      expect(storeB.load()!.get("s")!.roleId).toBe("role-b");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("ActiveRoleStore.prune", () => {
  const now = Date.now();

  it("drops entries older than the TTL and keeps fresh ones", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-ttl", { ttlMs: 7 * DAY_MS });
    const sessions = new Map<string, ActiveRoleEntry>([
      ["old", makeEntry({ sessionId: "old", updatedAt: now - 8 * DAY_MS })],
      ["fresh", makeEntry({ sessionId: "fresh", updatedAt: now - DAY_MS })],
    ]);

    const result = store.prune(sessions);

    expect(result).toBe(sessions);
    expect([...result.keys()]).toEqual(["fresh"]);
  });

  it("keeps entries comfortably inside the TTL", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-edge", { ttlMs: DAY_MS });
    const sessions = new Map<string, ActiveRoleEntry>([
      ["recent", makeEntry({ sessionId: "recent", updatedAt: now - 1_000 })],
    ]);

    store.prune(sessions);

    expect(sessions.size).toBe(1);
  });

  it("caps the map at maxSessions, keeping the newest", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-cap", {
      ttlMs: DEFAULT_ACTIVE_ROLE_TTL_MS,
      maxSessions: 2,
    });
    const sessions = new Map<string, ActiveRoleEntry>([
      ["oldest", makeEntry({ sessionId: "oldest", updatedAt: now - 3_000 })],
      ["middle", makeEntry({ sessionId: "middle", updatedAt: now - 2_000 })],
      ["newest", makeEntry({ sessionId: "newest", updatedAt: now - 1_000 })],
    ]);

    store.prune(sessions);

    expect([...sessions.keys()].sort()).toEqual(["middle", "newest"]);
  });

  it("applies TTL before the cap", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-both", {
      ttlMs: DAY_MS,
      maxSessions: 1,
    });
    const sessions = new Map<string, ActiveRoleEntry>([
      ["expired", makeEntry({ sessionId: "expired", updatedAt: now - 2 * DAY_MS })],
      ["fresh-1", makeEntry({ sessionId: "fresh-1", updatedAt: now - 2_000 })],
      ["fresh-2", makeEntry({ sessionId: "fresh-2", updatedAt: now - 1_000 })],
    ]);

    store.prune(sessions);

    expect([...sessions.keys()]).toEqual(["fresh-2"]);
  });

  it("honours per-call option overrides", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-override", {
      ttlMs: 100,
      maxSessions: 100,
    });
    const sessions = new Map<string, ActiveRoleEntry>([
      ["keep", makeEntry({ sessionId: "keep", updatedAt: now - 10_000 })],
    ]);

    store.prune(sessions, { ttlMs: DAY_MS, maxSessions: 5 });

    expect(sessions.size).toBe(1);
  });

  it("uses the exported defaults", () => {
    const store = new ActiveRoleStore("/tmp/irrelevant-prune-defaults");
    const sessions = new Map<string, ActiveRoleEntry>();
    for (let i = 0; i < DEFAULT_ACTIVE_ROLE_MAX_SESSIONS + 5; i++) {
      sessions.set(`s${i}`, makeEntry({ sessionId: `s${i}`, updatedAt: now - i }));
    }

    store.prune(sessions);

    expect(sessions.size).toBe(DEFAULT_ACTIVE_ROLE_MAX_SESSIONS);
    // Newest 200 (s0..s199) survive; the 5 oldest are dropped.
    expect(sessions.has("s0")).toBe(true);
    expect(sessions.has("s199")).toBe(true);
    expect(sessions.has(`s${DEFAULT_ACTIVE_ROLE_MAX_SESSIONS + 4}`)).toBe(false);
  });
});

describe("ActiveRoleStore lifecycle / GC (prune on load)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "active-role-gc-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("load() prunes expired entries and keeps fresh ones", () => {
    const store = new ActiveRoleStore(tempDir, { ttlMs: 7 * DAY_MS });
    const now = Date.now();
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["old", makeEntry({ sessionId: "old", updatedAt: now - 8 * DAY_MS })],
        ["fresh", makeEntry({ sessionId: "fresh", updatedAt: now - DAY_MS })],
      ]),
    );

    const loaded = store.load();

    expect(loaded).not.toBeNull();
    expect([...loaded!.keys()]).toEqual(["fresh"]);
  });

  it("load() applies the session cap, keeping the newest", () => {
    const store = new ActiveRoleStore(tempDir, { maxSessions: 2 });
    const now = Date.now();
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["oldest", makeEntry({ sessionId: "oldest", updatedAt: now - 3_000 })],
        ["middle", makeEntry({ sessionId: "middle", updatedAt: now - 2_000 })],
        ["newest", makeEntry({ sessionId: "newest", updatedAt: now - 1_000 })],
      ]),
    );

    const loaded = store.load();

    expect([...loaded!.keys()].sort()).toEqual(["middle", "newest"]);
  });

  it("load({ liveSessionIds }) retains a stale entry whose session is still live", () => {
    const store = new ActiveRoleStore(tempDir, { ttlMs: DAY_MS });
    const now = Date.now();
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["live-old", makeEntry({ sessionId: "live-old", updatedAt: now - 10 * DAY_MS })],
        ["gone-old", makeEntry({ sessionId: "gone-old", updatedAt: now - 10 * DAY_MS })],
      ]),
    );

    const loaded = store.load({ liveSessionIds: new Set(["live-old"]) });

    expect([...loaded!.keys()]).toEqual(["live-old"]);
  });

  it("load() consults a constructor census provider (ctx.sessions.list() seam)", () => {
    const now = Date.now();
    const store = new ActiveRoleStore(tempDir, {
      ttlMs: DAY_MS,
      liveSessionIds: () => ["still-here"],
    });
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["still-here", makeEntry({ sessionId: "still-here", updatedAt: now - 10 * DAY_MS })],
        ["vanished", makeEntry({ sessionId: "vanished", updatedAt: now - 10 * DAY_MS })],
      ]),
    );

    const loaded = store.load();

    expect([...loaded!.keys()]).toEqual(["still-here"]);
  });

  it("never deletes on disposal: an absent-but-fresh entry is retained", () => {
    const store = new ActiveRoleStore(tempDir, { ttlMs: DAY_MS });
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["just-disposed", makeEntry({ sessionId: "just-disposed", updatedAt: Date.now() })],
      ]),
    );

    // The session is absent from the census (evicted from memory) but its entry
    // is fresh, so it must survive — disposal is eviction, not deletion.
    const loaded = store.load({ liveSessionIds: new Set<string>() });

    expect(loaded!.has("just-disposed")).toBe(true);
  });

  it("falls back to TTL-only pruning when the census provider throws", () => {
    const now = Date.now();
    const store = new ActiveRoleStore(tempDir, {
      ttlMs: DAY_MS,
      liveSessionIds: () => {
        throw new Error("census unavailable");
      },
    });
    store.saveSync(
      new Map<string, ActiveRoleEntry>([
        ["old", makeEntry({ sessionId: "old", updatedAt: now - 10 * DAY_MS })],
      ]),
    );

    const loaded = store.load();

    expect(loaded!.size).toBe(0);
  });

  it("keeps migrated rows with unknown age (updatedAt 0) across load", () => {
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(
      stateFileFor(tempDir),
      JSON.stringify({
        version: 0,
        sessions: [{ sessionId: "legacy", roleId: "role-legacy" }],
      }),
    );

    const loaded = new ActiveRoleStore(tempDir, { ttlMs: 1 }).load();

    expect(loaded!.get("legacy")).toEqual({
      sessionId: "legacy",
      roleId: "role-legacy",
      updatedAt: 0,
    });
  });
});

describe("ActiveRoleStore module stays free of platform SDK imports", () => {
  it("contains no @deepseek-ai/* or @opencode-ai/* imports", () => {
    const file = resolve(import.meta.dir, "../../src/platform/adapters/dsh/active-role-store.ts");
    const source = readFileSync(file, "utf-8");
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    const forbidden = specifiers.filter(
      (s) => s.includes("@deepseek-ai/") || s.includes("@opencode-ai/"),
    );
    expect(forbidden).toEqual([]);
  });
});
