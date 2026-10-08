import { configureLogging } from "../../log/index.ts";
import { OutcomeHost, withCancelDelivery, type OutcomeHostOptions } from "../host/outcome-host.ts";
import { assembleHostCapabilities } from "../policy/acceptance-primitives.ts";
import { createGraphToolSet } from "../tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../tools/index.ts";
import { GraphNotifications, type GraphNotificationOptions } from "./graph-notifications.ts";

/**
 * Install the platform logging pipeline for this process.
 *
 * ONE CONFIGURATION, THE KERNEL'S OWN DEFAULTS: naming no `sinks` selects the
 * default console + file + memory pipeline (src/log/index.ts), and `role:
 * "host"` is what every record this process produces reports — the engine runs
 * inside the host's process, so its diagnostics are the host's. The engine
 * emits through the shared vocabulary (src/log/registry.ts) rather than a
 * module-private sink, so this call is the whole of its wiring.
 *
 * NEITHER HALF MAY BREAK `open`. `configureLogging` never throws on its own;
 * the guard here makes that promise local to this class, so a process whose log
 * pipeline cannot be installed still opens its graph application, with the
 * diagnostics going wherever the kernel's default pipeline puts them.
 */
function installGraphApplicationLogging(): void {
  try {
    configureLogging({ role: "host" });
  } catch {
    // A logging failure must never make the application fail to open.
  }
}

export interface GraphApplicationOptions extends Omit<OutcomeHostOptions, "validators" | "completionPolicies"> {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly notifications?: GraphNotificationOptions;
}

/** Owns the capabilities and storage boundary shared by all graph entry points. */
export class GraphApplication {
  readonly capabilities;
  readonly host: OutcomeHost;
  readonly tools;
  readonly notifications: GraphNotifications | undefined;

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
    this.notifications = options.notifications === undefined ? undefined : new GraphNotifications(options.storeRoot, options.notifications);
  }

  static open(options: GraphApplicationOptions): GraphApplication {
    installGraphApplicationLogging();
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
    this.notifications?.close();
    this.host.close();
  }
}
