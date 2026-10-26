import { z } from "zod";
import { declaredToolsAllow, workerTaskToolAllowed } from "../../../graph/host/tool-binding.ts";
import type { WorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";
import { normalizeWorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";
import type { CanonicalToolDef } from "../../types.ts";
import type { WorkerToolDescriptor } from "../../worker-tools/types.ts";

export interface PiWorkerToolConfig {
  baseline: readonly string[];
  grants?: readonly string[];
  inheritedTools?: readonly string[];
  presentation?: WorkerToolPresentation;
  proxies: readonly WorkerToolDescriptor[];
}

export function piWorkerToolAllowed(name: string, config: PiWorkerToolConfig): boolean {
  if (name === "graph_submit_outcome") return true;
  if (name === "bash" && config.baseline.includes(name)) return true;
  return workerTaskToolAllowed(name, config.grants, config.inheritedTools);
}

export function piWorkerToolConfig(
  baseline: readonly string[], grants: readonly string[] | undefined,
  presentation: WorkerToolPresentation | undefined,
  definitions: Readonly<Record<string, CanonicalToolDef>>,
  inheritedTools?: readonly string[],
): PiWorkerToolConfig {
  if (presentation?.mode === "code") throw new Error("Pi code presentation is unsupported: the extension API cannot invoke tools through the complete host tool_call hooks. Use native or discover presentation.");
  const config: PiWorkerToolConfig = {
    baseline: presentation === undefined ? baseline : ["bash", "graph_submit_outcome"],
    grants, inheritedTools, presentation, proxies: [],
  };
  return { ...config, proxies: Object.entries(definitions)
    .filter(([name]) => name !== "graph_submit_outcome" && piWorkerToolAllowed(name, config))
    .map(([name, tool]) => ({ name, description: tool.description,
      inputSchema: z.toJSONSchema(z.object(tool.args)), source: "rolebox" })) };
}

export function parsePiWorkerToolConfig(raw: string): PiWorkerToolConfig {
  const config = z.object({ baseline: z.array(z.string()), grants: z.array(z.string()).optional(), inheritedTools: z.array(z.string()).optional(),
    presentation: z.unknown().optional(), proxies: z.array(z.object({ name: z.string(),
      description: z.string(), inputSchema: z.unknown(), source: z.string().optional() })) }).strict().parse(JSON.parse(raw));
  return { ...config, presentation: normalizeWorkerToolPresentation(config.presentation) };
}

export function validatePiWorkerTools(config: PiWorkerToolConfig, tools: readonly { name: string }[]): void {
  if (config.presentation?.mode === "code") throw new Error("Pi code presentation is unsupported: the extension API cannot invoke tools through the complete host tool_call hooks. Use native or discover presentation.");
  for (const grant of config.grants ?? []) {
    if (!tools.some(tool => declaredToolsAllow(tool.name, [grant]) && piWorkerToolAllowed(tool.name, config))) {
      throw new Error(`Pi worker tool grant ${JSON.stringify(grant)} matches no loaded tool`);
    }
  }
  for (const name of config.presentation?.preload ?? []) {
    if (!tools.some(tool => tool.name === name) || !piWorkerToolAllowed(name, config)) {
      throw new Error(`Pi worker preload ${JSON.stringify(name)} is unavailable or unauthorized`);
    }
  }
}
