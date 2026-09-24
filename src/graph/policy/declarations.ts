import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  loadCompletionPolicies,
  type CompletionPolicyBody,
  type CompletionPolicyCatalogEntry,
  type CompletionPolicyLoadIssue,
  type CompletionPolicyLoadResult,
  type CompletionPolicyRef
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

// ── The shipped authorization entry point (P4 item 3) ───────────────────────

/**
 * The environment variable an operator authorizes completion-policy revisions
 * with.
 */
export const COMPLETION_POLICY_AUTHORIZATION_ENV =
  "ROLEBOX_GRAPH_COMPLETION_POLICIES";

/** What {@link loadGraphCompletionPolicies} produced. */
export interface GraphCompletionPolicyLoadResult extends CompletionPolicyLoadResult {
  /** The content-pinned refs the configuration authorized and the catalog held. */
  readonly authorized: readonly CompletionPolicyRef[];
}

/**
 * Load the completion policies the HOST authorized, from the shipped catalog
 * plus the operator's environment configuration.
 *
 * THE ONE ENTRY POINT the shipped hosts call, so compile and run are handed the
 * same registry: the toolset resolves a declaration's `completion_policy`
 * REQUEST against it and the host corroborates the pinned revision with it. No
 * capability is installed without an authorization, and no authorization
 * installs a body that does not hash to the ref it names.
 *
 * TOTAL: every rejection is an issue, and neither a malformed document nor an
 * unreadable body throws. The default environment installs NOTHING, which is
 * the honest shipped default: a repository declaration is not an authorization.
 */
export function loadGraphCompletionPolicies(
  env: Readonly<Record<string, string | undefined>> = {},
  catalog: readonly CompletionPolicyCatalogEntry[] = REPOSITORY_COMPLETION_POLICIES,
): GraphCompletionPolicyLoadResult {
  const issues: CompletionPolicyLoadIssue[] = [];
  const text = (env[COMPLETION_POLICY_AUTHORIZATION_ENV] ?? "").trim();
  if (text.length === 0) {
    return {
      registry: createCompletionPolicyRegistry({ policies: [] }),
      issues: Object.freeze([]),
      authorized: Object.freeze([]),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      registry: createCompletionPolicyRegistry({ policies: [] }),
      issues: Object.freeze([
        Object.freeze({
          kind: "malformed-authorization" as const,
          index: 0,
          message:
            "the configured completion-policy authorization is not JSON (" +
            errorText(error) +
            "), so nothing is authorized",
        }),
      ]),
      authorized: Object.freeze([]),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      registry: createCompletionPolicyRegistry({ policies: [] }),
      issues: Object.freeze([
        Object.freeze({
          kind: "malformed-authorization" as const,
          index: 0,
          message:
            "the configured completion-policy authorization is not a { declare?, authorize } document, so nothing is authorized",
        }),
      ]),
      authorized: Object.freeze([]),
    };
  }
  const document = parsed as Record<string, unknown>;
  const declaredRaw = document.declare;
  const declared: readonly unknown[] =
    declaredRaw === undefined ? [] : Array.isArray(declaredRaw) ? declaredRaw : [declaredRaw];
  if (declaredRaw !== undefined && !Array.isArray(declaredRaw)) {
    issues.push(
      Object.freeze({
        kind: "malformed-catalog-entry",
        index: 0,
        message:
          "the configured declare field is not an array of declarations, so no host declaration was installed",
      }),
    );
  }
  const combined: CompletionPolicyCatalogEntry[] = [
    ...catalog,
    ...declared.map((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as CompletionPolicyCatalogEntry)
        : ({ id: "", revision: "", body: entry } satisfies CompletionPolicyCatalogEntry),
    ),
  ];
  const authorizeRaw = document.authorize;
  const tokens: readonly unknown[] =
    authorizeRaw === undefined ? [] : Array.isArray(authorizeRaw) ? authorizeRaw : [authorizeRaw];
  if (authorizeRaw !== undefined && !Array.isArray(authorizeRaw)) {
    issues.push(
      Object.freeze({
        kind: "malformed-authorization",
        index: 0,
        message:
          "the configured authorize field is not an array of id@revision tokens, so nothing was authorized",
      }),
    );
  }
  const authorized: CompletionPolicyRef[] = [];
  const seen = new Set<string>();
  tokens.forEach((token, index) => {
    if (typeof token !== "string" || token.trim().length === 0) {
      issues.push(
        Object.freeze({
          kind: "malformed-authorization",
          index,
          message: "an authorization is not a non-empty id@revision token",
        }),
      );
      return;
    }
    const at = token.lastIndexOf("@");
    const id = at <= 0 ? "" : token.slice(0, at);
    const revision = at <= 0 ? "" : token.slice(at + 1);
    if (id.length === 0 || revision.length === 0) {
      issues.push(
        Object.freeze({
          kind: "malformed-authorization",
          index,
          message:
            "authorization " +
            JSON.stringify(token) +
            " is not id@revision (the id must not contain @)",
        }),
      );
      return;
    }
    const declaration = combined.find(
      (entry) => entry.id === id && entry.revision === revision,
    );
    if (declaration === undefined) {
      issues.push(
        Object.freeze({
          kind: "malformed-authorization",
          index,
          message:
            "authorization " +
            JSON.stringify(token) +
            " names no declaration this catalog offers — a host declaration must be listed in declare, and a repository one must exist in reviewed source",
        }),
      );
      return;
    }
    let ref: CompletionPolicyRef;
    try {
      ref = completionPolicyRefOf(declaration);
    } catch (error) {
      issues.push(
        Object.freeze({
          kind: "malformed-authorization",
          index,
          message:
            "authorization " +
            JSON.stringify(token) +
            " names a declaration whose body cannot be content-addressed (" +
            errorText(error) +
            "), so no digest can be pinned",
        }),
      );
      return;
    }
    const key = id + "\u0000" + revision;
    if (seen.has(key)) return;
    seen.add(key);
    authorized.push(ref);
  });
  const loaded = loadCompletionPolicies({ catalog: combined, authorized });
  return {
    registry: loaded.registry,
    issues: Object.freeze([...issues, ...loaded.issues]),
    authorized: Object.freeze(authorized),
  };
}

/**
 * One configured completion-policy issue as a single log line.
 *
 * The issues carry exactly the identities and digests an operator needs to see
 * why an authorization did not install; nothing else is read.
 */
export function describeCompletionPolicyIssue(
  issue: CompletionPolicyLoadIssue,
): string {
  switch (issue.kind) {
    case "malformed-catalog-entry":
      return "catalog[" + String(issue.index) + "]: " + issue.message;
    case "malformed-authorization":
      return "authorization[" + String(issue.index) + "]: " + issue.message;
    case "conflicting-authorization":
      return (
        "authorization conflict for " +
        JSON.stringify(issue.id) +
        "@" +
        JSON.stringify(issue.revision) +
        ": digests " +
        issue.digests.join(", ")
      );
    case "not-authorized":
      return (
        "declaration " +
        JSON.stringify(issue.id) +
        "@" +
        JSON.stringify(issue.revision) +
        " is present in the catalog and NOT authorized, so it is not installed"
      );
    case "catalog-missing":
      return (
        "authorization names " +
        JSON.stringify(issue.ref.id) +
        "@" +
        JSON.stringify(issue.ref.revision) +
        " and the catalog does not offer it"
      );
    case "malformed-policy":
      return (
        "declaration " +
        JSON.stringify(issue.ref.id) +
        "@" +
        JSON.stringify(issue.ref.revision) +
        " is not a readable completion policy: " +
        issue.message
      );
    case "digest-mismatch":
      return (
        "declaration " +
        JSON.stringify(issue.ref.id) +
        "@" +
        JSON.stringify(issue.ref.revision) +
        " does not hash to the authorized digest " +
        issue.ref.digest +
        " (it hashes to " +
        issue.actual +
        ")"
      );
  }
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
