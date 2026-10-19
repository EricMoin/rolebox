export interface WorkerToolPresentation {
  readonly mode: "native" | "discover" | "code";
  readonly preload?: readonly string[];
}

/** Presentation changes visibility, never the node's tool grant. */
export function normalizeWorkerToolPresentation(value: unknown): WorkerToolPresentation | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("toolPresentation must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "mode" && key !== "preload") throw new TypeError(`Unknown toolPresentation field: ${key}`);
  }
  const mode = record.mode;
  if (mode !== "native" && mode !== "discover" && mode !== "code") {
    throw new TypeError("toolPresentation.mode must be native, discover or code");
  }
  if (record.preload === undefined) return Object.freeze({ mode });
  if (!Array.isArray(record.preload) || record.preload.length > 32) {
    throw new TypeError("toolPresentation.preload must be an array of at most 32 exact host tool names");
  }
  const names = new Set<string>();
  for (const value of record.preload as readonly unknown[]) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("*") || value.trim().startsWith("graph_")) {
      throw new TypeError("toolPresentation.preload must contain exact, non-empty host tool names");
    }
    names.add(value.trim());
  }
  return Object.freeze({ mode, preload: Object.freeze([...names].sort()) });
}

export function workerPresentationTools(presentation: WorkerToolPresentation | undefined): readonly ("graph_worker_tools" | "graph_worker_code")[] {
  if (presentation?.mode === "discover") return ["graph_worker_tools"];
  if (presentation?.mode === "code") return ["graph_worker_tools", "graph_worker_code"];
  return [];
}

export function validateWorkerToolPreload(presentation: WorkerToolPresentation | undefined, tools: readonly string[] | undefined): void {
  for (const name of presentation?.preload ?? []) {
    const granted = tools?.some(entry => entry === name ||
      (entry.endsWith("*") && entry.length > 1 && name.startsWith(entry.slice(0, -1))));
    if (!granted) throw new TypeError(`Preloaded tool ${JSON.stringify(name)} is not in the node's tools grant`);
  }
}
