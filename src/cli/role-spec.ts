/**
 * Role specifier parsing/formatting.
 *
 * A specifier is `[registry:]<roleId>[@version]`, e.g.
 *   "software-architect"          → roleId="software-architect"
 *   "software-architect@1.0.0"    → roleId="software-architect", version="1.0.0"
 *   "my-registry:custom-role"     → registry="my-registry", roleId="custom-role"
 *   "my-registry:role@2.0.0"      → registry="my-registry", roleId="role", version="2.0.0"
 *
 * It lives in its own module so every command parses and prints specifiers the
 * same way; `commands/install.ts` re-exports `parseRoleSpec` for callers (and
 * tests) that historically imported it from there.
 */

export interface RoleSpec {
  roleId: string;
  registry?: string;
  version?: string;
}

export function parseRoleSpec(spec: string): RoleSpec {
  let remaining = spec;
  let registry: string | undefined;
  let version: string | undefined;

  const colonIdx = remaining.indexOf(":");
  if (colonIdx !== -1) {
    registry = remaining.slice(0, colonIdx);
    remaining = remaining.slice(colonIdx + 1);
  }

  const atIdx = remaining.lastIndexOf("@");
  if (atIdx !== -1) {
    version = remaining.slice(atIdx + 1);
    remaining = remaining.slice(0, atIdx);
  }

  return { roleId: remaining, registry, version };
}

/** Render a specifier, omitting whichever parts are absent. */
export function formatRoleSpec(spec: RoleSpec): string {
  const registry = spec.registry ? `${spec.registry}:` : "";
  const version = spec.version ? `@${spec.version}` : "";
  return `${registry}${spec.roleId}${version}`;
}
