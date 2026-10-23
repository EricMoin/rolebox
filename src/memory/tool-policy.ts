export const MEMORY_TOOL_NAMES = ["memory_recall", "memory_read", "memory_list", "memory_write", "memory_update"] as const;

export function memoryToolEnabled(name: string, tools?: Record<string, boolean>): boolean {
  if (!tools) return true;
  if (tools[name] !== undefined) return tools[name];
  const match = Object.keys(tools)
    .filter(pattern => pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined || tools[match] !== false;
}
