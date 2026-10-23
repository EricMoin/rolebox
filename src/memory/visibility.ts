/** Undefined is an administrative query; an empty role sees only workspace entries. */
export function memoryVisibility(roleId: string | undefined, prefix = ""): {
  sql: string;
  params: string[];
} {
  if (roleId === undefined) return { sql: "1 = 1", params: [] };
  if (roleId === "") return { sql: `${prefix}scope = 'workspace'`, params: [] };
  return {
    sql: `(${prefix}scope = 'workspace' OR (${prefix}scope = 'role' AND ${prefix}role_id = ?))`,
    params: [roleId],
  };
}
