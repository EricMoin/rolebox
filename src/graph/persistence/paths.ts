import { join } from "node:path";

export function engineStateDir(directory: string): string {
  return join(directory, ".rolebox", "state");
}

/** Retired files are inventoried and refused; they are never decoded or rewritten. */
export function engineStatePath(directory: string, graphId: string): string {
  return join(engineStateDir(directory), `engine-${graphId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
}
