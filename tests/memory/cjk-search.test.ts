/**
 * CJK memory search tests — the bigram FTS index in `src/memory/schema.ts` and
 * `src/memory/search.ts`, exercised through a real {@link MemoryStore} in a
 * temporary workspace.
 *
 * Verifies:
 *   - a Chinese entry is found by a 2-character and a longer Chinese term
 *   - Latin search behavior is unchanged
 *   - an update re-indexes content, title and tags (old terms stop matching)
 *   - delete removes the entry from search
 *   - a database written by the pre-bigram schema is migrated in place on open:
 *     the Chinese row is found by a 2-character query, its content is
 *     untouched, and a second open is idempotent
 *   - `search_text` never leaks onto a MemoryEntry
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.ts";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { memoryDbPath } from "../../src/utils/state-paths.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";

type WriteInput = Omit<MemoryEntry, "id" | "created_at" | "updated_at" | "accessed_at" | "access_count">;

/** Minimal entry: workspace-scoped so every role (and `''`) sees it. */
function entry(overrides: Partial<WriteInput> = {}): WriteInput {
  return {
    scope: "workspace",
    role_id: "shared",
    category: "fact",
    title: "Deployment checklist",
    content: "Run the migration before restarting.",
    tags: ["ops"],
    relevance: "medium",
    session_id: "session-1",
    source_sessions: ["session-1"],
    ...overrides,
  };
}

/** The pre-bigram schema, copied verbatim from the version it shipped in. */
const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL,
    role_id         TEXT,
    category        TEXT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            TEXT,
    relevance       TEXT DEFAULT 'medium',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    accessed_at     TEXT,
    access_count    INTEGER DEFAULT 0,
    session_id      TEXT,
    source_sessions TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, tags,
    content='memories',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO memories_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
  END;
`;

const LEGACY_ID = "legacy-chinese-row";
const LEGACY_TITLE = "旧版本记忆";
const LEGACY_CONTENT = "这条记忆机制需要保存关键点，上下文压缩后也要能找到。";

/** Create a `.rolebox/memory.db` in the legacy schema with one Chinese row. */
function writeLegacyDatabase(dir: string): void {
  mkdirSync(join(dir, ".rolebox"), { recursive: true });
  const db = createDatabaseSync(memoryDbPath(dir));
  try {
    db.exec(LEGACY_SCHEMA);
    db.run(
      `INSERT INTO memories (id, scope, role_id, category, title, content, tags, relevance, created_at, updated_at, accessed_at, access_count, session_id, source_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      LEGACY_ID,
      "workspace",
      "shared",
      "fact",
      LEGACY_TITLE,
      LEGACY_CONTENT,
      JSON.stringify(["迁移"]),
      "high",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      null,
      0,
      "session-1",
      JSON.stringify(["session-1"]),
    );
  } finally {
    db.close();
  }
}

describe("CJK memory search", () => {
  let root: string;
  let store: MemoryStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rolebox-memory-cjk-"));
    store = await MemoryStore.create(root);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore close errors on already-closed fixtures
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a Chinese entry by a 2-character and a longer Chinese term", () => {
    const id = store.write(entry({
      title: "记忆机制",
      content: "记忆机制需要保存关键点，上下文压缩后也要能找到。",
      tags: ["压缩"],
    }));

    expect(store.search({ query: "记忆" }).map((result) => result.id)).toEqual([id]);
    expect(store.search({ query: "记忆机制" }).map((result) => result.id)).toEqual([id]);
    expect(store.search({ query: "压缩" }).map((result) => result.id)).toEqual([id]);
    expect(store.search({ query: "上下文压缩" }).map((result) => result.id)).toEqual([id]);
  });

  it("keeps Latin search behavior unchanged", () => {
    const latin = store.write(entry({ title: "Memory store design", content: "The store keeps durable decisions.", tags: ["design"] }));
    const chinese = store.write(entry({ title: "记忆机制", content: "保存关键点", tags: [] }));

    expect(store.search({ query: "memory" }).map((result) => result.id)).toEqual([latin]);
    expect(store.search({ query: "durable decisions" }).map((result) => result.id)).toEqual([latin]);
    expect(store.search({ query: "design" }).map((result) => result.id)).toEqual([latin]);
    expect(store.search({ query: "记忆" }).map((result) => result.id)).toEqual([chinese]);
  });

  it("re-indexes content, title and tags on update", () => {
    const id = store.write(entry({ title: "部署流程", content: "旧的记忆内容", tags: ["记忆"] }));

    expect(store.search({ query: "记忆" }).map((result) => result.id)).toEqual([id]);

    store.update(id, { title: "压缩策略", content: "上下文压缩后仍需保存关键点", tags: ["压缩"] });

    expect(store.search({ query: "压缩" }).map((result) => result.id)).toEqual([id]);
    expect(store.search({ query: "记忆" })).toEqual([]);
    expect(store.search({ query: "部署" })).toEqual([]);
  });

  it("removes a deleted entry from search", () => {
    const id = store.write(entry({ title: "记忆机制", content: "记忆机制需要保存关键点", tags: [] }));
    expect(store.search({ query: "记忆" })).toHaveLength(1);

    store.delete(id);

    expect(store.search({ query: "记忆" })).toEqual([]);
    expect(store.read(id)).toBeNull();
  });

  it("does not expose search_text on MemoryEntry", () => {
    const id = store.write(entry({ title: "记忆机制", content: "记忆机制需要保存关键点", tags: [] }));

    const read = store.read(id);
    expect(read).not.toBeNull();
    expect("search_text" in (read ?? {})).toBe(false);

    const [found] = store.search({ query: "记忆" });
    expect(found).toBeDefined();
    expect("search_text" in (found ?? {})).toBe(false);
    expect(JSON.stringify(found)).not.toContain("search_text");
  });

  it("migrates a pre-bigram database in place and finds the Chinese row", () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "rolebox-memory-cjk-legacy-"));
    writeLegacyDatabase(root);

    store = MemoryStore.open(root);

    const found = store.search({ query: "记忆" });
    expect(found.map((result) => result.id)).toEqual([LEGACY_ID]);
    expect(found[0].title).toBe(LEGACY_TITLE);
    expect(found[0].content).toBe(LEGACY_CONTENT);
    expect(found[0].tags).toEqual(["迁移"]);
    expect(store.search({ query: "压缩" }).map((result) => result.id)).toEqual([LEGACY_ID]);
    expect(store.list()).toHaveLength(1);

    // A second open is idempotent: the row is still there, still findable, and
    // its stored fields are untouched.
    store.close();
    store = MemoryStore.open(root);
    expect(store.list()).toHaveLength(1);
    const reopened = store.read(LEGACY_ID);
    expect(reopened?.title).toBe(LEGACY_TITLE);
    expect(reopened?.content).toBe(LEGACY_CONTENT);
    expect(reopened?.tags).toEqual(["迁移"]);
    expect(store.search({ query: "记忆" }).map((result) => result.id)).toEqual([LEGACY_ID]);
  });

  it("writes new entries after migrating a legacy database", () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "rolebox-memory-cjk-legacy-write-"));
    writeLegacyDatabase(root);

    store = MemoryStore.open(root);
    const id = store.write(entry({ title: "新的压缩策略", content: "上下文压缩后的新条目", tags: [] }));

    expect(store.search({ query: "策略" }).map((result) => result.id)).toEqual([id]);
    expect(store.search({ query: "记忆" }).map((result) => result.id)).toEqual([LEGACY_ID]);
    expect(store.list()).toHaveLength(2);
  });
});
