
import { describe, expect, expectTypeOf, it } from "vitest";

import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { GraphStoreFormatError } from "../../src/graph/store/errors.ts";
import {
  initializeStore,
  requireTableShape,
  verifyStore,
} from "../../src/graph/store/format.ts";
import {
  GRAPH_STORE_COLUMNS,
  GRAPH_STORE_TABLES,
  SCHEMA_STATEMENTS,
  type GraphStoreColumn,
  type GraphStoreColumnName,
} from "../../src/graph/store/schema.ts";

/** The table the audit's probe used: the execution binding, by name. */
const EXECUTIONS = GRAPH_STORE_TABLES.executions;
const RECEIPTS = GRAPH_STORE_TABLES.receipts;

/** Every table role this format owns, in gate order. */
const ROLES = Object.keys(GRAPH_STORE_COLUMNS) as Array<keyof typeof GRAPH_STORE_TABLES>;

/** SQLite's storage class, as this build spells it back from the DDL. */
function affinityOfSqlType(sqlType: string): GraphStoreColumn["affinity"] {
  if (sqlType === "TEXT") return "text";
  if (sqlType === "INTEGER") return "integer";
  if (sqlType === "REAL") return "numeric";
  throw new Error("unexpected SQL type in the generated DDL: " + sqlType);
}

/** One column as the DDL text declares it, read back independently. */
interface DeclaredColumn {
  readonly name: string;
  readonly affinity: GraphStoreColumn["affinity"];
  readonly primaryKey: number;
  readonly notNull: boolean;
}

/**
 * The shape ONE generated statement declares, read back from its text.
 *
 * This is deliberately a second reader of the same bytes: it takes nothing from
 * the catalog, so comparing the two is a real cross-check rather than a
 * restatement. Lines are separated by `,\n` because the generator joins clauses
 * that way; a comma INSIDE a CHECK (an `IN` list) is followed by a space, never
 * by a line break.
 */
function declaredShapeOf(statement: string): {
  readonly columns: readonly DeclaredColumn[];
  readonly key: readonly string[];
} {
  const open = statement.indexOf(" (\n");
  const body = statement.slice(open + 3, statement.length - "\n   )".length);
  const parsed: Array<{
    readonly name: string;
    readonly affinity: GraphStoreColumn["affinity"];
    readonly notNull: boolean;
    readonly inlineKey: boolean;
  }> = [];
  const tableKey: string[] = [];
  for (const line of body.split(",\n")) {
    const clause = line.trim();
    if (clause.startsWith("CHECK (") || clause.startsWith("UNIQUE (")) continue;
    if (clause.startsWith("PRIMARY KEY (")) {
      for (const name of clause.slice("PRIMARY KEY (".length, clause.length - 1).split(", ")) {
        tableKey.push(name);
      }
      continue;
    }
    const match = clause.match(/^([a-z_]+) (TEXT|INTEGER|REAL)(.*)$/);
    if (match === null) throw new Error("unparseable DDL clause: " + clause);
    const [, name, sqlType, rest] = match;
    parsed.push({
      name: name as string,
      affinity: affinityOfSqlType(sqlType as string),
      notNull: (rest as string).includes("NOT NULL"),
      inlineKey: (rest as string).includes("PRIMARY KEY"),
    });
  }
  const key = tableKey.length > 0 ? tableKey : parsed.filter((entry) => entry.inlineKey).map((entry) => entry.name);
  return {
    columns: parsed.map((entry) => ({
      name: entry.name,
      affinity: entry.affinity,
      notNull: entry.notNull,
      primaryKey: key.indexOf(entry.name) + 1,
    })),
    key,
  };
}

/** Every statement of the format, keyed by the table it creates. */
function statementFor(role: keyof typeof GRAPH_STORE_TABLES): string {
  const marker = "CREATE TABLE IF NOT EXISTS " + GRAPH_STORE_TABLES[role] + " (";
  const statement = SCHEMA_STATEMENTS.find((entry) => entry.startsWith(marker));
  if (statement === undefined) throw new Error("no statement for " + GRAPH_STORE_TABLES[role]);
  return statement;
}

describe("C-01 — the catalog is the one spelling of a store column", () => {
  it("makes a column name outside the catalog unwritable at the type level", () => {
    // The pre-fix type was `string`, so BOTH of these held and the two negative
    // pins below would fail on the old bytes.
    expectTypeOf<GraphStoreColumn["name"]>().not.toEqualTypeOf<string>();
    expectTypeOf<GraphStoreColumn["name"]>().toEqualTypeOf<GraphStoreColumnName>();
    // A name the catalog does not declare: the exact column the audit added to
    // the DDL alone. Nothing about it is a valid column of this format.
    expectTypeOf<{
      readonly name: "refused_reason";
      readonly affinity: "text";
      readonly primaryKey: 0;
      readonly notNull: false;
    }>().not.toExtend<GraphStoreColumn>();
    expectTypeOf<"refused_reason">().not.toExtend<GraphStoreColumnName>();
    expectTypeOf<"note">().not.toExtend<GraphStoreColumnName>();
    // The control: a name the catalog DOES declare still fits, so the pin above
    // rejects the drift rather than every assignment.
    expectTypeOf<"refused_kind">().toExtend<GraphStoreColumnName>();
    expectTypeOf<{
      readonly name: "refused_kind";
      readonly affinity: "text";
      readonly primaryKey: 0;
      readonly notNull: false;
    }>().toExtend<GraphStoreColumn>();
  });

  it("generates exactly one DDL statement per table, and each catalog column is in it", () => {
    expect(SCHEMA_STATEMENTS).toHaveLength(ROLES.length);
    for (const role of ROLES) {
      expect(statementFor(role)).toContain(
        "CREATE TABLE IF NOT EXISTS " + GRAPH_STORE_TABLES[role] + " (",
      );
    }
    const db = createDatabaseSync(":memory:");
    try {
      initializeStore(db, ":memory:");
      for (const role of ROLES) requireTableShape(db, role, ":memory:");
      verifyStore(db, ":memory:");
    } finally {
      db.close();
    }
  });

  it("re-derives every column from the DDL text and matches the catalog", () => {
    for (const role of ROLES) {
      const expected = GRAPH_STORE_COLUMNS[role];
      const declared = declaredShapeOf(statementFor(role));
      expect(declared.columns).toEqual(
        expected.map((column) => ({
          name: column.name,
          affinity: column.affinity,
          notNull: column.notNull,
          primaryKey: column.primaryKey,
        })),
      );
      expect(declared.key).toEqual(
        expected
          .filter((column) => column.primaryKey > 0)
          .sort((left, right) => left.primaryKey - right.primaryKey)
          .map((column) => column.name),
      );
    }
  });

  it("refuses a foreign extra column by name, naming the column and the table", () => {
    const db = createDatabaseSync(":memory:");
    try {
      initializeStore(db, ":memory:");
      verifyStore(db, ":memory:");
      // The audit's exact scenario, now possible only as a FOREIGN edit: the
      // file carries a column this format never wrote.
      db.exec("ALTER TABLE " + EXECUTIONS + " ADD COLUMN refused_reason TEXT");
      const refusal = (() => {
        try {
          verifyStore(db, ":memory:");
        } catch (caught) {
          return caught;
        }
      })();
      expect(refusal).toBeInstanceOf(GraphStoreFormatError);
      if (refusal instanceof GraphStoreFormatError) {
        expect(refusal.problem).toBe("incomplete-store");
        expect(String(refusal.message)).toContain("refused_reason");
        expect(String(refusal.message)).toContain(EXECUTIONS);
      }
    } finally {
      db.close();
    }
  });

  it("refuses a foreign renamed column by name, in both directions", () => {
    const db = createDatabaseSync(":memory:");
    try {
      initializeStore(db, ":memory:");
      db.exec("ALTER TABLE " + RECEIPTS + " RENAME COLUMN proposal_digest TO proposal_hash");
      const refusal = (() => {
        try {
          verifyStore(db, ":memory:");
        } catch (caught) {
          return caught;
        }
      })();
      expect(refusal).toBeInstanceOf(GraphStoreFormatError);
      if (refusal instanceof GraphStoreFormatError) {
        expect(refusal.problem).toBe("incomplete-store");
        expect(String(refusal.message)).toContain("proposal_digest is missing");
        expect(String(refusal.message)).toContain("proposal_hash is not part of format 9");
        expect(String(refusal.message)).toContain(RECEIPTS);
      }
    } finally {
      db.close();
    }
  });
});
