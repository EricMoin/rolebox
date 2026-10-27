export interface WorkerToolPresentation {
  readonly mode: "native" | "discover" | "code";
  readonly preload?: readonly string[];
}

export function isWorkerTaskTool(name: string): boolean {
  const canonical = name.startsWith("rb_") ? name.slice(3) : name;
  return !canonical.startsWith("graph_") && !canonical.startsWith("team_") &&
    !canonical.startsWith("dispatch_") && !canonical.startsWith("loop_") &&
    !["dispatch", "task", "task_retry", "session_fork"].includes(canonical);
}

export function inheritedWorkerTaskTools(names: readonly string[], policy?: Readonly<Record<string, boolean>>): readonly string[] {
  return names.filter(name => {
    if (!isWorkerTaskTool(name)) return false;
    const canonical = name.startsWith("rb_") ? name.slice(3) : name;
    const exact = policy?.[canonical];
    if (exact !== undefined) return exact;
    const pattern = Object.keys(policy ?? {}).filter(key => key.endsWith("*") && canonical.startsWith(key.slice(0, -1)))
      .sort((a, b) => b.length - a.length)[0];
    return pattern === undefined || policy?.[pattern] !== false;
  });
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

export function validateWorkerToolPreload(presentation: WorkerToolPresentation | undefined, _tools: readonly string[] | undefined): void {
  for (const name of presentation?.preload ?? []) {
    if (!isWorkerTaskTool(name)) throw new TypeError(`Preloaded tool ${JSON.stringify(name)} is not a task tool`);
  }
}
