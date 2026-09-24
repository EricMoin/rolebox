import { OutcomeHost, withCancelDelivery, type OutcomeHostOptions } from "../host/outcome-host.ts";
import { assembleHostCapabilities } from "../policy/acceptance-primitives.ts";
import { createGraphToolSet } from "../tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../tools/index.ts";

export interface GraphApplicationOptions extends Omit<OutcomeHostOptions, "validators" | "completionPolicies"> {
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Owns the capabilities and storage boundary shared by all graph entry points. */
export class GraphApplication {
  readonly capabilities;
  readonly host: OutcomeHost;
  readonly tools;

  private constructor(options: GraphApplicationOptions) {
    this.capabilities = assembleHostCapabilities({
      artifactRoot: options.artifactRoot ?? options.workspaceDir,
      storeRoot: options.storeRoot,
      env: options.env,
    });
    this.host = OutcomeHost.open({
      ...options,
      validators: this.capabilities.validators,
      completionPolicies: this.capabilities.completionPolicies,
    });
    this.tools = createGraphToolSet({
      directory: options.workspaceDir,
      stateDir: options.workspaceDir,
      credentialIsolation: this.host.credentialIsolation,
      hostIdentity: this.host.workerIdentity,
      outcomeDispatch: this.host.dispatch,
      outcomeValidators: this.capabilities.validators,
      outcomeAcceptanceCapabilities: this.capabilities.capabilities,
      completionPolicies: this.capabilities.completionPolicies,
      approvalPolicy: this.capabilities.approvalPolicy,
      outcomeArtifactRoot: options.artifactRoot ?? options.workspaceDir,
      onGraphDeclared: (graphId, sessionId, agent) =>
        this.host.startDeclaredGraph(graphId, { sessionId, agent }),
    });
  }

  static open(options: GraphApplicationOptions): GraphApplication {
    return new GraphApplication(options);
  }

  createTools(getEffectiveAgent?: (sessionId?: string) => string, onChanged?: () => void) {
    const tools = this.host.bindTools(
      withCancelDelivery(createOutcomeGraphTools(this.tools, { getEffectiveAgent }), this.host),
      getEffectiveAgent,
    );
    if (onChanged === undefined) return tools;
    return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const result = await tool.execute(...args);
        if (name !== "graph_status" && name !== "graph_audit") onChanged();
        return result;
      },
    }]));
  }

  close(): void {
    this.host.close();
  }
}
