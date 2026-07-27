/**
 * Graph Model v2 — Declaration Serializer
 *
 * Phase 4, Subtask 3. Produces YAML text for a v2 {@link GraphDeclaration},
 * wrapped in the canonical `{ graph: ... }` document envelope that
 * `parseGraph` (parser-v2.ts) expects as its root key.
 *
 * Serialization is the inverse of the parser-v2 deserializer:
 * `dump({ graph: d })` → YAML → `parseGraph` → the same declaration. No new
 * parser is written — the deserialization path is the existing parser-v2 +
 * validator-v2 entry point (`importGraphFromFile` in parser.ts:149).
 *
 * The dump options mirror `init-scaffold.ts` `YAML_OPTS` (lineWidth: -1 to
 * avoid automatic line wrapping, noRefs to keep the output flat). `noRefs` is
 * what guarantees a clean round-trip: without it, js-yaml would emit `&idN`
 * aliases for shared references, which still parse but produce an opaque
 * document; with it the serialized form is a plain nested mapping.
 *
 * Design reference: .rolebox/design/dag-yaml-schema.md, src/types.graph-v2.ts.
 */

import { dump } from "js-yaml";
import type { GraphDeclaration } from "../types.graph-v2.ts";

/** Shared js-yaml dump options to avoid automatic line wrapping and aliases. */
const YAML_OPTS = {
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
} as const;

/**
 * Serialize a v2 graph declaration to YAML text, wrapped in the canonical
 * `graph:` document envelope consumed by `parseGraph`.
 */
export function serializeGraphDeclaration(d: GraphDeclaration): string {
  return dump({ graph: d }, YAML_OPTS);
}
