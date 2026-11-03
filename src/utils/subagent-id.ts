/** The canonical child-name spelling used in hierarchical role IDs. */
export function subagentIdSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}
