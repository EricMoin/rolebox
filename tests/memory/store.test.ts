import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store";
import type { MemoryEntry } from "../../src/types";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "rolebox-memory-test-"));
}

type WriteInput = Omit<
  MemoryEntry,
  "id" | "created_at" | "updated_at" | "accessed_at" | "access_count"
>;

function makeEntry(
  overrides?: Partial<WriteInput>,
): WriteInput {
  return {
    scope: "role",
    role_id: "test-role",
    category: "note",
    title: "Test memory",
    content: "This is a test memory entry.",
    tags: ["test"],
    relevance: "medium",
    session_id: "test-session",
    source_sessions: [],
    ...overrides,
  };
}

async function createStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = makeTempDir();
  const store = await MemoryStore.create(dir);
  return { store, dir };
}

function cleanup(store: MemoryStore, dir: string): void {
  try {
    store.close();
  } catch {
    // ignore close errors
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("MemoryStore", () => {
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(async () => {
    const created = await createStore();
    store = created.store;
    tempDir = created.dir;
  });

  afterEach(() => {
    cleanup(store, tempDir);
  });

  // ── write → read roundtrip ────────────────────────────────────────────

  it("write → read roundtrip returns all fields correctly", () => {
    const id = store.write(makeEntry({ title: "Roundtrip test" }));

    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const entry = store.read(id);
    expect(entry).not.toBeNull();

    expect(entry!.id).toBe(id);
    expect(entry!.title).toBe("Roundtrip test");
    expect(entry!.content).toBe("This is a test memory entry.");
    expect(entry!.scope).toBe("role");
    expect(entry!.role_id).toBe("test-role");
    expect(entry!.category).toBe("note");
    expect(entry!.tags).toEqual(["test"]);
    expect(entry!.relevance).toBe("medium");
    expect(entry!.session_id).toBe("test-session");
    expect(entry!.source_sessions).toEqual([]);

    // Auto-generated timestamps
    expect(entry!.created_at).toBeDefined();
    expect(entry!.updated_at).toBeDefined();
    expect(() => new Date(entry!.created_at)).not.toThrow();
    expect(() => new Date(entry!.updated_at)).not.toThrow();
    expect(entry!.accessed_at).toBeNull();
    expect(entry!.access_count).toBe(0);
  });

  // ── update modifies entry fields ──────────────────────────────────────

  it("update modifies entry fields and changes updated_at", () => {
    const id = store.write(makeEntry({ title: "Original title", content: "Original content" }));

    const before = store.read(id)!;
    const createdBefore = before.created_at;
    const updatedBefore = before.updated_at;

    // Small delay so updated_at is distinguishable
    store.update(id, { title: "Updated title", content: "Updated content" });

    const after = store.read(id)!;

    expect(after.title).toBe("Updated title");
    expect(after.content).toBe("Updated content");

    // created_at must not change
    expect(after.created_at).toBe(createdBefore);

    // updated_at must advance
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(updatedBefore).getTime(),
    );

    // Other fields must remain intact
    expect(after.scope).toBe("role");
    expect(after.role_id).toBe("test-role");
    expect(after.category).toBe("note");
  });

  // ── delete removes entry ──────────────────────────────────────────────

  it("delete removes entry", () => {
    const id = store.write(makeEntry({ title: "To be deleted" }));

    // Verify it exists
    expect(store.read(id)).not.toBeNull();

    store.delete(id);

    // Verify it's gone
    expect(store.read(id)).toBeNull();
  });

  // ── list with scope filter ────────────────────────────────────────────

  it("list with scope filter returns correct subset", () => {
    store.write(makeEntry({ title: "WS entry 1", scope: "workspace", role_id: "ws" }));
    store.write(makeEntry({ title: "WS entry 2", scope: "workspace", role_id: "ws" }));
    store.write(makeEntry({ title: "Role entry 1", scope: "role", role_id: "r1" }));

    const wsResults = store.list({ scope: "workspace" });
    expect(wsResults.length).toBe(2);
    for (const r of wsResults) {
      expect(r.title).toStartWith("WS entry");
    }

    const roleResults = store.list({ scope: "role" });
    expect(roleResults.length).toBe(1);
    expect(roleResults[0].title).toBe("Role entry 1");
  });

  // ── list with category filter ─────────────────────────────────────────

  it("list with category filter returns correct subset", () => {
    store.write(makeEntry({ title: "A note", category: "note" }));
    store.write(makeEntry({ title: "A decision", category: "decision" }));
    store.write(makeEntry({ title: "Another note", category: "note" }));

    const notes = store.list({ category: "note" });
    expect(notes.length).toBe(2);
    for (const r of notes) {
      expect(r.category).toBe("note");
    }

    const decisions = store.list({ category: "decision" });
    expect(decisions.length).toBe(1);
    expect(decisions[0].title).toBe("A decision");
  });

  // ── list respects limit ───────────────────────────────────────────────

  it("list respects limit", () => {
    for (let i = 1; i <= 5; i++) {
      store.write(makeEntry({ title: `Entry ${i}` }));
    }

    const results = store.list({ limit: 3 });
    expect(results.length).toBe(3);
  });

  // ── list sort by recent ────────────────────────────────────────────────

  it("list sort by recent returns entries in descending updated_at order", async () => {
    // Write three entries with small delays to ensure distinct timestamps
    store.write(makeEntry({ title: "First" }));
    await Bun.sleep(2);
    store.write(makeEntry({ title: "Second" }));
    await Bun.sleep(2);
    store.write(makeEntry({ title: "Third" }));

    const results = store.list();

    expect(results.length).toBe(3);
    // The third entry written should be first (most recently updated)
    expect(results[0].title).toBe("Third");
    expect(results[1].title).toBe("Second");
    expect(results[2].title).toBe("First");
  });

  // ── FTS5 search returns ranked results ────────────────────────────────

  it("FTS5 search returns ranked results matching the query", () => {
    store.write(makeEntry({ title: "Auth decision", content: "JWT authentication decision" }));
    store.write(
      makeEntry({ title: "DB pooling", content: "Database connection pooling strategy" }),
    );
    store.write(
      makeEntry({ title: "Token refresh", content: "JWT token refresh logic implementation" }),
    );

    const jwtResults = store.search({ query: "JWT" });
    expect(jwtResults.length).toBe(2);
    const titles = jwtResults.map((e) => e.title).sort();
    expect(titles).toContain("Auth decision");
    expect(titles).toContain("Token refresh");

    const dbResults = store.search({ query: "Database" });
    expect(dbResults.length).toBe(1);
    expect(dbResults[0].title).toBe("DB pooling");
  });

  // ── FTS5 search with no results ───────────────────────────────────────

  it("FTS5 search with no results returns empty array", () => {
    store.write(makeEntry({ title: "Exists", content: "Something here" }));

    const results = store.search({ query: "nonexistentterm12345" });
    expect(results).toEqual([]);
  });

  // ── touch increments access_count ─────────────────────────────────────

  it("touch increments access_count and sets accessed_at", () => {
    const id = store.write(makeEntry({ title: "Tracked entry" }));

    // Before touch
    const before = store.read(id)!;
    expect(before.access_count).toBe(0);
    expect(before.accessed_at).toBeNull();

    // Touch once
    store.touch(id);
    const afterFirst = store.read(id)!;
    expect(afterFirst.access_count).toBe(1);
    expect(afterFirst.accessed_at).not.toBeNull();
    expect(() => new Date(afterFirst.accessed_at!)).not.toThrow();

    // Touch again
    store.touch(id);
    const afterSecond = store.read(id)!;
    expect(afterSecond.access_count).toBe(2);
  });

  // ── stats returns correct counts ──────────────────────────────────────

  it("stats returns correct counts", () => {
    // Write entries with various scopes, categories, and relevances
    store.write(makeEntry({ title: "WS high", scope: "workspace", category: "note", relevance: "high" }));
    store.write(makeEntry({ title: "WS med", scope: "workspace", category: "decision", relevance: "medium" }));
    store.write(makeEntry({ title: "Role high", scope: "role", category: "note", relevance: "high" }));
    store.write(makeEntry({ title: "Role med", scope: "role", category: "decision", relevance: "medium" }));
    store.write(makeEntry({ title: "Role low", scope: "role", category: "decision", relevance: "low" }));

    const s = store.stats();

    expect(s.total).toBe(5);

    // byScope
    expect(s.byScope["workspace"]).toBe(2);
    expect(s.byScope["role"]).toBe(3);

    // byCategory
    expect(s.byCategory["note"]).toBe(2);
    expect(s.byCategory["decision"]).toBe(3);

    // byRelevance
    expect(s.byRelevance["high"]).toBe(2);
    expect(s.byRelevance["medium"]).toBe(2);
    expect(s.byRelevance["low"]).toBe(1);
  });

  // ── duplicate write generates distinct IDs ────────────────────────────

  it("duplicate write generates distinct IDs", async () => {
    const entry = makeEntry({ title: "Duplicate test" });

    const id1 = store.write(entry);
    // Small delay so Date.now() produces a different hash seed
    await Bun.sleep(1);
    const id2 = store.write(entry);

    expect(id1).not.toBe(id2);

    // Both should be readable
    const e1 = store.read(id1);
    const e2 = store.read(id2);
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e1!.id).toBe(id1);
    expect(e2!.id).toBe(id2);
  });

  // ── read of non-existent ID returns null ──────────────────────────────

  it("read of non-existent ID returns null", () => {
    expect(store.read("nonexistent-id-12345")).toBeNull();
  });

  // ── update of non-existent ID does not throw ──────────────────────────

  it("update of non-existent ID does not throw", () => {
    expect(() => {
      store.update("nonexistent-id-12345", { title: "Nope" });
    }).not.toThrow();
  });

  // ── delete of non-existent ID does not throw ──────────────────────────

  it("delete of non-existent ID does not throw", () => {
    expect(() => {
      store.delete("nonexistent-id-12345");
    }).not.toThrow();
  });

  // ─── additional: list default sort (recent) does not crash on empty store ─

  it("list on empty store returns empty array", () => {
    const results = store.list();
    expect(results).toEqual([]);
  });

  // ─── additional: list with scope=both (should return all) ───────────────

  it("list with scope both returns all entries regardless of scope", () => {
    store.write(makeEntry({ title: "WS", scope: "workspace" }));
    store.write(makeEntry({ title: "Role", scope: "role" }));

    // "both" means no scope filter in the query
    const results = store.list({ scope: "both" });
    expect(results.length).toBe(2);
  });

  // ─── additional: list with sort=accessed ────────────────────────────────

  it("list with sort=accessed returns entries ordered by accessed_at", async () => {
    const id1 = store.write(makeEntry({ title: "First" }));
    await Bun.sleep(2);
    const id2 = store.write(makeEntry({ title: "Second" }));
    await Bun.sleep(2);
    const id3 = store.write(makeEntry({ title: "Third" }));
    await Bun.sleep(2);

    // Touch some entries in a specific order with delays
    store.touch(id3);
    await Bun.sleep(2);
    store.touch(id1);

    const results = store.list({ sort: "accessed" });
    expect(results.length).toBe(3);
    // id1 was touched last → should appear first (desc)
    expect(results[0].title).toBe("First");
    // id3 was touched before id1 → second
    expect(results[1].title).toBe("Third");
    // id2 was never touched → last (NULLS LAST)
    expect(results[2].title).toBe("Second");
  });

  // ─── additional: update with tags and source_sessions ───────────────────

  it("update with tags and source_sessions serializes correctly", () => {
    const id = store.write(makeEntry({ title: "Tags test" }));

    store.update(id, {
      tags: ["updated", "tags"],
      source_sessions: ["ses-1", "ses-2"],
    });

    const entry = store.read(id)!;
    expect(entry.tags).toEqual(["updated", "tags"]);
    expect(entry.source_sessions).toEqual(["ses-1", "ses-2"]);
  });
});
