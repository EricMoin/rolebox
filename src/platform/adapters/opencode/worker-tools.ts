import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../../graph/outcome/dispatch-effects.ts";
import { declaredToolsAllow } from "../../../graph/host/tool-binding.ts";
import { workerPresentationTools } from "../../../graph/domain/worker-tools.ts";
import type { CanonicalToolDef } from "../../types.ts";
import { createWorkerCapabilityTools, createWorkerToolSession, type WorkerToolDescriptor } from "../../worker-tools/index.ts";

const BASELINE = ["bash", "graph_submit_outcome"];
const forbidden = (name: string) => (name.startsWith("graph_") && name !== "graph_submit_outcome") ||
  name.startsWith("dispatch_") || name.startsWith("loop_") || name.startsWith("team_") || name === "task_retry";

export interface OpencodeWorkerToolOptions {
  host(): OutcomeHost | undefined;
  catalog(): Promise<readonly WorkerToolDescriptor[]>;
  /** True when the host's context hook can activate tools between model turns. */
  nativeActivation: boolean;
  supportsPresentation?: boolean;
  contextCatalogOnly?: boolean;
  ready?(): boolean;
}

export class OpencodeWorkerTools {
  readonly #options: OpencodeWorkerToolOptions;
  readonly #bound = new Map<string, Pick<OutcomeDispatchRequest, "declaredTools" | "toolPresentation">>();
  readonly #active = new Map<string, Set<string>>();
  readonly #catalogs = new Map<string, readonly WorkerToolDescriptor[]>();

  constructor(options: OpencodeWorkerToolOptions) { this.#options = options; }


  bind(sessionID: string, request: OutcomeDispatchRequest): void {
    this.#bound.set(sessionID, { declaredTools: request.declaredTools, toolPresentation: request.toolPresentation });
    this.#active.set(sessionID, new Set(request.toolPresentation?.preload ?? []));
  }

  #request(sessionID: string) {
    const bound = this.#bound.get(sessionID);
    if (bound) return bound;
    const host = this.#options.host();
    const principal = host?.workerPrincipalOf(sessionID);
    return principal ? { declaredTools: host?.workerDeclaredToolsOf(principal),
      toolPresentation: host?.workerToolPresentationOf(principal) } : undefined;
  }

  async #catalog(): Promise<readonly WorkerToolDescriptor[]> {
    return this.#options.catalog();
  }

  async prepare(request: OutcomeDispatchRequest): Promise<void> {
    if (this.#options.supportsPresentation === false) {
      if (request.toolPresentation !== undefined) throw new Error("OpenCode v1 tool presentation is unsupported: the plugin API cannot filter the complete custom/MCP tool catalog independently of host permissions. Keep the default native presentation.");
      return;
    }
    if (request.toolPresentation === undefined && request.declaredTools === undefined) return undefined;
    if (this.#options.ready?.() === false) throw new Error("OpenCode worker tool enforcement hooks are unavailable");
    if (request.toolPresentation?.mode === "code") throw new Error("OpenCode code presentation is unsupported: the plugin API cannot invoke tools through the complete host permission and execution hooks. Use native or discover presentation.");
    if (this.#options.contextCatalogOnly) return;
    this.#validateCatalog(request, await this.#catalog());
  }

  #validateCatalog(request: Pick<OutcomeDispatchRequest, "declaredTools" | "toolPresentation">, catalog: readonly WorkerToolDescriptor[]): void {
    for (const grant of request.declaredTools ?? []) {
      if (!catalog.some(tool => !forbidden(tool.name) && declaredToolsAllow(tool.name, [grant]))) {
        throw new Error(`OpenCode worker grant ${JSON.stringify(grant)} matches no registered tool`);
      }
    }
    const presentation = request.toolPresentation;
    for (const name of presentation?.preload ?? []) {
      if (!catalog.some(tool => tool.name === name) || !declaredToolsAllow(name, request.declaredTools)) {
        throw new Error(`OpenCode worker preload ${JSON.stringify(name)} is unavailable or unauthorized`);
      }
    }
    if (presentation?.mode === "discover" && !this.#options.nativeActivation) {
      const unsupported = catalog.filter(tool => declaredToolsAllow(tool.name, request.declaredTools) &&
        !BASELINE.includes(tool.name) && !presentation.preload?.includes(tool.name));
      if (unsupported.length) throw new Error(`OpenCode cannot broker these tools while preserving host permissions: ${unsupported.map(tool => tool.name).join(", ")}. Use native presentation${this.#options.nativeActivation ? " or discover to activate native calls" : ", or preload external tools in discover mode"}.`);
    }
  }

  assertAllowed(sessionID: string, name: string): void {
    const request = this.#request(sessionID);
    if (!request) return;
    if (workerPresentationTools(request.toolPresentation).includes(name as never)) return;
    if (forbidden(name) || (request.toolPresentation !== undefined && !BASELINE.includes(name) && !declaredToolsAllow(name, request.declaredTools))) {
      throw new Error(`Tool ${name} is not granted to this graph worker`);
    }
  }

  filterContext(sessionID: string, tools: Record<string, { description: string; input: unknown }>): void {
    const request = this.#request(sessionID);
    if (!request) return;
    const available = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.input, source: "opencode" }));
    this.#catalogs.set(sessionID, available);
    if (this.#options.contextCatalogOnly && request.toolPresentation !== undefined) {
      try { this.#validateCatalog(request, available); } catch (error) {
        for (const name of Object.keys(tools)) delete tools[name];
        throw error;
      }
    }
    const presentation = request.toolPresentation;
    const active = this.#active.get(sessionID) ?? new Set(presentation?.preload ?? []);
    for (const name of Object.keys(tools)) {
      let allowed = true;
      try { this.assertAllowed(sessionID, name); } catch { allowed = false; }
      if (!allowed || (presentation !== undefined && presentation.mode !== "native" &&
        !BASELINE.includes(name) && !workerPresentationTools(presentation).includes(name as never) && !active.has(name))) delete tools[name];
    }
  }

  createTools(): Record<string, CanonicalToolDef> {
    const tools = createWorkerCapabilityTools({ resolveSession: async context => {
      const request = this.#request(context.sessionID);
      if (!request?.toolPresentation) return undefined;
      return createWorkerToolSession({ presentation: request.toolPresentation,
        allowedTools: request.declaredTools ?? [],
        registry: {
          list: async () => {
            const contextCatalog = this.#catalogs.get(context.sessionID);
            if (this.#options.contextCatalogOnly) return contextCatalog ?? [];
            const fresh = await this.#catalog();
            if (!contextCatalog) return fresh;
            const visible = new Map(contextCatalog.map(tool => [tool.name, tool]));
            return fresh.flatMap(tool => visible.has(tool.name) ? [{ ...tool, inputSchema: visible.get(tool.name)!.inputSchema }] : []);
          },
          invoke: async name => { throw new Error(`OpenCode cannot broker ${name} through the complete host permission and execution hooks. Describe it, then call the native tool.`); },
        },
        activate: descriptors => {
          if (!this.#options.nativeActivation) return;
          const active = this.#active.get(context.sessionID) ?? new Set<string>();
          for (const descriptor of descriptors) active.add(descriptor.name);
          this.#active.set(context.sessionID, active);
        },
      });
    } });
    const discovery = tools.graph_worker_tools;
    if (discovery) discovery.description = "List, search, or describe tools granted to this worker. Describing a tool activates its native tool for the next model turn; call that native tool to execute it with host permissions. The call action is unsupported on OpenCode.";
    return tools;
  }
}
