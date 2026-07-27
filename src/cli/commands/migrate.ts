/**
 * `rolebox migrate` — Collaboration → Graph Declaration Migration
 *
 * Phase 4, Subtask 4. Reads a legacy v1 role.yaml that declares a
 * `collaboration:` block and no `graph:` block, converts that collaboration
 * config into the equivalent v2 `GraphDeclaration` (via the subtask-1
 * converter), serializes it as the canonical `graph:` YAML envelope (via the
 * subtask-3 serializer), and writes the file back with the original
 * `collaboration:` block preserved as YAML comments so the migration is
 * auditable and reversible by hand.
 *
 * The command is a no-op when the role already carries a `graph:` block or
 * when no `collaboration:` block is present.
 *
 * The conversion itself is reference-aligned with the legacy collaboration
 * parser (src/graph/converter.ts) — node count, edge direction, and loop cap
 * (`max_traversals == max_iterations`) are preserved exactly. Only the
 * serialized document structure changes.
 */

import { defineCommand } from "citty";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import yaml from "js-yaml";
import {
  convertCollaborationToGraphDeclaration,
} from "../../graph/converter.ts";
import { serializeGraphDeclaration } from "../../graph/serialize.ts";
import type { CollaborationConfig } from "../../types.ts";

/** Prefix prepended to each original `collaboration:` block line. */
const LEGACY_PREFIX = "# legacy collaboration: ";

/** Fallback terminal-node agent id when the role defines no usable name. */
const FALLBACK_PARENT_AGENT_ID = "rolebox-parent";

/** Outcome of a migrate run — both human and test consumable. */
export interface MigrateResult {
  action: "migrated" | "no-op";
  reason?: string;
}

/**
 * Migrate a single role.yaml in place: convert `collaboration:` → `graph:`,
 * preserving the original collaboration block as YAML comments.
 *
 * @param roleYamlPath - path to the role.yaml file.
 * @param parentAgentId - dispatchable id of the terminal approval (parent)
 *   node; defaults to the role's `name`, then to a stable fallback. Does not
 *   affect topology equivalence.
 * @throws when the file is unreadable, unparsable, or conversion fails.
 */
export function migrate(
  roleYamlPath: string,
  parentAgentId?: string,
): MigrateResult {
  const abs = resolve(roleYamlPath);
  if (!existsSync(abs)) {
    throw new Error(`Role YAML not found: ${roleYamlPath}`);
  }

  const text = readFileSync(abs, "utf-8");

  const doc = yaml.load(text) as Record<string, unknown> | null | undefined;
  if (doc === null || doc === undefined || typeof doc !== "object") {
    throw new Error(`Failed to parse role YAML: ${roleYamlPath}`);
  }

  if (doc.graph !== undefined) {
    return { action: "no-op", reason: "graph block already present" };
  }
  if (doc.collaboration === undefined || doc.collaboration === null) {
    return { action: "no-op", reason: "no collaboration block present" };
  }

  const collab = doc.collaboration as unknown as CollaborationConfig;

  const roleName =
    typeof doc.name === "string" && doc.name.trim() !== ""
      ? doc.name.trim()
      : basename(abs, ".yaml");
  const parent =
    parentAgentId ?? (roleName !== "" ? roleName : FALLBACK_PARENT_AGENT_ID);

  let decl;
  try {
    decl = convertCollaborationToGraphDeclaration(collab, {
      parentAgentId: parent,
      name: roleName,
    });
  } catch (err) {
    throw new Error(
      `Failed to convert collaboration block: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const graphYaml = serializeGraphDeclaration(decl);

  const { start, end } = findCollaborationBlock(text);
  const lines = text.split("\n");
  for (let i = start; i <= end; i += 1) {
    lines[i] = LEGACY_PREFIX + lines[i];
  }
  const commented = lines.join("\n");

  const out = `${commented.replace(/\s+$/, "")}\n\n${graphYaml.replace(/\s+$/, "")}\n`;
  writeFileSync(abs, out, "utf-8");

  return { action: "migrated" };
}

/**
 * Locate the `collaboration:` block in the original document text.
 *
 * The block header is the top-level (column-0) `collaboration:` key; the block
 * spans every subsequent line up to the next top-level key (a sibling) or EOF.
 * Nested keys (`topology`, `agents`, `termination`, ...) are indented and stay
 * inside the block. Returns inclusive line indices.
 */
function findCollaborationBlock(text: string): {
  start: number;
  end: number;
} {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^collaboration:\s*$/.test(line));
  if (start === -1) {
    // Unreachable when a parsed collaboration block exists, but guard anyway.
    return { start: -1, end: -1 };
  }

  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== "" && !/^\s/.test(line) && /^[A-Za-z0-9_-]+\s*:/.test(line)) {
      end = i - 1;
      break;
    }
  }
  return { start, end };
}

export default defineCommand({
  meta: {
    name: "migrate",
    description:
      "Convert a legacy collaboration: block in a role.yaml to the equivalent graph: declaration, preserving collaboration as comments",
  },
  args: {
    roleYamlPath: {
      type: "positional",
      description: "Path to the role.yaml to migrate",
      required: true,
    },
    parent: {
      type: "string",
      description:
        "Dispatchable id of the terminal approval (parent) node (defaults to the role name)",
    },
  },
  async run({ args }) {
    const result = migrate(args.roleYamlPath, args.parent);
    if (result.action === "migrated") {
      console.log(`Migrated: ${args.roleYamlPath} (collaboration: preserved as comments)`);
    } else {
      console.log(`No-op: ${args.roleYamlPath} (${result.reason})`);
    }
  },
});
