import type { ApprovalPolicy } from "../policy/approval-policy.ts";
import {
  buildDeclaredOutcomeGraph,
  declaredGraphResult,
  GraphDeclareRefusedError,
  persistDeclaredGraph,
  readExistingDeclaredGraph,
  retiredDeclaredRecord,
  type DeclaredOutcomeGraph,
  type GraphDeclareArgs,
  type GraphDeclareResult,
} from "./declare-graph.ts";
import {
  submitDeclaredOutcome,
  type GraphSubmitOutcomeArgs,
  type GraphSubmitOutcomeResult,
} from "./submit-outcome.ts";
import type { OutcomeDispatchAdapter, OutcomeResumeResult } from "../outcome/runtime.ts";
import type { AttemptCredentialSource } from "../outcome/attempt-credential.ts";
import {
  readCredentialIsolationAdapter,
  type CredentialIsolationCapability,
} from "../outcome/credential-isolation.ts";
import type { HostIdentityCapability } from "../outcome/host-identity.ts";
import {
  createValidatorRegistry,
  type AcceptanceCapabilitySet,
  type ValidatorRegistry,
} from "../outcome/validators.ts";
import { auditGraphStore, type DrainAuditReport } from "../audit/drain-audit.ts";
import type { ContractRegistry } from "../contracts/resolve.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import { engineStateDir } from "../persistence/paths.ts";
import { createSubLogger } from "../../logger.ts";
import { errorText } from "../../utils/error-text.ts";
import type { GraphControlResult } from "../control/application.ts";
import { runGraphControlEntry, type GraphControlEntryArgs } from "./control-entry.ts";
import { queryGraphs } from "../query/graph-query.ts";
import { renderGraphQuery, type GraphStatusArgs } from "../query/render.ts";
export type GraphStatusFormat = "summary" | "tree" | "json";
export type { GraphStatusArgs } from "../query/render.ts";
export const log = createSubLogger("graph:tools");
const EMPTY_OUTCOME_VALIDATORS = createValidatorRegistry([]);
interface DeclaredGraphEntry { readonly graph: DeclaredOutcomeGraph; readonly persisted: boolean }
export interface GraphToolSetDeps {
  readonly approvalPolicy?: ApprovalPolicy;

  directory?: string;

  stateDir?: string;

  contracts?: ContractRegistry;

  completionPolicies?: CompletionPolicyRegistry;

  credentialIsolation?: CredentialIsolationCapability;

  outcomeMintCredential?: AttemptCredentialSource;

  hostIdentity?: HostIdentityCapability;

  outcomeDispatch?: OutcomeDispatchAdapter;

  outcomeValidators?: ValidatorRegistry;

  outcomeAcceptanceCapabilities?: AcceptanceCapabilitySet;

  outcomeArtifactRoot?: string;

  outcomeNow?: number;

  onGraphDeclared?: (
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ) => Promise<OutcomeResumeResult> | OutcomeResumeResult | void;
}

export class GraphToolSet {
  private readonly declaredGraphs = new Map<string, DeclaredGraphEntry>();
  constructor(private readonly deps: GraphToolSetDeps = {}) { }
  graph_declare(
    args: GraphDeclareArgs,
    invokingSessionId?: string,
    agent?: string,
  ): GraphDeclareResult {
    const built = buildDeclaredOutcomeGraph({
      declaration: args.declaration,
      ...(args.graph_id === undefined ? {} : { graphId: args.graph_id }),
      installedValidators:
        this.deps.outcomeValidators ?? EMPTY_OUTCOME_VALIDATORS,
      ...(this.deps.outcomeAcceptanceCapabilities === undefined
        ? {}
        : {
          installedAcceptanceCapabilities:
            this.deps.outcomeAcceptanceCapabilities,
        }),
      ...(args.supported_validators === undefined
        ? {}
        : { supportedValidators: args.supported_validators }),
      ...(this.deps.contracts === undefined
        ? {}
        : { contracts: this.deps.contracts }),
      ...(this.deps.completionPolicies === undefined
        ? {}
        : { completionPolicies: this.deps.completionPolicies }),
    });

    const retired = retiredDeclaredRecord(this.deps.stateDir, built.graphId);
    if (retired !== undefined) {
      throw new GraphDeclareRefusedError(
        "persisted-state-unreadable",
        `graph_declare refused: a retired per-graph engine-state container for graph ` +
        `"${built.graphId}" is still present at ${retired.path}. That record belongs to a ` +
        "layout this build no longer writes and has NO decoder for, so it is neither read " +
        "as a declaration nor overwritten. Inventory and archive it (or declare the graph " +
        "under a new name); the declaration is refused rather than allowed to strand it.",
      );
    }
    const onDisk = readExistingDeclaredGraph(this.storeDirectory(), built.graphId);
    if (onDisk.kind === "unreadable") {
      throw new GraphDeclareRefusedError(
        "persisted-state-unreadable",
        `graph_declare refused: ${onDisk.reason}. Resolve or move that file before ` +
        `declaring graph "${built.graphId}" — it is never overwritten blindly.`,
      );
    }
    if (onDisk.kind === "declared") {
      if (onDisk.planRevision !== built.plan.planRevision) {
        throw new GraphDeclareRefusedError(
          "declaration-changed",
          `graph_declare refused: graph "${built.graphId}" already owns a PERSISTED compiled ` +
          `plan (revision ${onDisk.planRevision}) and the incoming declaration compiles to ` +
          `${built.plan.planRevision}. The persisted plan is authoritative for the declaration ` +
          "it was compiled from — it is neither overwritten nor silently dropped. Declare " +
          "under a new graph name; replacing a plan is a separate replanning decision.",
        );
      }
      this.declaredGraphs.set(built.graphId, { graph: built, persisted: true });
      return declaredGraphResult(built, { persisted: true, preserved: true });
    }

    const persisted = persistDeclaredGraph(built, this.storeDirectory());
    this.declaredGraphs.set(built.graphId, { graph: built, persisted });
    return declaredGraphResult(built, { persisted, preserved: false });
  }

  async graph_declare_and_start(
    args: GraphDeclareArgs,
    invokingSessionId?: string,
    agent?: string,
  ): Promise<GraphDeclareResult> {
    const result = this.graph_declare(args, invokingSessionId, agent);
    if (!result.persisted) return { ...result, start: { kind: "blocked", reason: "Declaration was not persisted" } };
    if (this.deps.onGraphDeclared === undefined) {
      return { ...result, start: { kind: "saved" } };
    }
    try {
      const start = await this.deps.onGraphDeclared(result.graph_id, invokingSessionId, agent);
      if (start === undefined) return { ...result, start: { kind: "saved" } };
      if (start.kind === "refused") return { ...result, start: { kind: "refused", refusals: start.refusals } };
      return {
        ...result, start: {
          kind: start.kind, phase: start.state.phase,
          dispatched: start.dispatched.map(({ nodeId, attemptId }) => ({ nodeId, attemptId })),
          refusals: start.refusals, divergences: start.divergences,
        }
      };
    } catch (error) {
      return { ...result, start: { kind: "blocked", reason: errorText(error) } };
    }
  }

  async graph_submit_outcome(
    args: GraphSubmitOutcomeArgs,
    invokingSessionId?: string,
    _agent?: string,
  ): Promise<GraphSubmitOutcomeResult> {
    return submitDeclaredOutcome(
      {
        workspaceDir: this.deps.stateDir,
        graphId: args.graph_id,
        declaredInMemory: this.declaredGraphs.has(args.graph_id),
      },
      args,
      {
        ...(invokingSessionId === undefined ? {} : { invokingSessionId }),
        ...(this.deps.outcomeDispatch === undefined
          ? {}
          : { dispatch: this.deps.outcomeDispatch }),
        ...(this.deps.outcomeValidators === undefined
          ? {}
          : { validators: this.deps.outcomeValidators }),
        ...(this.deps.completionPolicies === undefined
          ? {}
          : { completionPolicies: this.deps.completionPolicies }),
        ...(this.deps.credentialIsolation === undefined
          ? {}
          : { credentialIsolation: this.deps.credentialIsolation }),
        ...(this.deps.hostIdentity === undefined
          ? {}
          : { hostIdentity: this.deps.hostIdentity }),
        artifactRoot: this.deps.outcomeArtifactRoot ?? this.deps.directory ?? ".",
        ...(this.deps.outcomeNow === undefined
          ? {}
          : { now: this.deps.outcomeNow }),
      },
    );
  }

  graph_control(
    args: GraphControlEntryArgs,
    invokingSessionId?: string,
    agent?: string,
  ): GraphControlResult {
    return runGraphControlEntry(
      {
        storeDirectory: this.storeDirectory(),
        approvalPolicy: this.deps.approvalPolicy,
        ...(this.deps.outcomeNow === undefined ? {} : { now: this.deps.outcomeNow }),
        ...(this.deps.credentialIsolation === undefined
          ? {}
          : { credentialIsolation: this.deps.credentialIsolation }),
        ...(this.deps.outcomeMintCredential === undefined
          ? {}
          : { mintCredential: this.deps.outcomeMintCredential }),
      },
      args,
      invokingSessionId,
      agent,
    );
  }

  graph_status(args: GraphStatusArgs): string {
    return renderGraphQuery(queryGraphs(this.storeDirectory() ?? engineStateDir(process.cwd())), args, new Set(this.declaredGraphs.keys()));
  }
  private storeDirectory(): string | undefined {
    const isolation = readCredentialIsolationAdapter(this.deps.credentialIsolation);
    if (isolation !== undefined) return isolation.credentialStoreRoot;
    if (this.deps.stateDir === undefined) return undefined;
    return engineStateDir(this.deps.stateDir);
  }

  async graph_audit(): Promise<DrainAuditReport> {
    return auditGraphStore({
      directory: this.deps.stateDir ?? process.cwd(),
      ...(this.storeDirectory() === undefined
        ? {}
        : { ledgerDirectory: this.storeDirectory() }),
      retiredRecordDirectory: engineStateDir(this.deps.stateDir ?? process.cwd()),
    });
  }
}
export function createGraphToolSet(deps?: GraphToolSetDeps): GraphToolSet {
  return new GraphToolSet(deps);
}
export { EnginePhase, NodeStatus } from "../../constants.ts";
