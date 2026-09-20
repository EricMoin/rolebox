# Skills

> Part of the rolebox documentation. See [README](../README.md) for overview.

Skills are on-demand knowledge modules the agent loads via the `skill` tool when needed. Unlike functions (which are always-on once activated), skills are pulled in contextually.

```markdown
---
name: review-checklist
description: Comprehensive code review checklist
---

When reviewing code, check:
- Error handling completeness
- Input validation
- ...
```

## Resolution order

1. `{roleDir}/skills/{name}/SKILL.md` (role-local, directory)
2. `{roleDir}/skills/{name}.md` (role-local, single file)
3. `{globalSkillsDir}/{name}/SKILL.md` (global, directory)
4. `{globalSkillsDir}/{name}.md` (global, single file)

*From `src/resolver/skill-resolver.ts` — the resolution priority comment and `buildCandidates`, which encodes the same four-step order:*

```ts
// Resolution priority:
//  1. {roleDir}/skills/{name}/SKILL.md  (role-local directory)
//  2. {roleDir}/skills/{name}.md        (role-local single-file)
//  3. {globalSkillsDir}/{name}/SKILL.md (global skills dir, harness-resolved)
//  4. {globalSkillsDir}/{name}.md       (global skills dir, harness-resolved)
function buildCandidates(
  name: string,
  roleDir: string,
  globalSkillsDir: string,
): Candidate[] {
  const roleSkillsDir = join(roleDir, "skills");
  return [
    { scope: SkillScope.Rolebox, pattern: skillDirPath(roleSkillsDir, name) },
    { scope: SkillScope.Rolebox, pattern: skillFilePath(roleSkillsDir, name) },
    { scope: SkillScope.Global, pattern: skillDirPath(globalSkillsDir, name) },
    { scope: SkillScope.Global, pattern: skillFilePath(globalSkillsDir, name) },
  ];
}
```

The global directory follows the active harness's config dir — see [Supported harnesses](../README.md#supported-harnesses) for the per-harness paths.

## Skill vs Function

| | Skill | Function |
|---|---|---|
| Activation | Agent decides via `skill` tool | User activates with `\|name\|` syntax |
| Lifetime | Single use per invocation | Persists for the session |
| Purpose | Reference knowledge | Behavior modification |
| Injection | On-demand into context | Always in system prompt while active |

## Platform parity

The same role skills are surfaced on all three host platforms, each through its
native discovery mechanism:

| Platform | Mechanism | Where |
|---|---|---|
| opencode | Symlink sync into the global skills dir (`~/.config/opencode/skills/`), discovered by oh-my-openagent | `syncSkillSymlinks` (`src/sync/skill-symlinks.ts`), invoked from `src/entries/opencode.ts` |
| Pi | `registrar.registerSkillPath(agentId, dirname(skill.filePath))`, reported through `resources_discover` | `src/entries/pi.ts` |
| dsh | A lazy `ctx.skills` `SkillProvider` registered on dsh's skill registry | `src/platform/adapters/dsh/skill-provider.ts`; registered at `src/entries/dsh.ts` |

*From `src/sync/skill-symlinks.ts` — `syncSkillSymlinks` and its oh-my-openagent discovery contract:*

```ts
/**
 * Sync rolebox skills into ~/.config/opencode/skills/ for oh-my-openagent discovery.
 *
 * oh-my-openagent's loadSkillsFromDir treats symlinks as directories:
 * it resolves them and looks for SKILL.md inside. So:
 * - Directory skills (with SKILL.md): create symlink to the directory
 * - Single-file skills (.md): create a wrapper directory with SKILL.md symlink inside
 */
export function syncSkillSymlinks(resolvedRoles: ResolvedRole[], globalSkillsDir: string): void {
```

*From `src/entries/pi.ts` — `registerAgentSkillPaths` calling `registrar.registerSkillPath`:*

```ts
    const registerAgentSkillPaths = (
      agentId: string,
      skills: ResolvedSkill[],
    ): void => {
      for (const skill of skills) {
        registrar.registerSkillPath(agentId, dirname(skill.filePath));
        skillPathRegistrations++;
      }
    };
```

*From `src/platform/adapters/dsh/skill-provider.ts` — the structural `SkillLookupOptions` (`{ cwd?, signal? }`) a dsh provider's `list()` receives:*

```ts
/** Structural dsh `SkillLookupOptions` (`index.d.ts:88-93`) — `{cwd?, signal?}`. */
export interface DshSkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined;
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined;
}
```

The shared port is `ISkillSurface` (`src/platform/ports/skill-surface.ts`);
each adapter translates a `CanonicalSkillEntry` into its host registration.

*From `src/platform/ports/skill-surface.ts` — `ISkillSurface`, the shared port each adapter implements:*

```ts
export interface ISkillSurface {
  /**
   * Publish (or update) a batch of skill entries to the host.
   *
   * Implementations are idempotent — re-publishing an unchanged entry
   * set is a no-op.
   *
   * Returns a disposer that removes the entries published by this call.
   * Calling the disposer more than once is a no-op.
   */
  publish(entries: CanonicalSkillEntry[]): () => void;
}
```

### dsh: per-workspace, not per-session

The dsh provider registry exposes no session or agent to a provider: a
`SkillProvider.list()` receives only `SkillLookupOptions` — `{ cwd?, signal? }`
(`@deepseek-ai/dsh-skill` `lib/types/index.d.ts`). rolebox's active-role
selection is per-session — `ActiveRoleStore` is keyed by `sessionId`
(`src/platform/adapters/dsh/active-role-store.ts`) — so the dsh provider
cannot scope its catalog to the calling session. It advertises the
workspace-wide union of the skills of every role active in any recorded session,
plus the promoted default role (`src/platform/adapters/dsh/skill-provider.ts`).

*From `src/platform/adapters/dsh/active-role-store.ts` — `ActiveRoleEntry`, keyed by `sessionId`:*

```ts
/**
 * One persisted active-role selection, keyed by `sessionId` in the in-memory
 * map and stored inline in the file's `sessions` array.
 */
export interface ActiveRoleEntry {
  /** The dsh session id this selection applies to. */
  sessionId: string;
  /** Active role id, or `null` for an explicit clear back to the base agent. */
  roleId: string | null;
  /** Epoch ms of the last write for this session (used by {@link ActiveRoleStore.prune}). */
  updatedAt: number;
}
```

Per-session scoping is unreachable through rolebox's registration: the registry
files a registration into the layer of its CALLING context's scope, and only a
context scoped to the dsh agent object (an agent preset's standing composition)
lands in that agent's layer where a read from that scope would see it
(`lib/types/index.d.ts`). rolebox registers once from the plugin's
global context (`src/entries/dsh.ts`), so its provider serves the workspace
layer. Closing the gap would require registering from a context scoped to the
dsh agent object — a capability only an agent preset's standing composition
provides.

See [dsh plugin contract §4.6](dsh-plugin-contract.md) for the verified rc.6
signatures, name grammar, and rank rationale.
