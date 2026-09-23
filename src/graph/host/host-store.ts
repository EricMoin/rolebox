/**
 * Graph Execution Engine v2 — the RETIRED host-store path
 *
 * Version: 3.0
 * Date: 2026-09-23
 *
 * WHAT USED TO BE HERE. `HostStore` owned `rolebox-host-store.sqlite`: the
 * execution registry, the credential records, its own format gate and its own
 * transaction boundary. It was the second durable authority of the workspace,
 * committing independently of the acceptance ledger — the shape P1 item 3
 * removes.
 *
 * WHAT IS HERE NOW. The host records are TABLES of the workspace's one graph
 * store (`src/graph/store/`, same file as the acceptance ledger), and the
 * modules that own their meaning — `execution-index.ts`, `credential-vault.ts`,
 * `invocation-origins.ts` — are typed facades over that store. No schema, no
 * connection and no transaction lives in this module any more.
 *
 * WHAT IS DELIBERATELY LEFT. {@link hostStoreRoot}, because the entry points
 * (`src/entries/dsh.ts`, `src/entries/pi.ts`) import the workspace's store root
 * from this path. It now DELEGATES to `graphStoreRoot`: the root did not move,
 * only the authority inside it.
 *
 * WHAT THE NEXT P1 STEP DELETES. This module, the two entry imports, and the
 * retired files themselves (`RETIRED_AUTHORITY_FILES` in
 * `src/graph/store/schema.ts`) after the one-time inventory/archive (`§P6.4`).
 * Until then the store REFUSES to initialize beside a non-empty retired
 * authority instead of answering "no execution binding" for its records.
 */

import { graphStoreRoot } from "../store/schema.ts";

/**
 * The store root for one workspace, under the host's OWN data directory.
 *
 * The root is deliberately NOT inside the workspace: a dispatched worker runs
 * with the workspace as its root, so keeping the host's state beside it would
 * hand every worker the directory (never a defense by itself — see
 * `credential-vault.ts` — but the one path-shaped part of the boundary this
 * build can choose). The entry points pass their own data directory in, so this
 * module stays free of CLI/platform layering.
 */
export function hostStoreRoot(dataDir: string, workspaceDir: string): string {
  return graphStoreRoot(dataDir, workspaceDir);
}
