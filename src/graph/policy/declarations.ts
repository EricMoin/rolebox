/**
 * Graph Execution Engine v2 — the repository's completion-policy declarations
 * (D6)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * THE REVIEWABLE DATA. These are the completion-policy declarations this
 * repository ships and reviews (docs/graph-outcome-protocol.md § "Contract
 * ownership and authority"). Each declaration is VERSIONED by an immutable
 * `revision` string and content-addressed by the ONE canonical
 * `contractDigest` over its body
 * (`src/graph/policy/completion-policy.ts`, `completionPolicyRefOf`); git
 * history is the review trail for the source, and the digest is what an
 * authorization actually pins, so editing a body after review produces a
 * DIFFERENT identity rather than silently changing what was granted.
 *
 * WHY SOURCE, NOT A POLICY FILE IN THE WORKSPACE. A file's presence is not
 * authority: the working tree is writable by the very workers a graph runs, so
 * a policy document a worker can drop next to the graph would let it authorize
 * itself. The declarations live in reviewed source and are compiled into the
 * build; a host installs a selection of them by content-pinned ref through
 * `loadCompletionPolicies({ catalog, authorized })`, which admits nothing the
 * host did not authorize. The compiler and the runtime never read a policy
 * file at all — they receive the resulting registry.
 *
 * WHAT IS SHIPPED, AND WHY THESE TWO. The same policy id has two revisions that
 * differ in the one place a policy states what its silence means:
 * - `@1` — `default: "ungranted"`: it grants nothing and forbids nothing, so
 *   a natural mapping it does not list compiles to a NON-EXECUTABLE DRAFT. It
 *   is the neutral starting point an operator extends with grants.
 * - `@2` — `default: "deny"`: it explicitly forbids every natural mapping, so
 *   a graph that requests it and asks for natural completion is REFUSED at
 *   compile time. It is the "no natural completion here" policy.
 *
 * Neither revision ships a grant: authorizing a concrete mapping is a decision
 * about a concrete graph, and this repository ships no graph whose natural
 * completion would be authorized by default.
 */

import type {
  CompletionPolicyBody,
  CompletionPolicyCatalogEntry,
} from "./completion-policy.ts";

/** One shipped declaration: a catalog entry whose body is type-checked here. */
export interface RepositoryCompletionPolicyDeclaration {
  readonly id: string;
  readonly revision: string;
  readonly body: CompletionPolicyBody;
}

/**
 * The policy id this repository's declarations share. It is an identity, never
 * a "latest" pointer: a request names the exact revision it wants.
 */
export const REPOSITORY_COMPLETION_POLICY_ID = "rolebox.graph.completion";

/**
 * The shipped declarations. Frozen, and `satisfies` the catalog shape so a
 * declaration a host could not load is a compile error here.
 */
export const REPOSITORY_COMPLETION_POLICIES: readonly RepositoryCompletionPolicyDeclaration[] =
  Object.freeze([
    Object.freeze({
      id: REPOSITORY_COMPLETION_POLICY_ID,
      revision: "1",
      body: Object.freeze({
        version: 1 as const,
        default: "ungranted" as const,
        rules: Object.freeze([]),
      }),
    }),
    Object.freeze({
      id: REPOSITORY_COMPLETION_POLICY_ID,
      revision: "2",
      body: Object.freeze({
        version: 1 as const,
        default: "deny" as const,
        rules: Object.freeze([]),
      }),
    }),
  ] satisfies readonly CompletionPolicyCatalogEntry[]);
