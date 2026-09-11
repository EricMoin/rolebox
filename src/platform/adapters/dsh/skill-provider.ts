/**
 * DshSkillProvider — rolebox's pull-style skill source for dsh's global
 * `ctx.skills` registry.
 *
 * dsh resolves model- and user-facing skills EXCLUSIVELY through the
 * `dsh-skill` registry (`ctx.skills`), a layered merge of
 * provider catalogs. rolebox never registered into it, so under dsh the role
 * prompt's `<available_skills>` block (`buildSkillBlock`,
 * `src/prompt/builder.ts:127`) advertised names the `skill` tool could not
 * resolve — the defect this module closes.
 *
 * The registry's plugin seam is `ctx.skills.registerProvider(create)` — a
 * FACTORY: `create(control)` is invoked once and must return a
 * {@link DshSkillProvider} (`control = {signal, invalidate}`). Verified
 * against the installed rc.6 dist:
 *   - `dsh-skill/lib/types/index.d.ts:249` —
 *     `registerProvider(create: (control: SkillProviderControl) => SkillProvider)`
 *   - `dsh-skill/lib/types/index.d.ts:190-195` — `SkillProviderControl`
 *     (`{signal: AbortSignal, invalidate: () => void}`)
 *   - `dsh-skill/lib/types/index.d.ts:168-188` — `SkillProvider`
 *     (`name` / `list(options)` / `get(candidate, options)`)
 *   - `dsh-skill/lib/types/index.d.ts:88-93` — `SkillLookupOptions` is
 *     `{cwd?, signal?}` only: a provider receives NO scope/agent/session.
 *
 * ── Why a provider, not `ctx.skills.register()` ────────────────────────────
 * `ctx.skills.register(skill)` requires an EAGER `content` body
 * (`SkillRegistration = Omit<SkillDefinition, "invocation" | "provider">`,
 * `index.d.ts:71-79`), forcing every role's every skill to be read at boot.
 * `registerProvider` is lazy: `list()` advertises metadata, `get()` loads the
 * body only when the model actually invokes the skill — mirroring how the
 * Pi surface references skill files and reads them on demand.
 *
 * ── Candidate role set ─────────────────────────────────────────────────────
 * The provider advertises the skills of {roles currently active in the
 * workspace} ∪ {the promoted default/primary role}, walking each role's own
 * `skills` first and then, recursively, its `subagents[].skills`
 * (`ResolvedSubAgent` nests arbitrarily). The active set is read through the
 * injected per-session {@link DshActiveRoleSnapshot} (the rolebox dsh
 * `ActiveRoleRef`, `role-switcher.ts:131`, satisfies it structurally). The
 * provider contract exposes no session id (`index.d.ts:88-93`), so the union
 * over every recorded session plus the default role is the honest
 * workspace-wide answer.
 *
 * ── Guards (one bad candidate poisons the WHOLE catalog) ───────────────────
 * `validateCandidate` (`dsh-skill/lib/index.js:454`) runs OUTSIDE the
 * provider-list try/catch (`:349-355`), so a single malformed candidate makes
 * every `list()` reject:
 *   1. name pre-filter — the grammar is `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
 *      (`index.js:17`, `:29-31`); rejected names are dropped with ONE warning
 *      each. rolebox role names like `emperor--chancellor` are NOT valid dsh
 *      skill names — only grammar-valid skills can be surfaced.
 *   2. dedupe by name, first-wins in deterministic order (role skills before
 *      subagent skills; roles in stable id order) — one provider must never
 *      return a duplicate name.
 *   3. skip skills whose `filePath` no longer exists.
 *   4. honor `options.signal`, settling promptly on abort.
 * A candidate with an empty `description` would also throw (`index.js:457`),
 * so an empty description falls back to the skill name — keeping a real skill
 * loadable rather than poisoning the catalog.
 *
 * The dsh surface is consumed STRUCTURALLY (duck typing). This module does
 * NOT import any platform SDK package — no dsh and no opencode SDK imports.
 *
 * @module
 */

import { dirname } from "node:path";
import { fileExists } from "../../../utils/fs.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import { loadSkillContent } from "../../../resolver/skill-resolver.ts";
import type { ResolvedRole, ResolvedSkill, ResolvedSubAgent } from "../../../types.ts";

const log = createSubLogger("dsh-skill-provider");

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * dsh skill-name grammar (`dsh-skill/lib/index.js:17`). A candidate whose
 * name fails this is rejected by `validateCandidate` (`:454`) and poisons the
 * whole catalog, so the provider pre-filters.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** dsh provider name registered on `ctx.skills` (echoed by every candidate). */
export const ROLEBOX_SKILL_PROVIDER = "rolebox";

/** Custom `source` bucket for rolebox contributions (`index.d.ts:24` accepts it). */
export const ROLEBOX_SKILL_SOURCE = "rolebox";

/**
 * Precedence rank for rolebox skills. dsh reserves 100 project-dsh /
 * 200 project-agents / 300 custom / 400 user-dsh / 500 user-agents / 600
 * bundled; 450 places rolebox above the custom bucket but below bundled
 * skills. Duplicate names are decided within one layer by this rank, lower
 * wins (`dsh-skill/lib/index.js:314`, `:518-520`).
 */
export const ROLEBOX_SKILL_RANK = 450;

// ── Structural dsh types (`dsh-skill`, SDK-free) ───────────────────────────

/** Structural dsh `SkillInvocationPolicy` (`index.d.ts:30-36`). */
export interface DshSkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean;
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean;
}

/** Structural dsh resource base, directory member (`index.d.ts:26-28`). */
export interface DshSkillResourceBaseDirectory {
  readonly kind: "directory";
  readonly path: string;
}

/** Structural dsh `SkillCandidate` (`index.d.ts:44-70`). */
export interface DshSkillCandidate {
  /** Kebab-case identifier used to address the skill. */
  readonly name: string;
  /** Short routing description (must be non-empty, `index.js:457`). */
  readonly description: string;
  /** Optional extra routing guidance. */
  readonly whenToUse?: string;
  /** Resolved model and user invocation controls. */
  readonly invocation: DshSkillInvocationPolicy;
  /** Discovery source bucket. */
  readonly source: string;
  /** Owning provider name — must equal the registered provider (`index.js:462`). */
  readonly provider: string;
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: DshSkillResourceBaseDirectory;
  /** Lower ranks win duplicate names (`index.js:314`). */
  readonly rank: number;
  /** Opaque provider-owned handle handed back to `get()`. */
  readonly locator: unknown;
  /** Absolute file path when the provider has one. */
  readonly path?: string;
  /** Optional provider-specific metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structural dsh `SkillDefinition` (`index.d.ts:72-83`). */
export interface DshSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: DshSkillInvocationPolicy;
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: DshSkillResourceBaseDirectory;
  /** Markdown instruction body read lazily by `get()`. */
  readonly content: string;
  /** Absolute file path when the skill came from disk. */
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structural dsh `SkillLookupOptions` (`index.d.ts:88-93`) — `{cwd?, signal?}`. */
export interface DshSkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined;
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined;
}

/** Structural dsh `SkillProviderControl` (`index.d.ts:190-195`). */
export interface DshSkillProviderControl {
  /** Aborts when the exact provider registration is disposed. */
  readonly signal: AbortSignal;
  /** Invalidate completed catalogs for the active registration. */
  readonly invalidate: () => void;
}

/** Structural dsh `SkillProvider` (`index.d.ts:168-188`). */
export interface DshSkillProviderLike {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string;
  /** List skill candidates for the current lookup context. */
  readonly list: (
    options: DshSkillLookupOptions,
  ) => Promise<readonly DshSkillCandidate[]>;
  /** Load a complete skill body for a previously listed candidate. */
  readonly get: (
    candidate: DshSkillCandidate,
    options: DshSkillLookupOptions,
  ) => Promise<DshSkillDefinition | undefined>;
}

/**
 * Structural subset of the dsh rolebox `ActiveRoleRef` (`role-switcher.ts:131`)
 * the provider reads to resolve the active role set. Only `snapshot()` is
 * consumed; the concrete `ActiveRoleRef` satisfies this shape.
 */
export interface DshActiveRoleSnapshot {
  /** Snapshot the session→entry map; each entry carries the active role id. */
  snapshot(): ReadonlyMap<string, { readonly roleId: string | null }>;
}

/** Dependencies for {@link DshSkillProvider}. */
export interface DshSkillProviderDeps {
  /**
   * Every fully-resolved role in the workspace, or a provider for them. The
   * provider filters this set down to the active ∪ default roles.
   */
  roles:
    | readonly ResolvedRole[]
    | (() => readonly ResolvedRole[] | Promise<readonly ResolvedRole[]>);
  /**
   * Per-session active-role holder (structural {@link DshActiveRoleSnapshot}).
   * Omit to advertise only the default/primary role.
   */
  activeRole?: DshActiveRoleSnapshot;
  /** Role id promoted to primary; its skills are always candidates. */
  defaultRoleId?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Narrow an opaque locator back to the `ResolvedSkill` handed out by `list()`. */
function asResolvedSkill(locator: unknown): ResolvedSkill | undefined {
  if (locator === null || typeof locator !== "object") return undefined;
  const candidate = locator as { name?: unknown; filePath?: unknown; description?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.filePath !== "string") {
    return undefined;
  }
  return locator as ResolvedSkill;
}

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * rolebox's dsh `SkillProvider`.
 *
 * Construct through {@link createDshSkillProviderFactory}: the factory form
 * is exactly what `ctx.skills.registerProvider(create)` requires, and it
 * captures the registration `control` so {@link invalidate} can request a
 * catalog refresh after a role switch (subtask 7).
 */
export class DshSkillProvider implements DshSkillProviderLike {
  readonly name = ROLEBOX_SKILL_PROVIDER;

  private readonly deps: DshSkillProviderDeps;
  private control: DshSkillProviderControl | undefined;

  /**
   * @param deps    - Candidate role source + active/default role resolution.
   * @param control - The registration control borrowed from the factory;
   *                  held for {@link invalidate}. Omit in isolated tests.
   */
  constructor(deps: DshSkillProviderDeps, control?: DshSkillProviderControl) {
    this.deps = deps;
    this.control = control;
  }

  /**
   * Ask the registry to refresh cached catalogs for this registration — the
   * single refresh seam the dsh plugin invokes on an active-role change
   * (through the role switcher) or a role re-resolution.
   *
   * Three guarantees:
   *   1. **No control** (the constructor was called without one, e.g. an
   *      isolated unit test) → a silent no-op.
   *   2. **Disposed registration** → a no-op. The control's abort signal fires
   *      when the exact provider registration is torn down
   *      (`dsh-skill/lib/index.js:170`), so a stale provider from a superseded
   *      role resolution never pokes a dead registry.
   *   3. **A throwing `invalidate`** is contained by try/catch + `log.debug` —
   *      a catalog refresh must never break the role switch that requested it.
   */
  invalidate(): void {
    const control = this.control;
    if (!control) return;
    if (control.signal?.aborted) return;
    try {
      control.invalidate();
    } catch (err) {
      log.debug("skill catalog invalidation failed", { error: formatError(err) });
    }
  }

  /**
   * List the candidate role set's skills as dsh candidates.
   *
   * Guards (see the module docstring): grammar pre-filter with one warning per
   * rejected name, name dedupe first-wins in deterministic order, vanished
   * files skipped, and prompt abort handling. Never throws — a role-provider
   * failure degrades to an empty catalog rather than rejecting `list()`.
   */
  async list(options: DshSkillLookupOptions): Promise<readonly DshSkillCandidate[]> {
    const signal = options?.signal;
    if (signal?.aborted) return [];

    let roles: ResolvedRole[];
    try {
      roles = await this.resolveCandidateRoles();
    } catch (err) {
      log.warn("role lookup failed — advertising no skills", formatError(err));
      return [];
    }
    if (signal?.aborted) return [];

    const candidates: DshSkillCandidate[] = [];
    const seen = new Set<string>();
    const warned = new Set<string>();
    for (const role of roles) {
      if (signal?.aborted) break;
      await this.collectSkills(role.skills, candidates, seen, warned, signal);
      await this.collectSubAgentSkills(role.subagents, candidates, seen, warned, signal);
    }
    return candidates;
  }

  /**
   * Load a candidate's body lazily via `loadSkillContent`.
   *
   * Returns `undefined` (never throws) when the locator is not a resolved
   * skill or the SKILL.md vanished after listing.
   */
  async get(
    candidate: DshSkillCandidate,
    options: DshSkillLookupOptions,
  ): Promise<DshSkillDefinition | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return undefined;

    const skill = asResolvedSkill(candidate?.locator);
    if (!skill) return undefined;

    let content: string;
    try {
      content = await loadSkillContent(skill);
    } catch (err) {
      log.debug("skill body no longer loadable", {
        name: skill.name,
        error: formatError(err),
      });
      return undefined;
    }
    if (signal?.aborted) return undefined;

    const definition: DshSkillDefinition = {
      name: candidate.name,
      description: candidate.description || candidate.name,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      content,
      path: skill.filePath,
      ...(candidate.resourceBase !== undefined
        ? { resourceBase: candidate.resourceBase }
        : {}),
    };
    return definition;
  }

  // ── Candidate role resolution ────────────────────────────────────────────

  /**
   * Resolve the candidate role set: active roles (union over every recorded
   * session) ∪ the default/primary role, in stable id order.
   */
  private async resolveCandidateRoles(): Promise<ResolvedRole[]> {
    const all = typeof this.deps.roles === "function"
      ? await this.deps.roles()
      : this.deps.roles;

    const ids = new Set<string>();
    const activeRole = this.deps.activeRole;
    if (activeRole) {
      try {
        for (const entry of activeRole.snapshot().values()) {
          if (entry && typeof entry.roleId === "string") ids.add(entry.roleId);
        }
      } catch (err) {
        log.debug("active-role snapshot failed; using default role only", formatError(err));
      }
    }
    if (this.deps.defaultRoleId) ids.add(this.deps.defaultRoleId);

    return all
      .filter((role) => ids.has(role.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Walk a subagent subtree depth-first (pre-order): each subagent's own
   * skills, then its nested subagents. `ResolvedSubAgent` nests arbitrarily.
   */
  private async collectSubAgentSkills(
    subagents: readonly ResolvedSubAgent[],
    out: DshSkillCandidate[],
    seen: Set<string>,
    warned: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const subagent of subagents) {
      if (signal?.aborted) return;
      await this.collectSkills(subagent.skills, out, seen, warned, signal);
      await this.collectSubAgentSkills(subagent.subagents, out, seen, warned, signal);
    }
  }

  /**
   * Emit one candidate per grammar-valid, existing, not-yet-seen skill.
   *
   * Order matters for guard (ii): the first occurrence in walk order claims
   * the name, so a later duplicate is dropped even if its file is missing.
   */
  private async collectSkills(
    skills: readonly ResolvedSkill[],
    out: DshSkillCandidate[],
    seen: Set<string>,
    warned: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const skill of skills) {
      if (signal?.aborted) return;

      const name = skill.name;
      if (!SKILL_NAME_RE.test(name)) {
        if (!warned.has(name)) {
          warned.add(name);
          log.warn("skill name rejected by dsh grammar — not advertised", {
            name,
            filePath: skill.filePath,
          });
        }
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);

      try {
        if (!(await fileExists(skill.filePath))) {
          log.debug("skill file vanished — not advertised", { name, filePath: skill.filePath });
          continue;
        }
      } catch (err) {
        log.debug("skill file unprobeable — not advertised", {
          name,
          filePath: skill.filePath,
          error: formatError(err),
        });
        continue;
      }
      if (signal?.aborted) return;

      out.push({
        name,
        // dsh rejects an empty description (`index.js:457`); fall back to the
        // name so a real skill stays loadable instead of poisoning the catalog.
        description: skill.description || name,
        invocation: { modelInvocable: true, userInvocable: true },
        source: ROLEBOX_SKILL_SOURCE,
        provider: ROLEBOX_SKILL_PROVIDER,
        resourceBase: { kind: "directory", path: dirname(skill.filePath) },
        rank: ROLEBOX_SKILL_RANK,
        locator: skill,
        path: skill.filePath,
      });
    }
  }
}

/**
 * Build the `(control) => SkillProvider` factory `ctx.skills.registerProvider`
 * demands.
 *
 * @param deps - Candidate role source + active/default role resolution.
 * @returns A factory that constructs one {@link DshSkillProvider} per
 *          registration and captures its control for {@link DshSkillProvider.invalidate}.
 */
export function createDshSkillProviderFactory(
  deps: DshSkillProviderDeps,
): (control: DshSkillProviderControl) => DshSkillProvider {
  return (control) => new DshSkillProvider(deps, control);
}
