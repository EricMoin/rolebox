/**
 * opencode v2 skill registration — surfaces rolebox's role skills to the v2
 * skill registry through `ctx.skill.transform(editor => editor.add(info))`.
 *
 * `SkillEditor` is `{ list, get, add, update, remove }`
 * (node_modules/@opencode/plugin/dist/promise/skill.d.ts:5-11) and `Skill.Info`
 * is `{ id, name, description?, autoinvoke?, path, content }`
 * (…/schema/dist/skill.d.ts:21-28) — an EAGER body: v2 wants the markdown in
 * the registration, not a path it reads later.
 *
 * The skills come from what rolebox already resolves (`ResolvedSkill`,
 * src/types.core.ts:157-169: name, description, scope, filePath, references),
 * except that the body is not part of a resolved skill, so it is read here
 * through `loadSkillContent` (src/resolver/skill-resolver.ts:140) — bounded,
 * and skipped with a debug log when unreadable.
 *
 * Two deliberate restrictions, both mirroring how rolebox surfaces skills today
 * (src/sync/skill-symlinks.ts:56-70):
 *  - only `SkillScope.Rolebox` skills are registered; a `opencode_skills`
 *    (global) entry is the host's own, harness-resolved skill, and registering
 *    a second copy would shadow it;
 *  - ids/names are exactly what the skill resolver produced (kebab-case, no
 *    `rolebox--` prefix and no role prefix — the prefix exists only to keep the
 *    on-disk global skills directory collision-free, and the v2 registry keys
 *    skills by id).
 * A duplicate id is registered once: the first occurrence whose body loads wins.
 */

import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import type { ResolvedRole, ResolvedSkill, ResolvedSubAgent } from "../../../types.ts";
import { SkillScope } from "../../../constants.ts";
import { loadSkillContent } from "../../../resolver/skill-resolver.ts";
import { createSubLogger, formatError } from "../../../logger.ts";

const log = createSubLogger("opencode2-skills");

/**
 * Upper bound on a registered skill body. v2 wants the content eagerly, and a
 * skill directory is user-controlled, so an oversized SKILL.md must not pull an
 * unbounded string into the host registry. The tail is dropped with a debug log.
 */
export const MAX_OPENCODE2_SKILL_CONTENT_CHARS = 64 * 1024;

// ── Host surface (structural view of ctx.skill / SkillEditor) ──────────────

/**
 * `Skill.Info` (…/schema/dist/skill.d.ts:21-28) — the eager registry entry.
 *
 * `autoinvoke` is part of the host shape but never set here: rolebox resolves
 * no such flag (`ResolvedSkill`, src/types.core.ts:157-169), so the host
 * default decides.
 */
export interface Opencode2SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
}

/** `SkillEditor` projected onto what registration uses. */
export interface Opencode2SkillEditor {
  add(skill: Opencode2SkillInfo): void;
}

/** `SkillDomain` projected onto what registration uses. */
export interface Opencode2SkillDomain {
  transform(
    callback: (editor: Opencode2SkillEditor) => void,
  ): Promise<{ dispose: () => Promise<void> }>;
}

// ── Compile-time guards ────────────────────────────────────────────────────

type _IsTrue<T extends true> = T;

/** The host's `Skill.Info`, taken from the editor's own `add`. */
type Opencode2HostSkillInfo = Parameters<
  Parameters<Parameters<Opencode2Plugin.Context["skill"]["transform"]>[0]>[0]["add"]
>[0];

/** Fields this module fills must exist on the host's `Skill.Info`. */
type _SkillFieldsExist = _IsTrue<
  keyof Opencode2SkillInfo extends keyof Opencode2HostSkillInfo ? true : false
>;

/**
 * The entry's non-branded fields must match the host's `Skill.Info` exactly.
 * `id`, `name` and `path` are deliberately excluded: the host schema brands
 * them (`Skill.ID`, `Skill.Name`, `AbsolutePath`,
 * …/schema/dist/skill.d.ts:3-6) and a brand is not constructible from a plain
 * string (`Type 'string' is not assignable to type 'string & Brand<"Skill.ID">'`),
 * while the resolved skill carries plain strings (`ResolvedSkill.filePath`,
 * src/types.core.ts:167). The brand is erased at runtime and `Skill.Info`'s
 * brand only refines a string, so the registration writes plain values through
 * this module's own view — the same brand erasure the agent adapter documents.
 */
type _SkillPlainFieldsMatch = _IsTrue<
  Pick<Opencode2SkillInfo, "description" | "autoinvoke" | "content"> extends Pick<
    Opencode2HostSkillInfo,
    "description" | "autoinvoke" | "content"
  >
    ? true
    : false
>;

/** The real editor satisfies the `add`-only view used here. */
type _SkillEditorSatisfiesView = _IsTrue<
  Parameters<Parameters<Opencode2Plugin.Context["skill"]["transform"]>[0]>[0] extends Opencode2SkillEditor
    ? true
    : false
>;

/** The real `ctx.skill` can be handed to {@link registerOpencode2Skills} unchanged. */
type _SkillDomainSatisfiesView = _IsTrue<
  Opencode2Plugin.Context["skill"] extends Opencode2SkillDomain ? true : false
>;

// ── Collection ─────────────────────────────────────────────────────────────

export interface Opencode2SkillOptions {
  /**
   * Body reader. Defaults to `loadSkillContent` (src/resolver/skill-resolver.ts:140);
   * injected by tests so no case touches the filesystem.
   */
  loadContent?: (skill: ResolvedSkill) => Promise<string>;
}

function collectSubAgentSkills(
  subagents: readonly ResolvedSubAgent[],
  skills: ResolvedSkill[],
): void {
  for (const sub of subagents) {
    skills.push(...sub.skills);
    collectSubAgentSkills(sub.subagents, skills);
  }
}

/**
 * Resolve the v2 skill registrations for a role set: role-local skills plus
 * every (recursively nested) sub-agent skill, deduplicated by the resolver's
 * own skill name — the first occurrence that actually loads wins.
 *
 * Never throws: a skill whose body cannot be read is skipped with a debug log.
 */
export async function collectOpencode2Skills(
  roles: readonly ResolvedRole[],
  options?: Opencode2SkillOptions,
): Promise<Opencode2SkillInfo[]> {
  const loadContent = options?.loadContent ?? loadSkillContent;

  const candidates: ResolvedSkill[] = [];
  for (const role of roles) {
    candidates.push(...role.skills);
    collectSubAgentSkills(role.subagents, candidates);
  }

  const seen = new Set<string>();
  const skills: Opencode2SkillInfo[] = [];
  for (const skill of candidates) {
    // Global skills are the harness's own resolved entries (see the module
    // comment); only role-local skills are rolebox's to register.
    if (skill.scope !== SkillScope.Rolebox) continue;
    if (seen.has(skill.name)) continue;

    let content: string;
    try {
      content = await loadContent(skill);
    } catch (err) {
      log.debug("skill body unreadable — not registered", {
        name: skill.name,
        path: skill.filePath,
        error: formatError(err),
      });
      continue;
    }
    if (content.length > MAX_OPENCODE2_SKILL_CONTENT_CHARS) {
      log.debug("skill body truncated", {
        name: skill.name,
        path: skill.filePath,
        limit: MAX_OPENCODE2_SKILL_CONTENT_CHARS,
      });
      content = content.slice(0, MAX_OPENCODE2_SKILL_CONTENT_CHARS);
    }
    // Marked seen only once the body loaded: an unreadable first occurrence
    // must not shadow a readable duplicate of the same skill id.
    seen.add(skill.name);
    skills.push({
      id: skill.name,
      name: skill.name,
      ...(skill.description !== "" ? { description: skill.description } : {}),
      path: skill.filePath,
      content,
    });
  }
  return skills;
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register collected skills through `editor.add` — the v2 skill editor's
 * registration point (…/promise/skill.d.ts:8). Registration is one-shot: the
 * editor is only valid inside the transform (…/promise/registration.d.ts:12).
 */
export function applyOpencode2Skills(
  editor: Opencode2SkillEditor,
  skills: readonly Opencode2SkillInfo[],
): void {
  for (const skill of skills) {
    editor.add(skill);
  }
}

/**
 * Register the role skills inside a v2 skill transform. The returned
 * registration is owned by the plugin scope and disposed with it
 * (…/promise/registration.d.ts:1-3).
 */
export async function registerOpencode2Skills(
  domain: Opencode2SkillDomain,
  roles: readonly ResolvedRole[],
  options?: Opencode2SkillOptions,
): Promise<{ dispose: () => Promise<void> }> {
  const skills = await collectOpencode2Skills(roles, options);
  return domain.transform((editor) => {
    applyOpencode2Skills(editor, skills);
  });
}
