import type { ResolvedFunction } from "../types.ts";
import { functionRuntime } from "./runtime-state.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { extractResultBlockNamed } from "./fence.ts";

export function runToolObserve(opts: {
  sessionID: string;
  tool: string;
  activeFns: ResolvedFunction[];
  artifacts: ArtifactStore;
  lastAssistantText: string | null;
}): string[] {
  const injects: string[] = [];
  for (const fn of opts.activeFns) {
    const st = functionRuntime.get(opts.sessionID, fn.name);
    if (!st) continue;
    if (!st.toolsObserved.includes(opts.tool)) st.toolsObserved.push(opts.tool);
    // requires_evidence auto-mark
    for (const tag of fn.requires_evidence ?? []) {
      if (tag === opts.tool) st.evidenceObserved[tag] = true;
    }
    for (const spec of fn.observe ?? []) {
      if (spec.on !== "tool_after") continue;
      if (spec.tool && spec.tool !== opts.tool) continue;
      if (spec.set_evidence) st.evidenceObserved[spec.set_evidence] = true;
      if (spec.capture_artifact && opts.lastAssistantText) {
        const block = extractResultBlockNamed(opts.lastAssistantText, spec.capture_artifact);
        if (block !== null) opts.artifacts.write(opts.sessionID, spec.capture_artifact, block);
      }
      if (spec.sync_todos && opts.tool === "todowrite" && opts.lastAssistantText) {
        st.kv["__todos"] = opts.lastAssistantText;
      }
      if (spec.inject) injects.push(spec.inject);
    }
  }
  functionRuntime.markDirty();
  return injects;
}
