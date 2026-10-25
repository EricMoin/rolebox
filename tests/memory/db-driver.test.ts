import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  createDatabaseSync,
  type DatabaseDriver,
  type DatabaseOpenOptions,
} from "../../src/memory/db-driver.ts";

describe.each([
  { name: "async", open: createDatabase },
  { name: "sync", open: createDatabaseSync },
])("Node SQLite driver ($name)", ({ open }) => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rolebox-db-driver-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function withDatabase(
    path: string,
    run: (db: DatabaseDriver) => void | Promise<void>,
    options: DatabaseOpenOptions = {},
  ): Promise<void> {
    const db = await open(path, options);
    try {
      await run(db);
    } finally {
      db.close();
    }
  }

  it("binds variadic parameters and reuses prepared statements", async () => {
    await withDatabase(":memory:", db => {
      db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT)");
      db.run("INSERT INTO entries VALUES (?, ?)", 1, "first");
      const insert = db.query("INSERT INTO entries VALUES (?, ?)");
      insert.run(2, "second");
      insert.run(3, "third");
      const select = db.query("SELECT title FROM entries WHERE id = ?");
      expect(select.get(1)).toEqual({ title: "first" });
      expect(select.get(2)).toEqual({ title: "second" });
      expect(select.get(99)).toBeUndefined();
      expect(db.query("SELECT id FROM entries ORDER BY id").all()).toEqual([
        { id: 1 }, { id: 2 }, { id: 3 },
      ]);
    });
  });

  it("commits transactions and returns the callback result", async () => {
    await withDatabase(":memory:", db => {
      db.exec("CREATE TABLE entries (id INTEGER)");
      expect(db.transaction(() => {
        db.run("INSERT INTO entries VALUES (?)", 1);
        return "committed";
      })()).toBe("committed");
      expect(db.query("SELECT id FROM entries").all()).toEqual([{ id: 1 }]);
    });
  });

  it("rolls back failed transactions and permits a later commit", async () => {
    await withDatabase(":memory:", db => {
      db.exec("CREATE TABLE entries (id INTEGER)");
      const failure = new Error("reject write");
      expect(db.transaction(() => {
        db.run("INSERT INTO entries VALUES (?)", 1);
        throw failure;
      })).toThrow(failure);
      expect(db.query("SELECT id FROM entries").all()).toEqual([]);
      db.transaction(() => db.run("INSERT INTO entries VALUES (?)", 2))();
      expect(db.query("SELECT id FROM entries").all()).toEqual([{ id: 2 }]);
    });
  });

  it("persists data and refuses writes on read-only connections", async () => {
    const path = join(directory, "entries.db");
    await withDatabase(path, db => {
      db.exec("CREATE TABLE entries (id INTEGER)");
      db.run("INSERT INTO entries VALUES (?)", 42);
    });
    await withDatabase(path, db => {
      expect(db.query("SELECT id FROM entries").get()).toEqual({ id: 42 });
      expect(() => db.run("INSERT INTO entries VALUES (?)", 43)).toThrow();
    }, { readonly: true });
  });

  it("opens independent connections over the same database", async () => {
    const path = join(directory, "shared.db");
    await withDatabase(path, async writer => {
      writer.exec("CREATE TABLE entries (id INTEGER)");
      await withDatabase(path, reader => {
        writer.transaction(() => writer.run("INSERT INTO entries VALUES (?)", 7))();
        expect(reader.query("SELECT id FROM entries").get()).toEqual({ id: 7 });
      });
    });
  });

  it("supports FTS5 search", async () => {
    await withDatabase(":memory:", db => {
      db.exec("CREATE VIRTUAL TABLE notes USING fts5(content)");
      db.run("INSERT INTO notes VALUES (?)", "persistent agent memory");
      expect(db.query("SELECT content FROM notes WHERE notes MATCH ?").get("memory"))
        .toEqual({ content: "persistent agent memory" });
    });
  });

  it("releases file handles and prepared statements when closed", async () => {
    const path = join(directory, "closed.db");
    await withDatabase(path, db => {
      db.exec("CREATE TABLE entries (id INTEGER)");
      db.query("SELECT id FROM entries").all();
    });
    expect(() => rmSync(path)).not.toThrow();
  });

  it("rejects opening a missing read-only database", async () => {
    await expect(withDatabase(join(directory, "missing.db"), () => {}, { readonly: true }))
      .rejects.toThrow();
  });
});
