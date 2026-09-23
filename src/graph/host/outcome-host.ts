/**
 * Graph Execution Engine v2 — the SHIPPED host assembly for the outcome run path
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WIRES THE HOST CAPABILITY LAYER (`src/graph/host/**`) INTO ONE OBJECT a
 * shipping host injects into the outcome tool face and the startup recovery
 * sweep:
 *
 * - the protected credential vault (D7) — the only place an attempt credential
 *   exists once it is minted, since the ledger keeps its digest;
 * - the durable execution index plus the dispatch adapter (D8) — create at most
 *   once per stable effect id, and answer `created` / `absent` / `unknown`
 *   about an effect a restart finds in the ledger;
 * - the invocation-identity holder (D9) — the host's own attribution of "which
 *   invocation is running now", moved per tool call and per first execution,
 *   captured on each attempt's binding and re-entered for the duration of that
 *   attempt's completion settlement (see {@link OutcomeHost.complete});
 * - the completion bridge — an attempt the platform reports finished is settled
 *   through the runtime's own completion channels, never through a second
 *   ingress;
 * - the DURABLE completion binding and the platform re-read (P2 item 6) — a
 *   completion that arrives after the process which dispatched the attempt
 *   exited is resolved from the host's own record (the ONE store's execution row
 *   plus the dispatch effect that names the node), and an execution that already
 *   reached its end while nobody was listening is READ from the platform and
 *   applied idempotently instead of waiting for a callback that will never come.
 *   An execution the platform reports STILL RUNNING is not settled and not
 *   forgotten either: the sweep names it (with the platform's own execution id)
 *   in `awaitingCompletion`, the inventory {@link
 *   OutcomeHost.retainAwaitingCompletions} CONSUMES after the sweep —
 *   re-subscribing through the entry's platform watch port where the platform
 *   supports it, re-querying on the same recovery window where it does not, and
 *   reporting every execution it could not keep observing;
 * - THE PLATFORM QUERY PORT (P2 item 5, F2) — the create's outcome may be
 *   unknown, but the platform can be asked about the SAME stable effect id and
 *   can name the execution it created. The host joins that answer with its own
 *   registry, binds the name when this process still owns the claim, keeps it as
 *   a re-derivable reading otherwise, and never turns "I cannot see" into
 *   `absent` — a false `absent` is what would license a second execution;
 * - the host's COMPLETION AUTHORITY (P2 item 7) — the confirmed execution the
 *   host's durable record carries (or the execution the platform named for the
 *   same stable effect id) is what authenticates a completion the worker's
 *   bearer value can no longer vouch for, and the run path refuses a fact it
 *   cannot corroborate.
 *
 * AND THE CACHED RUN PATH IS VALIDATED BEFORE IT IS USED (G14). A graph's
 * runtime is opened once and kept, so the durable definition row is re-read on
 * every acquisition: a row that stopped reading, or that no longer names the
 * same content, refuses the graph BY NAME — which is what keeps the boot sweep,
 * the audit and the status query answering the same thing about the same store.
 * A store the format gate refuses is reported as a BLOCKED sweep, never as an
 * empty one.
 *
 * WHETHER THE HOST DECLARES D9 IS A DECISION, NOT A DEFAULT. The identity
 * capability is an assertion the host must be able to substantiate: the
 * submission that settles an attempt has to be attributed to the same
 * invocation that armed it. {@link OutcomeHostOptions.declareInvocationIdentity}
 * is that decision, and the shipped entries choose NOT to declare it because a
 * dispatched worker is a separate agent session whose own tool calls are
 * attributed to the worker, never to the declaring invocation.
 *
 * WHAT THE SHIPPED HOSTS DECLARE INSTEAD. Declining D9 is not declining to
 * check anything: the same entries inject {@link OutcomeHost.workerIdentity},
 * the binding of an attempt to the CHILD SESSION the platform created for its
 * worker, and the submission ingress refuses a call that arrives from any other
 * session ({@link OutcomeHostOptions.workerSessionOf} says where the session
 * comes from). The two capabilities name two different subjects — the declaring
 * controller and the actual worker — and a host declares the one it can
 * substantiate.
 *
 * WHO RUNS THE FIRST DISPATCH. A declared graph is persisted by
 * `graph_declare` and dispatched by nobody in the tool layer. The host calls
 * {@link OutcomeHost.startDeclaredGraph} from its declaration seam: that opens
 * the graph's saved plan, continues (or starts) it through the outcome
 * runtime's own `resume`, and closes the same crash windows a restart sweep
 * closes. {@link OutcomeHost.recoverDeclaredGraphs} is the same operation over
 * every protocol-2 record in the store, for a host's boot path.
 *
 * EVERY DISPATCH WINDOW NAMES THE GRAPH'S DECLARING INVOCATION. A platform can
 * only start a worker under the invocation that owns it, and only ONE of the
 * windows that arm a dispatch is the declaring call: a successor is armed by an
 * acceptance (a worker's submission or an observed completion) and a boot sweep
 * re-arms what a dead process left pending, both with no tool call in effect.
 * The host therefore keeps the declaring invocation PER GRAPH — in memory and,
 * with `durability: "file"`, in its own store root
 * (`invocation-origins.ts`) — and hands it to the delivery seam on every
 * create, so the entry attempt and every successor run under the same parent
 * instead of the window's ambient attribution.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never builds a legacy engine,
 * never imports one, and never registers a legacy tool: a declared graph has no
 * legacy runtime instance. Its delivery seam is injected by the host
 * ({@link HostDispatchDelivery}) so the platform-specific way to start a worker
 * stays in the platform adapter.
 */

import type { CanonicalToolDef, CanonicalToolContext } from "../../platform/types.ts";
import { errorText } from "../../utils/error-text.ts";
import { logWarn } from "../log-warn.ts";
import {
  describeStoreVerdict,
  describeStoredReading,
  readStoredDefinition,
} from "../persistence/declared-record.ts";
import { loadGraphStoreSync } from "../store/load.ts";
import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import type { PendingEffectRecord } from "../ledger/types.ts";
import {
  OutcomeGraphRuntime,
  type AttemptCredentialReissueFence,
  type HostCompletionAttemptRef,
  type HostCompletionAuthority,
  type OutcomeResumeResult,
} from "../outcome/runtime.ts";
import type {
  CredentialIsolationCapability,
  DurableCredentialStore,
} from "../outcome/credential-isolation.ts";
import type {
  HostIdentityCapability,
  HostWorkerAttemptRef,
  HostWorkerBinding,
  HostWorkerIdentityCapability,
} from "../outcome/host-identity.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../outcome/validators.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import type {
  HostAttemptBinding,
  HostDispatchDelivery,
  HostDispatchInvocation,
} from "./dispatch-host.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeExecutionIdentity,
  OutcomeExecutionProbe,
  OutcomeExecutionQuery,
} from "../outcome/dispatch-effects.ts";
import {
  dispatchEffectIdOf,
  dispatchEffectKeyOf,
} from "../outcome/dispatch-effects.ts";
import type {
  OutcomeEffectDivergence,
  OutcomeRuntimeRefusal,
} from "../outcome/runtime.ts";
import { HostOutcomeDispatch } from "./dispatch-host.ts";
import {
  HostExecutionIndex,
  hostExecutionNotCreated,
  type HostExecutionIdentity,
} from "./execution-index.ts";
import { HostCredentialVault } from "./credential-vault.ts";
import { HostInvocationOrigins } from "./invocation-origins.ts";
import { GraphStore } from "../store/graph-store.ts";
import {
  HostDispatchCompletionBridge,
  type HostCompletionAttempt,
  type HostCompletionReport,
  type HostCompletionRuntime,
} from "./completion-bridge.ts";
import {
  createHostInvocationHolder,
  createHostWorkerSessionHolder,
  hostInvocationIdentity,
  hostWorkerIdentityCapability,
  type HostInvocationHolder,
  type HostWorkerSessionHolder,
} from "./identity.ts";

// ── Options and result shapes ───────────────────────────────────────────────

/** How long the host's vault and execution index outlive the process. */
export type OutcomeHostDurability = "file" | "memory";

/** Inputs to {@link OutcomeHost.open}. */
export interface OutcomeHostOptions {
  /**
   * The workspace whose `.rolebox/state` store holds the declared graphs'
   * persisted plans. Also the default artifact root.
   */
  readonly workspaceDir: string;
  /**
   * The HOST-owned root the vault, the execution index and the acceptance
   * ledger live under. Deliberately NOT the workspace by default — see
   * `credential-vault.ts` for the boundary this root can and cannot give.
   */
  readonly storeRoot: string;
  /** How the platform starts one attempt. See `dispatch-host.ts`. */
  readonly deliver: HostDispatchDelivery;
  /** The validator capabilities this host installs (defaults to none). */
  readonly validators?: ValidatorRegistry;
  /** The completion policies this host authorized (defaults to none). */
  readonly completionPolicies?: CompletionPolicyRegistry;
  /** Root every evidence reference resolves inside. Defaults to `workspaceDir`. */
  readonly artifactRoot?: string;
  /** The clock reported to settlements; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Vault/index durability. Defaults to `"file"` (restart-recoverable). */
  readonly durability?: OutcomeHostDurability;
  /**
   * What the durable credential store holds — see
   * `HostCredentialVaultOptions.durableCredentialStore`. Defaults to `"none"`:
   * the durable store records each attempt and no credential value, so a
   * same-account reader obtains nothing and a recovery that needs a lost
   * credential reports the effect as unsettled. A host that provides a real
   * platform boundary (a different OS account, a container or mount namespace
   * the worker is not in) may declare `"platform-isolated"` to keep values
   * durable so a crash-window attempt can be re-delivered after a restart.
   */
  readonly durableCredentialStore?: DurableCredentialStore;
  /**
   * Whether this host DECLARES the invocation-identity capability (D9) to the
   * run path. Defaults to `true`.
   *
   * DECLARE IT ONLY WHEN THE HOST CAN SUBSTANTIATE IT. The capability's
   * contract is that a submission settling an attempt is attributed to the
   * SAME invocation the dispatch armed it under. A host whose dispatched
   * workers submit from their OWN invocations (the shipped dsh and Pi entries:
   * a worker is a separate agent session, not the declaring one) cannot
   * substantiate that, and declaring it would refuse exactly the submissions
   * the delivery handoff asks the worker to make. Such a host passes `false`
   * and uses {@link workerSessionOf} instead: the DECLARING invocation stays
   * attribution/notification, while the worker is bound by the child session
   * the platform created ({@link OutcomeHost.workerIdentity}), which is the
   * subject a worker's own tool call actually arrives from.
   */
  readonly declareInvocationIdentity?: boolean;
  /**
   * How this host derives the CHILD SESSION the platform created for one
   * confirmed execution.
   *
   * This is the one platform-specific fact the generic host layer cannot read
   * for itself: dsh publishes the child session as the run id it returns
   * ({@link HostExecutionIdentity.executionId} for a local run), and Pi returns
   * a dispatch task whose `sessionId` is the worker's session. The host calls
   * this with the CONFIRMED execution identity — never with a caller-supplied
   * value — the moment a submission is judged, and answers `undefined` when the
   * platform cannot name the session (an unknown task, a run this host did not
   * start): the attempt is then unbound and nothing settles it through the
   * worker path.
   *
   * OMITTED for a host that cannot substantiate the child session: the worker
   * binding is then not enabled for it, exactly as omitting the capability
   * leaves the D9 binding unenabled.
   */
  readonly workerSessionOf?: (execution: HostExecutionIdentity) => string | undefined;
  /**
   * THE PLATFORM'S OWN ANSWER ABOUT A CONFIRMED EXECUTION (P2 item 6).
   *
   * §3.3: a restart rebuilds the completion binding from the persisted
   * execution/child-session binding and RE-SUBSCRIBES OR READS THE TERMINAL
   * STATE. Re-subscribing is the platform's callback (already wired); this port
   * is the read: asked about an execution the host confirmed, the platform
   * answers whether that execution has already reached its end — and, when it
   * has, whether it reached the outcome its plan authorized.
   *
   * WHY IT MATTERS. An execution that finished while no process was listening
   * will never announce itself again. Without this port the attempt would wait
   * forever for a callback that is not coming — the silent strand the plan
   * forbids — so the boot sweep asks, and a `completed` answer settles the
   * attempt idempotently through the same acceptance core an announced
   * completion uses.
   *
   * A FAILED END IS NOT A COMPLETION (plan §3.4). An execution the platform
   * reports over WITHOUT reaching its authorized outcome (`failed`) is NEVER
   * settled on this channel: the durable failure write is P3's command, and
   * inventing a successful outcome for a run that crashed is exactly the
   * fabrication the plan forbids. The attempt is reported unsettled instead.
   *
   * INSTALLED BY BOTH SHIPPED ENTRIES (F3). dsh cannot read a run's outcome
   * after the process that held it exited (its child listing encodes no durable
   * outcome), so the dsh port answers `unknown` with that reason; Pi reads the
   * dispatch manager's own task record. A host that installs no port at all
   * still gets the honest `unknown` and a per-effect refusal — never
   * "resumed-and-fine" while an execution's fate is unknown.
   */
  readonly observeExecution?: HostExecutionObservationPort;
  /**
   * THE PLATFORM'S OWN ANSWER ABOUT ONE DISPATCH EFFECT (P2 item 5).
   *
   * The question the runtime's crash-window reconciliation asks: whether an
   * execution exists for a stable effect id whose create outcome was never
   * confirmed — and, when one does, WHICH execution (F2). The port is reached
   * through {@link OutcomeHost.dispatch}, joined with the host's own registry,
   * and its `prime` phase is awaited by this host's asynchronous entry points
   * before the synchronous run path asks.
   *
   * A platform that cannot answer says `unknown` and the effect stays BLOCKED:
   * only a PROOF of non-existence may release a stranded create right, and
   * neither shipped platform can prove it.
   */
  readonly query?: OutcomeExecutionQuery;
  /**
   * WHERE THE HOST RE-SUBSCRIBES TO AN EXECUTION IT IS STILL WAITING ON (F4).
   *
   * The boot sweep names every confirmed execution whose completion has not
   * arrived in `awaitingCompletion`; this port is how the host turns that
   * inventory into a LIVE observation again. The entry installs the platform's
   * own notification channel (Pi: `dispatchManager.onTaskTerminated`); the
   * callback fires when the platform says the execution ended, and the host
   * settles the attempt through the SAME completion bridge an announced
   * in-process completion uses — never a second listener mechanism.
   *
   * A platform that cannot subscribe after the process that held the run exited
   * answers `"unsupported"` (dsh), and the host reports those executions as
   * unwatched rather than pretending they are covered.
   */
  readonly watchCompletion?: HostCompletionWatchPort;
}

/**
 * What the platform can say about one CONFIRMED execution.
 *
 * A CLOSED four-way answer. "Still running" and "cannot tell" must never be
 * rounded into an end, and — the distinction that keeps a crash from being
 * settled as a success — the two ways an execution can END are separate:
 *
 * - `completed` — the execution reached the outcome its plan authorized. A
 *   COMPLETION fact, settled through the acceptance core;
 * - `failed` — it ended WITHOUT reaching that outcome (failed, cancelled,
 *   timed out, aborted), with the platform's own reason. It is reported as an
 *   unsettled attempt and is NEVER settled as a completion: P3 owns the durable
 *   failure write, and fabricating a successful outcome would be exactly the
 *   §3.4 violation the plan forbids;
 * - `running` — still in flight;
 * - `unknown` — the platform cannot tell. Keeps the attempt in flight and is
 *   REPORTED, exactly as an unanswerable execution query keeps a dispatch effect
 *   unsettled.
 */
export type HostExecutionObservation =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "running" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * How the host asks the platform about a confirmed execution. Receives the
 * host's own confirmed identity — never a caller-supplied value — so the
 * question is always about the execution the host actually created.
 */
export type HostExecutionObservationPort = (
  execution: HostExecutionIdentity,
) => HostExecutionObservation;

/**
 * The platform's own notification channel for one execution the host is still
 * waiting on (F4).
 *
 * `watch` asks the platform to announce the end of ONE execution the sweep
 * named in `awaitingCompletion`; `onEnded` is invoked at most once, when the
 * platform says it is over (a platform that already knows it ended must deliver
 * that immediately). `"watching"` means the announcement is established — the
 * host then settles the attempt through the SAME completion bridge an in-process
 * announcement uses. `"unsupported"` means this platform cannot re-establish
 * the observation for that execution, and the host REPORTS it as unwatched
 * instead of pretending it is covered.
 *
 * IT IS NOT A SECOND LISTENER MECHANISM: the callback carries no outcome, no
 * payload and no credential — it only says "look again", and the settlement
 * runs through the one completion bridge the delivery path already feeds.
 */
export type HostCompletionWatchVerdict = "watching" | "unsupported";

/** How the host re-subscribes to one awaited execution (F4). */
export type HostCompletionWatchPort = (
  entry: OutcomeHostAwaitingCompletion,
  onEnded: () => void,
) => HostCompletionWatchVerdict;

/**
 * One confirmed execution the host could NOT re-establish a watch on (F4).
 *
 * Reported, never silent: the execution is still in flight (or its fate is
 * unknown), no platform announcement is established for it in this process, and
 * the next recovery window is the only thing that will look at it again.
 */
export interface OutcomeHostUnwatchedExecution {
  readonly graphId: string;
  readonly attemptId: string;
  /** The platform's own id for the execution, as the sweep reported it. */
  readonly executionId: string;
  readonly reason: string;
}

/**
 * What re-establishing observation over the sweep's `awaitingCompletion`
 * inventory did (F4).
 *
 * `watched` is the platform's announcement ESTABLISHED for a named execution
 * (the settlement it triggers is idempotent and goes through the one completion
 * bridge); `settled` is an execution this call itself resolved from a
 * `completed` read; `unwatched` is every execution this process cannot keep
 * observing, with the reason.
 */
export interface OutcomeHostWatchReport {
  /** `graph:attempt:executionId` for each execution the platform now watches. */
  readonly watched: readonly string[];
  /** `graph:attempt:report` for each execution settled from a terminal read. */
  readonly settled: readonly string[];
  readonly unwatched: readonly OutcomeHostUnwatchedExecution[];
}

/** Inputs to {@link OutcomeHost.retainAwaitingCompletions}. */
export interface OutcomeHostWatchOptions {
  /**
   * Called after a settlement this call performed — or the watch it
   * established — actually finished, so the entry can refresh its own views
   * (the web console, a log line). Optional: the settlement itself does not
   * depend on it.
   */
  readonly onSettled?: (graphId: string, attemptId: string) => void;
}

/** One host invocation's attribution, as the declaring tool call saw it. */
export interface OutcomeHostInvocation {
  readonly sessionId?: string;
  readonly agent?: string;
}

/**
 * One per-effect refusal a sweep reports.
 *
 * Mostly the run path's own refusals, each tagged with the graph it came from.
 * The sweep ALSO reports conditions the run path cannot name — an in-flight
 * attempt the platform could not be asked about, or one the platform reports
 * TERMINAL that the host could not settle — so the vocabulary carries one code
 * of the sweep's own: `completion-unsettled` says "this attempt is still
 * unsettled and here is why", which is exactly the observable block P2 item 6
 * requires where a silent strand would otherwise be.
 */
export interface OutcomeHostEffectRefusal {
  readonly code: OutcomeRuntimeRefusal["code"] | "completion-unsettled";
  readonly message: string;
  readonly path?: string;
  readonly graphId: string;
}

/**
 * ONE CONFIRMED HOST EXECUTION THE SWEEP IS STILL WAITING ON (P2 item 6).
 *
 * The execution id is the PLATFORM's own, read from the host's durable record —
 * never a caller-supplied value and never parsed out of an attempt id — so a
 * host adapter can re-subscribe to that execution or keep querying it.
 */
export interface OutcomeHostAwaitingCompletion {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /**
   * The platform's own id for the execution: the host's confirmed record when
   * it has one, and otherwise the execution the PLATFORM's query named for the
   * same stable effect id (F2 — the create whose confirmation never arrived).
   */
  readonly executionId: string;
  /** The platform's task id, when it names the execution and the task apart. */
  readonly taskId?: string;
  /**
   * What the platform said: `running` (it answered that the execution has not
   * finished) or `unknown` (it could not be asked, or did not answer). Never
   * `terminal`: a terminal execution is settled, not awaited.
   */
  readonly status: "running" | "unknown";
  /** Why it is still awaited — the platform's own reason for `unknown`. */
  readonly reason: string;
}

/**
 * What a boot sweep over the declared graphs did.
 *
 * A STARTED OR RESUMED GRAPH STILL CARRIES ITS PER-EFFECT DIAGNOSTICS. A
 * graph's own `resume` reports every effect it could not launch and every
 * effect whose persisted row contradicted the host's fact; the sweep is the
 * caller that owns those effects, so it AGGREGATES them instead of reporting
 * only that the graph was visited. `refused` stays what it always was — the
 * graphs the sweep could not open or run AT ALL.
 */
export interface OutcomeHostRecoveryReport {
  /** `graph:revision` for each graph this sweep gave a FIRST EXECUTION. */
  readonly started: readonly string[];
  /** `graph:phase` for each graph continued from persisted state. */
  readonly resumed: readonly string[];
  /** `graph:reason` for each protocol-2 record this sweep could not open. */
  readonly refused: readonly string[];
  /**
   * Every per-effect refusal the graphs' own resumes reported, each tagged with
   * the graph it came from: an effect the runtime would not launch (an
   * unreadable payload, a credential the host cannot produce, a create the
   * platform refused) stays `pending` and is named here rather than dropped.
   */
  readonly effectRefusals: readonly OutcomeHostEffectRefusal[];
  /**
   * Every restart DIVERGENCE the graphs' own resumes reported, each tagged with
   * its graph: the persisted local effect status and the host's fact about the
   * same stable id disagree, and the resolution says what the resume did about
   * it — never a blind re-dispatch and never a silent drop.
   */
  readonly divergences: readonly (OutcomeEffectDivergence & {
    readonly graphId: string;
  })[];
  /**
   * `graph:attempt:verdict` for each in-flight attempt this sweep settled from
   * a TERMINAL host execution (P2 item 6). `accepted` means the completion was
   * applied (or replayed) through the same acceptance core an announced
   * completion uses; `rejected` and `not-committed` mean the settlement ran
   * and the ledger decided — never that a completion was fabricated.
   */
  readonly completed: readonly string[];
  /**
   * EVERY HOST EXECUTION THIS SWEEP IS STILL WAITING ON (P2 item 6).
   *
   * A graph is resumed as soon as its own state is continued, but an attempt
   * whose platform execution has NOT finished cannot be settled from a terminal
   * read: it is settled by the platform's LATER announcement, through the
   * durable binding the resume re-established. That only works while the host
   * keeps listening — and after a restart the process that held the platform's
   * subscription is gone. This is the inventory such a host re-subscribes to,
   * or keeps re-querying, named by the platform's own execution id: item 6's
   * "rebuild the binding AND the listening" does not stop at the binding.
   *
   * THE EXECUTION MAY BE ONE THE LOCAL ROW NEVER CONFIRMED (F2). An attempt
   * whose create confirmation was lost is named here by the execution the
   * PLATFORM's query answered for the same stable effect id — the same
   * execution, found rather than created a second time. The durable row stays
   * exactly as the fence left it (`creating`), and the platform's name is what
   * the host observes and authenticates a completion against.
   *
   * IT IS NOT A CLAIM THAT A SUBSCRIPTION HAPPENED. The sweep asked and the
   * platform answered `running` (or could not answer), so the attempt stays in
   * flight and is named here. An attempt the platform reported TERMINAL that
   * the host could not settle is deliberately ABSENT — there is nothing left to
   * listen to; the `completion-unsettled` refusal names that one instead. So is
   * an attempt whose own host execution record could not be read: there is no
   * execution id to subscribe to, and the refusal names it.
   */
  readonly awaitingCompletion: readonly OutcomeHostAwaitingCompletion[];
  /**
   * Set when the workspace's store could not be read AT ALL, so the sweep had no
   * inventory to visit. A store the format gate refuses must not read as "no
   * graphs exist" — that is the same disagreement between the boot sweep, the
   * audit and the status surface that G14 names, one level up. A store that
   * simply does not exist yet is an empty sweep and sets nothing.
   */
  readonly storeBlocked?: string;
}

/**
 * One graph's open run path, held for the process lifetime.
 *
 * The two identity values are the ones the definition row carried when this
 * runtime was opened. They are NOT a second authority: they exist so
 * {@link OutcomeHost} can notice that the durable definition a cached runtime
 * was opened from is no longer the one the store holds (G14), which is a
 * comparison of two live reads, not a stored copy.
 */
interface RunningGraphRuntime {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  /** The declaration digest this runtime's plan was decoded from. */
  readonly declarationDigest: string;
  /** The plan revision the same row named. */
  readonly planRevision: string;
}

// ── The host ────────────────────────────────────────────────────────────────

/**
 * One host process's outcome-run-path capability layer.
 *
 * Construct with {@link OutcomeHost.open}, inject `credentialIsolation`,
 * `hostIdentity`, `dispatch` and the toolset's outcome options, and keep the
 * instance for the process lifetime: the vault and the execution index are the
 * host's durable facts, and the completion bridge's bindings live here.
 */
export class OutcomeHost {
  private readonly workspaceDir: string;
  private readonly storeRoot: string;
  private readonly artifactRoot: string;
  private readonly clock: () => number;
  private readonly validators: ValidatorRegistry;
  private readonly completionPolicies: CompletionPolicyRegistry | undefined;
  private readonly vault: HostCredentialVault;
  private readonly executions: HostExecutionIndex;
  /**
   * The create-right fence a credential re-issue runs under (plan §3.3).
   *
   * ITS MECHANISM IS THE STORE'S OWN CONDITIONAL CLAIM, not a boolean: `claim`
   * takes the same create right `HostOutcomeDispatch.create` takes (the same
   * `HostExecutionIndex`, so the later create re-claims it idempotently), and
   * `abandon` gives back a claim this host took and never handed to the
   * platform — a proof-backed release, so a later recovery can create once.
   * While this host is between a re-issue and its create, another process is
   * told `held` (or `unknown` through the registry) and cannot replace the
   * verifier of the attempt about to be dispatched.
   */
  private readonly reissueFence: AttemptCredentialReissueFence;
  private readonly origins: HostInvocationOrigins;
  /**
   * The ONE store the capabilities share in `durability: "memory"` mode.
   *
   * A memory-mode host keeps three records — credentials, execution bindings
   * and declaring invocations — and they belong to ONE database with ONE
   * transaction boundary, so the host opens a single private store and hands it
   * to all three. In file mode each capability opens its own connection to the
   * SAME file (the pattern the ledger already uses), so the workspace still has
   * exactly one durable store.
   */
  private readonly sharedStore: GraphStore | undefined;
  private readonly holder: HostInvocationHolder;
  /**
   * The session of the operation being performed (the worker side), moved by
   * {@link bindTools} for each tool call from the platform's own context.
   */
  private readonly workerSessions: HostWorkerSessionHolder;
  private readonly workerCapability: HostWorkerIdentityCapability;
  private readonly declareInvocationIdentity: boolean;
  /** The platform's child-session derivation, when the host declared one. */
  private readonly workerSessionOf:
    | ((execution: HostExecutionIdentity) => string | undefined)
    | undefined;
  private readonly dispatchAdapter: HostOutcomeDispatch;
  /** The platform port the boot sweep observes a confirmed execution through. */
  private readonly observeExecution: HostExecutionObservationPort | undefined;
  /** The platform's dispatch-effect query port, for the run path's own asks. */
  private readonly query: OutcomeExecutionQuery | undefined;
  /** Where a restarted host re-subscribes to an execution it still awaits (F4). */
  private readonly watchCompletion: HostCompletionWatchPort | undefined;
  /**
   * What substantiates a host completion fact this host holds no bearer for
   * (P2 item 7): the host's OWN confirmed execution record. Bound methods, so
   * the runtime holds the capability without holding the host.
   */
  private readonly completionAuthority: HostCompletionAuthority;
  /** One bridge per graph — a settlement needs the graph's own saved plan. */
  private readonly bridges = new Map<string, HostDispatchCompletionBridge>();
  /** One open runtime (and ledger) per graph, for settlements and resumes. */
  private readonly runtimes = new Map<
    string,
    Promise<RunningGraphRuntime>
  >();
  private closed = false;

  private constructor(options: OutcomeHostOptions) {
    this.workspaceDir = options.workspaceDir;
    this.storeRoot = options.storeRoot;
    this.artifactRoot = options.artifactRoot ?? options.workspaceDir;
    this.clock = options.clock ?? (() => Date.now());
    this.validators = options.validators ?? createValidatorRegistry([]);
    this.completionPolicies = options.completionPolicies;
    const durability = options.durability ?? "file";
    const shared = durability === "memory" ? GraphStore.openMemory() : undefined;
    this.sharedStore = shared;
    this.vault = HostCredentialVault.open({
      root: options.storeRoot,
      durability,
      ...(shared === undefined ? {} : { store: shared }),
      ...(options.durableCredentialStore === undefined
        ? {}
        : { durableCredentialStore: options.durableCredentialStore }),
    });
    this.executions = HostExecutionIndex.open({
      root: options.storeRoot,
      durability,
      ...(shared === undefined ? {} : { store: shared }),
    });
    this.reissueFence = Object.freeze({
      claim: (effect: OutcomeDispatchEffectKey) => {
        const claim = this.executions.claim(effect);
        if (claim.kind === "claimed") {
          return { kind: "claimed" as const, ownerId: claim.ownerId };
        }
        const reason =
          claim.state === "created"
            ? "a host execution for this effect already exists"
            : claim.state === "creating"
              ? "the create request was already handed to the platform and its result is unknown"
              : "another claim owns the create right for this effect";
        return {
          kind: "held" as const,
          reason: reason + " (claim " + String(claim.generation) + ")",
        };
      },
      abandon: (effect: OutcomeDispatchEffectKey, ownerId: string, reason: string) => {
        this.executions.release(effect, ownerId, hostExecutionNotCreated(reason));
      },
    });
    this.origins = HostInvocationOrigins.open({
      root: options.storeRoot,
      durability,
      ...(shared === undefined ? {} : { store: shared }),
    });
    this.holder = createHostInvocationHolder();
    this.workerSessions = createHostWorkerSessionHolder();
    this.workerSessionOf = options.workerSessionOf;
    this.observeExecution = options.observeExecution;
    this.query = options.query;
    this.watchCompletion = options.watchCompletion;
    // The authority is the host's own durable record, read through the SAME
    // accessor the worker binding uses: one source of truth for "which
    // execution did this attempt get", never a second copy.
    this.completionAuthority = Object.freeze({
      executionFor: (attempt: HostCompletionAttemptRef) =>
        this.executionBindingOf(attempt),
    });
    this.workerCapability = hostWorkerIdentityCapability("host:worker-identity", {
      current: () => this.holder.current(),
      currentSession: () => this.workerSessions.currentSession(),
      bindingFor: (attempt) => this.workerBindingOf(attempt),
    });
    this.declareInvocationIdentity = options.declareInvocationIdentity ?? true;
    this.dispatchAdapter = new HostOutcomeDispatch({
      executions: this.executions,
      deliver: options.deliver,
      invocation: () => this.holder.current(),
      // The graph's own declaring invocation, not the ambient one: this is what
      // lets a successor armed out of band (and a boot sweep) name the same
      // parent as the entry attempt. The SAME value is what the platform query
      // port is asked with, so the child it correlates is the one this graph
      // dispatched under this parent.
      dispatchInvocation: (graphId) => this.originOf(graphId),
      // THE PLATFORM'S OWN ANSWER, PLUMBED TO THE DISPATCH ADAPTER (F3): the
      // host's option is the one seam the entries install, and the adapter is
      // where the run path's crash-window questions are actually asked.
      ...(options.query === undefined ? {} : { query: options.query }),
      completions: {
        bind: (binding) => {
          this.bridgeFor(binding.graphId).bind(binding);
        },
      },
    });
  }

  static open(options: OutcomeHostOptions): OutcomeHost {
    return new OutcomeHost(options);
  }

  /** The protected credential store, injected as the runtime's D7 capability. */
  get credentialIsolation(): CredentialIsolationCapability {
    return this.vault.capability();
  }

  /** The host's invocation attribution, injected as the runtime's D9 capability. */
  get hostIdentity(): HostIdentityCapability {
    return this.holder.capability;
  }

  /**
   * The host's WORKER-identity capability — what a worker submission is judged
   * by: the session the call arrives from, checked against the child session
   * the platform created for the attempt.
   *
   * WHAT IT ANSWERS FROM. `currentSession()` reads the holder
   * {@link bindTools} moves per tool call from the platform's own context, and
   * `bindingFor()` reads the host's DURABLE execution record (the row the
   * platform's confirmation created) through {@link workerSessionOf}. Neither
   * reads a caller-supplied string: the binding is a fact the platform minted.
   *
   * WHEN IT IS READ, AND WHY THE HOLDER IS STILL LOAD-BEARING. The submission
   * ingress reads `currentSession()` exactly ONCE, synchronously, before it
   * awaits anything, and requires it to AGREE with the session the tool face
   * threads from the same platform context; a disagreement is refused, never
   * resolved by preferring one. The holder therefore never answers for a call
   * other than the one in flight, and a submission can never be settled on
   * whichever concurrent worker moved it last.
   *
   * This is the capability the shipped entries inject into the toolset
   * (`createGraphToolSet({ hostIdentity: host.workerIdentity })`), and it is
   * deliberately NOT the capability the runtime's D9 check consumes — that one
   * is {@link hostIdentity}, and the two are distinct shapes so a host cannot
   * accidentally declare the wrong subject.
   */
  get workerIdentity(): HostWorkerIdentityCapability {
    return this.workerCapability;
  }

  /** The dispatch adapter the outcome runtime and the toolset dispatch through. */
  get dispatch(): HostOutcomeDispatch {
    return this.dispatchAdapter;
  }

  /** The vault, exposed for tests and host reports. */
  get credentials(): HostCredentialVault {
    return this.vault;
  }

  /** Move the invocation this host attributes to the current operation. */
  setInvocation(invocation: OutcomeHostInvocation): void {
    this.holder.set(
      hostInvocationIdentity(invocation.sessionId, invocation.agent),
    );
  }

  /** Report that the current operation carries no host attribution. */
  clearInvocation(): void {
    this.holder.clear();
  }

  /**
   * Settle the attempt the host observed finishing, through the graph's own
   * saved plan. The report is the bridge's — see `completion-bridge.ts`.
   *
   * THE HOST COMPLETION AUTHORITY HAS ITS OWN SOURCE, AND IT IS NOT THE
   * DECLARING PRINCIPAL. The completion is observed later, out of band, long
   * after the declaring call returned; the host settles it as the authority
   * that created the execution, never by impersonating the invocation that
   * armed the attempt and never by asking the worker for the bearer value it
   * was handed. Which of the two modes applies is decided by what the host
   * DECLARED, exactly as it is on the submission path:
   *
   * - WORKER MODE (`declareInvocationIdentity: false`, the shipped hosts): the
   *   completion is authenticated against the host's OWN DURABLE execution
   *   record — the row the platform's confirmation wrote, naming the real
   *   execution id. An attempt with no such row is reported UNBOUND and nothing
   *   is written, because an in-process delivery observation without a
   *   confirmed host execution is not a completion fact. The holder is NOT
   *   touched: the declaring invocation is attribution, and re-entering it
   *   would make the authority pretend to be a principal it is not.
   * - D9 MODE (`declareInvocationIdentity: true`): the host declared that the
   *   dispatch and the settlement share one invocation, so it re-enters the
   *   identity the delivery captured (or the graph's own declaring invocation)
   *   for exactly this call and restores the ambient attribution afterwards.
   *   That window is also what arms the attempt's SUCCESSOR, so the dispatch it
   *   triggers names the same parent the entry attempt ran under.
   *
   * The bearer value is never recovered from anywhere but the host's own vault
   * (the bridge's contract), and this method adds no second place it could come
   * from. An attempt this host never dispatched stays unbound and is reported by
   * the bridge.
   */
  async complete(
    graphId: string,
    attemptId: string,
  ): Promise<HostCompletionReport> {
    const bridge = this.bridgeFor(graphId);
    const binding = bridge.bindingFor({ graphId, attemptId });
    if (this.declareInvocationIdentity) {
      const dispatchIdentity = binding?.dispatchIdentity ?? this.originIdentityOf(graphId);
      const previous = this.holder.current();
      if (dispatchIdentity !== undefined) this.holder.set(dispatchIdentity);
      try {
        // The settlement's own acceptance transaction wrote the run state to the
        // store, and the query paths read it from there: there is no second
        // durable record left to refresh.
        return await bridge.complete({ graphId, attemptId });
      } finally {
        if (previous === undefined) {
          this.holder.clear();
        } else {
          this.holder.set(previous);
        }
      }
    }
    // WORKER MODE. An attempt this host never delivered is the bridge's own
    // `unbound` report (unchanged); one it DID deliver must also have a
    // confirmed host execution before the authority settles anything.
    if (binding !== undefined) {
      let execution: HostExecutionIdentity | undefined;
      try {
        execution = this.executionBindingOf({ graphId, attemptId });
      } catch (error) {
        return Object.freeze({
          kind: "unbound" as const,
          attemptId,
          reason:
            "the host's execution record for this attempt could not be read (" +
            errorText(error) +
            "), so no confirmed host execution authenticates this completion — " +
            "nothing was written",
        });
      }
      if (execution === undefined) {
        return Object.freeze({
          kind: "unbound" as const,
          attemptId,
          reason:
            "this host delivered attempt " +
            JSON.stringify(attemptId) +
            " but holds no CONFIRMED host execution for it, so the completion has no " +
            "execution source to authenticate against — a delivery observation alone " +
            "is not a completion fact and nothing was written",
        });
      }
    }
    return bridge.complete({ graphId, attemptId });
  }

  /**
   * Give ONE declared graph its first execution, or continue it from the state
   * its ledger already holds.
   *
   * This is deliberately the runtime's own `resume`: a graph with no ledger
   * state is STARTED from the saved plan, a graph with one is continued, and
   * nothing is ever started twice for the same plan revision. The invocation is
   * put in effect for the synchronous dispatch window, so an attempt this call
   * arms records the declaring invocation's identity (D9) — and it is RECORDED
   * for the graph, so the successors this run arms later are dispatched under
   * the same invocation instead of the ambient one.
   *
   * A call that names no session (the sweep finding no recorded origin) records
   * nothing and arms attempts under no invocation: a dispatch the platform then
   * refuses is reported as the effect refusal it is, never attributed to a
   * guess.
   */
  async startDeclaredGraph(
    graphId: string,
    invocation: OutcomeHostInvocation = {},
  ): Promise<OutcomeResumeResult> {
    this.assertOpen();
    const { runtime, ledger } = await this.runtimeFor(graphId);
    this.rememberOrigin(graphId, invocation);
    // THE PLATFORM'S READINGS ARE PRIMED BEFORE THE SYNCHRONOUS WINDOW (P2
    // item 5 / F3). `resume` reconciles every unsettled effect and asks the
    // dispatch adapter — synchronously — whether an execution already exists for
    // it; a platform whose correlation read is asynchronous would have no answer
    // to give inside that window. Awaiting the port's `prime` here (with the
    // graph's own recorded origin, the parent the creates were made under) is
    // what makes the question answerable when it is asked. A platform without
    // `prime` needs nothing; a failed prime leaves every reading unset, which
    // answers `unknown` and blocks — never guesses.
    await this.primePlatformReadings(graphId, ledger, invocation);
    this.setInvocation(invocation);
    try {
      // The run advanced inside the acceptance transaction, which wrote the run
      // state to the store; the query paths read it from there.
      return runtime.resume(this.clock());
    } finally {
      this.holder.clear();
    }
  }

  /**
   * Ask the platform port to refresh its readings for this graph's UNSETTLED
   * dispatch effects, before the synchronous run path asks about them.
   *
   * THE PROBES COME FROM THE LEDGER, NOT FROM A CALLER. Every effect the
   * ledger still holds unsettled (`pending` or `started` — exactly the set
   * `resume` reconciles) is a question the run path is about to ask, and each
   * is named by the stable key its create carried plus the invocation that
   * create was handed. A graph with nothing unsettled asks nothing, and a
   * ledger that cannot be read primes nothing: the run path's own reconcile
   * reports that failure in its own words.
   */
  private async primePlatformReadings(
    graphId: string,
    ledger: SqliteAcceptanceLedger,
    invocation: OutcomeHostInvocation,
  ): Promise<void> {
    if (this.query?.prime === undefined) return;
    let effects: readonly PendingEffectRecord[];
    try {
      effects = ledger.pendingEffects(graphId);
    } catch {
      // The unreadable ledger is the run path's own report to make; priming
      // simply has nothing to ask about.
      return;
    }
    const origin =
      invocation.sessionId === undefined || invocation.sessionId.length === 0
        ? undefined
        : Object.freeze({
            sessionId: invocation.sessionId,
            ...(invocation.agent === undefined || invocation.agent.length === 0
              ? {}
              : { agent: invocation.agent }),
          });
    const probes: OutcomeExecutionProbe[] = [];
    for (const effect of effects) {
      if (effect.kind !== "dispatch") continue;
      probes.push(
        Object.freeze({
          effect: dispatchEffectKeyOf(graphId, effect.attemptId),
          ...(origin === undefined ? {} : { invocation: origin }),
        }),
      );
    }
    await this.dispatchAdapter.primePlatformReadings(probes);
  }

  /**
   * The boot sweep: every graph whose DEFINITION the workspace's store holds gets
   * the same first-execution/resume treatment as {@link startDeclaredGraph}, one
   * graph at a time. The definition row is the sweep's whole inventory — the
   * retired per-graph v2 container is never listed, never read and never
   * rewritten here, so an existing one cannot be resumed or started by a boot
   * (plan §3.6). A graph this host cannot open is reported, never rewritten; the
   * sweep never throws.
   */
  async recoverDeclaredGraphs(): Promise<OutcomeHostRecoveryReport> {
    this.assertOpen();
    const started: string[] = [];
    const resumed: string[] = [];
    const refused: string[] = [];
    const effectRefusals: OutcomeHostEffectRefusal[] = [];
    const divergences: (OutcomeEffectDivergence & { graphId: string })[] = [];
    const completed: string[] = [];
    const awaiting: OutcomeHostAwaitingCompletion[] = [];
    const inventory = this.declaredGraphInventory();
    for (const graphId of inventory.graphIds) {
      try {
        // The invocation this graph was declared under, when this host knows it
        // (in memory, or from its own record after a restart): a resumed graph
        // re-arms its pending effects, and the platform can only start them
        // under a parent. No recorded origin dispatches under none, and the
        // refusal that follows is reported — not guessed away.
        const origin = this.origins.get(graphId);
        const result = await this.startDeclaredGraph(graphId, origin ?? {});
        if (result.kind === "refused") {
          refused.push(
            graphId + ": " + result.refusals.map((r) => r.code).join(","),
          );
          continue;
        }
        if (result.kind === "started") {
          started.push(graphId + ":" + result.state.planRevision);
        } else {
          resumed.push(graphId + ":" + result.state.phase);
        }
        // A VISITED GRAPH STILL OWES ITS PER-EFFECT FACTS. Every effect the
        // resume would not launch and every row that contradicted the host is
        // carried into the report (and the log below), so "resumed" never hides
        // work that is still pending.
        for (const refusal of result.refusals) {
          effectRefusals.push(Object.freeze({ graphId, ...refusal }));
        }
        for (const divergence of result.divergences) {
          divergences.push(Object.freeze({ graphId, ...divergence }));
        }
        // ── RE-READ THE HOST'S TERMINAL STATE (P2 item 6) ───────────────────
        //
        // A resume re-establishes the binding for every attempt still in
        // flight, so a completion the platform announces LATER settles. An
        // execution that finished while no process was listening will never
        // announce itself again, so for each in-flight attempt the host can
        // name (its own confirmed record, or the platform's answer for the same
        // stable effect id — F2) it asks whether the execution is already over,
        // and a `completed` answer is settled idempotently through the same
        // acceptance core an announced completion uses. An unanswerable
        // question is REPORTED: never resumed-and-fine, never waited on
        // forever, and an execution that ENDED without its outcome is reported,
        // not fabricated into one.
        for (const node of result.armed) {
          const attemptId = node.attemptId;
          let execution: HostExecutionIdentity | undefined;
          try {
            execution = this.executionBindingOf({ graphId, attemptId });
          } catch (error) {
            effectRefusals.push(
              Object.freeze({
                graphId,
                code: "completion-unsettled" as const,
                path: "$.attemptId",
                message:
                  "outcome-host: the host's execution record for node " +
                  JSON.stringify(node.nodeId) +
                  " attempt " +
                  JSON.stringify(attemptId) +
                  " could not be read (" +
                  errorText(error) +
                  "), so whether that execution finished cannot be established — the attempt " +
                  "stays in flight and is reported rather than silently stranded",
              }),
            );
            continue;
          }
          if (execution === undefined) {
            // NO EXECUTION ANYBODY CAN NAME. `executionBindingOf` already asked
            // the platform's query port for the same stable effect id (F2), so
            // this is the case where the row never got the confirmation AND the
            // platform did not name one either: the resume above already
            // reported the effect (unsettled, credential-missing, divergence …),
            // and an attempt no fact names cannot be observed, settled, or
            // guessed about. The attempt stays in flight and is reported.
            continue;
          }
          const observation = this.observeExecutionOf(execution);
          if (observation.kind === "failed") {
            // THE EXECUTION ENDED WITHOUT REACHING ITS OUTCOME (plan §3.4): a
            // failed/cancelled/timed-out run is NOT a completion, and settling
            // one as the plan's pinned outcome would fabricate a result the run
            // never produced. The durable failure write is P3's command, so the
            // attempt is reported unsettled instead — never silently stranded,
            // and never settled on a fabricated success.
            effectRefusals.push(
              Object.freeze({
                graphId,
                code: "completion-unsettled" as const,
                path: "$.executionId",
                message:
                  "outcome-host: the platform reports host execution " +
                  JSON.stringify(execution.executionId) +
                  " of node " +
                  JSON.stringify(node.nodeId) +
                  " attempt " +
                  JSON.stringify(attemptId) +
                  " ENDED without reaching its authorized outcome (" +
                  observation.reason +
                  ") — it is NOT settled as a completion, and the durable failure " +
                  "decision belongs to the control path",
              }),
            );
            continue;
          }
          if (observation.kind === "running") {
            // STILL RUNNING, SO STILL LISTENED FOR (P2 item 6). The durable
            // binding above survives the restart, but nothing subscribes to the
            // execution the dead process was watching: naming it here is what
            // lets a host adapter re-subscribe (or keep re-querying) the
            // platform's own execution instead of waiting for an announcement
            // this process can no longer receive.
            awaiting.push(
              Object.freeze({
                graphId,
                nodeId: node.nodeId,
                attemptId,
                executionId: execution.executionId,
                ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
                status: "running" as const,
                reason:
                  "the platform reports host execution " +
                  JSON.stringify(execution.executionId) +
                  " still running, so its completion is awaited rather than settled",
              }),
            );
            continue;
          }
          if (observation.kind === "unknown") {
            // The fate of a CONFIRMED execution is unknown: it is reported as
            // unsettled AND named for the host to re-subscribe to, because
            // "cannot tell now" must not be rounded into "nothing to watch".
            awaiting.push(
              Object.freeze({
                graphId,
                nodeId: node.nodeId,
                attemptId,
                executionId: execution.executionId,
                ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
                status: "unknown" as const,
                reason: observation.reason,
              }),
            );
            effectRefusals.push(
              Object.freeze({
                graphId,
                code: "completion-unsettled" as const,
                path: "$.executionId",
                message:
                  "outcome-host: confirmed host execution " +
                  JSON.stringify(execution.executionId) +
                  " for node " +
                  JSON.stringify(node.nodeId) +
                  " attempt " +
                  JSON.stringify(attemptId) +
                  " could not be observed (" +
                  observation.reason +
                  ") — whether it already finished is UNKNOWN, so the attempt stays in " +
                  "flight and is reported instead of being settled on a guess",
              }),
            );
            continue;
          }
          const settlement = await this.complete(graphId, attemptId);
          if (settlement.kind === "settled" && settlement.settlement.kind !== "refused") {
            // The settlement RAN: accepted (committed or replayed), rejected by
            // a declared gate, or not-committed because another channel already
            // settled the attempt. All three are the acceptance core's own
            // answers, and the first one is why the sweep asked at all.
            completed.push(
              graphId + ":" + attemptId + ":" + settlement.settlement.kind,
            );
            continue;
          }
          // WHY IT COULD NOT SETTLE is carried verbatim from the bridge's own
          // report (or the runtime's own refusal codes), so the block is
          // diagnosable without re-running the sweep.
          const why =
            settlement.kind !== "settled"
              ? settlement.kind + ": " + settlement.reason
              : settlement.settlement.kind === "refused"
                ? "the settlement was refused: " +
                  settlement.settlement.refusals
                    .map((refusal) => refusal.code)
                    .join(",")
                : "the settlement did not run";
          effectRefusals.push(
            Object.freeze({
              graphId,
              code: "completion-unsettled" as const,
              path: "$.attemptId",
              message:
                "outcome-host: the platform reports host execution " +
                JSON.stringify(execution.executionId) +
                " of node " +
                JSON.stringify(node.nodeId) +
                " attempt " +
                JSON.stringify(attemptId) +
                " TERMINAL, but this host could not settle it (" +
                why +
                ") — the attempt stays unsettled and is reported",
            }),
          );
        }
      } catch (err) {
        refused.push(graphId + ": " + errorText(err));
      }
    }
    if (inventory.blocked !== undefined) {
      logWarn(
        "outcome-host: declared-graph sweep — the workspace store could not be read (" +
          inventory.blocked +
          "), so there was NO inventory to visit; this is a BLOCKED sweep, not an empty one",
      );
    }
    if (
      started.length > 0 ||
      resumed.length > 0 ||
      refused.length > 0 ||
      effectRefusals.length > 0 ||
      divergences.length > 0 ||
      completed.length > 0 ||
      awaiting.length > 0
    ) {
      logWarn(
        "outcome-host: declared-graph sweep — started=[" +
          started.join(", ") +
          "] resumed=[" +
          resumed.join(", ") +
          "] refused=[" +
          refused.join(", ") +
          "] effect-refusals=[" +
          effectRefusals
            .map((refusal) => refusal.graphId + ":" + refusal.code)
            .join(", ") +
          "] divergences=[" +
          divergences
            .map(
              (divergence) =>
                divergence.graphId +
                ":" +
                divergence.effectId +
                ":" +
                divergence.local +
                "->" +
                divergence.host,
            )
            .join(", ") +
          "] completed=[" +
          completed.join(", ") +
          "] awaiting=[" +
          awaiting
            .map((entry) => entry.graphId + ":" + entry.attemptId + ":" + entry.status)
            .join(", ") +
          "]",
      );
    }
    return Object.freeze({
      started: Object.freeze(started),
      resumed: Object.freeze(resumed),
      refused: Object.freeze(refused),
      effectRefusals: Object.freeze(effectRefusals),
      divergences: Object.freeze(divergences),
      completed: Object.freeze(completed),
      // THE EXECUTIONS THE HOST MUST KEEP LISTENING TO (P2 item 6): confirmed
      // and named by the platform's own id, so a host adapter can re-subscribe
      // or re-query instead of waiting for an announcement a restarted process
      // can no longer receive.
      awaitingCompletion: Object.freeze(awaiting),
      // A store the format gate refuses is a BLOCK, never an empty sweep: the
      // audit and the status surface already refuse it, and the boot sweep must
      // not answer "nothing to do" for the same workspace. A store that simply
      // does not exist yet is an empty sweep and sets nothing.
      ...(inventory.blocked === undefined ? {} : { storeBlocked: inventory.blocked }),
    });
  }

  /**
   * RE-ESTABLISH OBSERVATION FOR EVERY EXECUTION THE SWEEP IS STILL WAITING ON
   * (F4, P2 item 6).
   *
   * The sweep names each confirmed execution whose completion has not arrived in
   * {@link OutcomeHostRecoveryReport.awaitingCompletion}; this call is what
   * CONSUMES that inventory, and it is deliberately the entry's call rather than
   * something the sweep does to itself: a host adapter that re-subscribes owns
   * the platform channel, and the report says what it managed to establish.
   *
   * PER ENTRY, IN ORDER:
   *
   * 1. RE-SUBSCRIBE where the platform supports it — {@link
   *    OutcomeHostOptions.watchCompletion} asks the platform to announce the end
   *    of exactly this execution, and the callback settles the attempt through
   *    the SAME completion bridge an in-process announcement uses (one
   *    acceptance core, one listener mechanism, idempotent by the ledger).
   * 2. OTHERWISE RE-QUERY ON THE SAME RECOVERY WINDOW: the platform is asked
   *    once more whether the execution has ended, and a `completed` read is
   *    settled here and now, through the same bridge.
   * 3. ANYTHING ELSE IS REPORTED UNWATCHED, with the reason. An execution nobody
   *    can observe after this call is named in the report — the observable block
   *    the plan requires — never quietly forgotten, and the next boot sweep is
   *    the next time anything looks at it.
   *
   * A platform that reports the execution `failed` is reported, not settled:
   * see {@link HostExecutionObservation}.
   */
  async retainAwaitingCompletions(
    awaiting: readonly OutcomeHostAwaitingCompletion[],
    options: OutcomeHostWatchOptions = {},
  ): Promise<OutcomeHostWatchReport> {
    this.assertOpen();
    const watched: string[] = [];
    const settled: string[] = [];
    const unwatched: OutcomeHostUnwatchedExecution[] = [];
    for (const entry of awaiting) {
      if (this.watchFor(entry, options)) {
        watched.push(entry.graphId + ":" + entry.attemptId + ":" + entry.executionId);
        continue;
      }
      const execution: HostExecutionIdentity = Object.freeze({
        executionId: entry.executionId,
        ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      });
      const observation = this.observeExecutionOf(execution);
      if (observation.kind === "completed") {
        const settlement = await this.complete(entry.graphId, entry.attemptId);
        settled.push(
          entry.graphId + ":" + entry.attemptId + ":" + settlement.kind,
        );
        if (settlement.kind === "settled") {
          options.onSettled?.(entry.graphId, entry.attemptId);
        }
        continue;
      }
      unwatched.push(
        Object.freeze({
          graphId: entry.graphId,
          attemptId: entry.attemptId,
          executionId: entry.executionId,
          reason: describeUnwatched(entry, observation),
        }),
      );
    }
    if (unwatched.length > 0) {
      logWarn(
        "outcome-host: awaiting-completion re-subscribe — " +
          String(watched.length) +
          " watched, " +
          String(settled.length) +
          " settled from a terminal read, " +
          String(unwatched.length) +
          " WITHOUT an established observation ([" +
          unwatched
            .map((entry) => entry.graphId + ":" + entry.attemptId + ":" + entry.reason)
            .join(", ") +
          "]) — these executions stay named in the sweep's awaiting inventory and the next " +
          "recovery window is the next time anything looks at them",
      );
    }
    return Object.freeze({
      watched: Object.freeze(watched),
      settled: Object.freeze(settled),
      unwatched: Object.freeze(unwatched),
    });
  }

  /**
   * Ask the platform to announce the end of one awaited execution, or say it
   * cannot.
   *
   * A port that THROWS has not established anything: the failure is reported as
   * unwatched by the caller (the caller's own observation read then supplies the
   * reason), and no settlement is faked.
   */
  private watchFor(
    entry: OutcomeHostAwaitingCompletion,
    options: OutcomeHostWatchOptions,
  ): boolean {
    const watch = this.watchCompletion;
    if (watch === undefined) return false;
    try {
      return (
        watch(entry, () => {
          void this.settleWatchedCompletion(entry, options);
        }) === "watching"
      );
    } catch (error) {
      logWarn(
        "outcome-host: the platform completion-watch port threw for execution " +
          JSON.stringify(entry.executionId) +
          " of graph " +
          JSON.stringify(entry.graphId) +
          " — the execution is reported as unwatched rather than treated as covered (" +
          describeWatchFailure(error) +
          ")",
      );
      return false;
    }
  }

  /**
   * Settle the attempt whose execution the platform announced as ended.
   *
   * THE ONE COMPLETION PATH. This is the bridge an in-process announcement
   * already feeds, so the settlement is authenticated, idempotent and
   * credential-free exactly like every other observed completion; a second
   * announcement replays the receipt. A refusal is reported, never swallowed.
   */
  private async settleWatchedCompletion(
    entry: OutcomeHostAwaitingCompletion,
    options: OutcomeHostWatchOptions,
  ): Promise<void> {
    try {
      const report = await this.complete(entry.graphId, entry.attemptId);
      if (report.kind === "settled") {
        options.onSettled?.(entry.graphId, entry.attemptId);
      }
      logWarn(
        "outcome-host: the platform announced execution " +
          JSON.stringify(entry.executionId) +
          " of graph " +
          JSON.stringify(entry.graphId) +
          " attempt " +
          JSON.stringify(entry.attemptId) +
          " ended; the settlement report is " +
          report.kind +
          (report.kind === "settled" ? " (" + report.settlement.kind + ")" : ""),
      );
    } catch (error) {
      logWarn(
        "outcome-host: the platform announced execution " +
          JSON.stringify(entry.executionId) +
          " of graph " +
          JSON.stringify(entry.graphId) +
          " attempt " +
          JSON.stringify(entry.attemptId) +
          " ended, but the settlement threw (" +
          describeWatchFailure(error) +
          ") — the attempt stays unsettled and is reported",
      );
    }
  }

  /**
   * The execution the PLATFORM names for one attempt, or `undefined`.
   *
   * Asked through the host's own dispatch adapter, which joins the local
   * registry with the platform port and caches the platform's answer (F2). This
   * is what lets an attempt whose durable row never got the confirmation be
   * observed, named in `awaitingCompletion` and authenticated for a completion
   * — the SAME execution the platform created, never a second one.
   */
  private platformNamedExecutionOf(
    graphId: string,
    attemptId: string,
  ): HostExecutionIdentity | undefined {
    const key = dispatchEffectKeyOf(graphId, attemptId);
    const answer = this.dispatchAdapter.lookup(key);
    return answer.kind === "created" ? answer.execution : undefined;
  }

  /**
   * Bind a tool face to this host's invocation attribution: every call puts the
   * host's attribution of THAT invocation in effect for the call's duration and
   * clears it after (D9).
   */
  bindTools(
    tools: Record<string, CanonicalToolDef>,
    getEffectiveAgent?: (sessionID?: string) => string,
  ): Record<string, CanonicalToolDef> {
    return bindOutcomeToolInvocation(tools, {
      holder: this.holder,
      workerSession: this.workerSessions,
      ...(getEffectiveAgent === undefined ? {} : { getEffectiveAgent }),
    });
  }

  /**
   * Record the host execution the platform confirmed for one effect.
   *
   * The platform adapter calls this as soon as it learns the platform's own
   * execution/task id, which is what turns the registry row from `creating`
   * (result unknown) into `created` (a host fact). A host that never calls it
   * leaves the effect `unknown` — reported as unsettled, never re-dispatched.
   */
  confirmExecution(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): boolean {
    return this.executions.confirm(effect, execution);
  }

  /**
   * Report a delivery that failed asynchronously: whether an execution was
   * created is UNKNOWN, so this host's claim is KEPT.
   *
   * An asynchronous rejection, a callback that never arrives and a timeout
   * prove nothing about a request the platform may already have received. The
   * proof-less release is therefore deliberate: the row stays `creating`, the
   * failure is recorded on it as an `unproven-failure` refusal, and every later
   * lookup answers `unknown` — a recovery reports the effect as unresolved and
   * refuses a blind second create. Only a PROVEN not-created (a synchronous
   * delivery refusal, or the platform's own execution query answering
   * `absent`) releases the create right.
   */
  reportDeliveryFailure(effect: OutcomeDispatchEffectKey, reason: string): void {
    this.executions.release(effect, this.executions.ownerId);
    logWarn(
      "outcome-host: delivery failed for graph " +
        JSON.stringify(effect.graphId) +
        " effect " +
        JSON.stringify(effect.effectId) +
        " — no execution can be PROVEN absent, so the create right is KEPT (the row stays " +
        "'creating', every lookup answers 'unknown', and the effect is reported as unresolved " +
        "rather than re-dispatched): " +
        reason,
    );
  }

  /** Release every open ledger handle. The host is inert afterwards. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.runtimes.values()) {
      void pending.then(
        ({ ledger }) => {
          try {
            ledger.close();
          } catch {
            // Closing an already-closed handle is not a host failure.
          }
        },
        () => {},
      );
    }
    this.runtimes.clear();
    this.bridges.clear();
    // The memory-mode capabilities share ONE private store; releasing it here
    // is what keeps the host's process-only records from outliving the host.
    // In file mode the capabilities own their own connections, exactly as the
    // per-graph ledgers above do, and closing them is not this call's job.
    try {
      this.sharedStore?.close();
    } catch {
      // Closing an already-closed store is not a host failure.
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Record the declaring invocation a graph's dispatches belong to.
   *
   * A call that names no session records nothing: "no origin" is a fact about
   * this host's knowledge, and a placeholder would turn it into a false
   * attribution. A later call that DOES name a session replaces the record —
   * the newer invocation is the one actually running the graph.
   */
  private rememberOrigin(
    graphId: string,
    invocation: OutcomeHostInvocation,
  ): void {
    const sessionId = invocation.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    this.origins.record(
      graphId,
      invocation.agent === undefined || invocation.agent.length === 0
        ? { sessionId }
        : { sessionId, agent: invocation.agent },
    );
  }

  /** The platform invocation this graph's dispatches run under, if known. */
  private originOf(graphId: string): HostDispatchInvocation | undefined {
    const origin = this.origins.get(graphId);
    if (origin === undefined) return undefined;
    return Object.freeze({
      sessionId: origin.sessionId,
      ...(origin.agent === undefined ? {} : { agent: origin.agent }),
    });
  }

  /** The same origin as the D9 identity shape, or `undefined` when unreadable. */
  private originIdentityOf(graphId: string) {
    const origin = this.origins.get(graphId);
    if (origin === undefined) return undefined;
    return hostInvocationIdentity(origin.sessionId, origin.agent);
  }

  /**
   * The CONFIRMED execution of one attempt: the host's durable record, or the
   * execution the PLATFORM names for the same stable effect id (F2).
   *
   * A row is a host execution when the platform confirmed it — state `created`
   * carries the platform's real id, and the store's own CHECK makes "created
   * without an id" unrepresentable. A `pending`/`creating` row is NOT that
   * record: this host never saw the confirmation. It is not proof that no
   * execution exists, though, and reading it as such is exactly the W4 strand —
   * so the platform's own query port is asked the same stable question, and its
   * answer (a READING, cached per process, never a rewrite of the fenced row) is
   * the attempt's execution. A completion settled against a guess is still
   * impossible: the only two sources are the fenced durable row and the
   * platform's own named answer, and the completion envelope must name the SAME
   * execution.
   */
  private executionBindingOf(attempt: {
    readonly graphId: string;
    readonly attemptId: string;
  }): HostExecutionIdentity | undefined {
    const key = dispatchEffectKeyOf(attempt.graphId, attempt.attemptId);
    const row = this.executions.read(key);
    if (row !== undefined && row.attemptId === attempt.attemptId) {
      if (row.state === "created" && row.execution !== undefined) return row.execution;
    }
    // THE PLATFORM'S OWN NAME, WHEN THE ROW NEVER GOT THE CONFIRMATION (F2).
    // The durable row is the host's record of what IT created, and a row that is
    // still `creating` because the confirmation was lost does not stop the
    // platform from having created the execution. Asking the platform's query
    // port — the SAME stable question, the same answer any process gets — is
    // what lets the W4 window's attempt be observed, named and authenticated
    // instead of stranded. It is a READING of the platform's fact, never a
    // rewrite of the fenced row, and it is what the sweep and the worker binding
    // both read.
    return this.platformNamedExecutionOf(attempt.graphId, attempt.attemptId);
  }

  /**
   * What this host confirmed it dispatched one attempt AS — the binding a
   * worker submission is checked against.
   *
   * THE TWO FACTS AND WHERE THEY COME FROM. The real execution/task id is the
   * durable record's own; the child session is derived from it by the
   * platform-specific {@link OutcomeHostOptions.workerSessionOf}, which the
   * shipped entries supply (dsh publishes the child session as the run id, Pi
   * returns the dispatch task's session). Neither is supplied by the caller of
   * a tool: a submission can present a credential, never its own binding.
   *
   * `undefined` means "not bound" — no confirmed execution, or a platform that
   * cannot name the session it created — and the ingress refuses rather than
   * falling back to a session-only or credential-only check.
   */
  private workerBindingOf(attempt: HostWorkerAttemptRef): HostWorkerBinding | undefined {
    const execution = this.executionBindingOf(attempt);
    if (execution === undefined) return undefined;
    const workerSessionId = this.workerSessionOf?.(execution);
    if (workerSessionId === undefined || workerSessionId.length === 0) return undefined;
    return Object.freeze({
      graphId: attempt.graphId,
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
      executionId: execution.executionId,
      ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
      workerSessionId,
    });
  }

  /** The per-graph completion bridge, created on first use. */
  private bridgeFor(graphId: string): HostDispatchCompletionBridge {
    const existing = this.bridges.get(graphId);
    if (existing !== undefined) return existing;
    const bridge = new HostDispatchCompletionBridge({
      runtime: () => this.runtimeFor(graphId).then(({ runtime }) => runtime),
      credentials: this.vault,
      clock: this.clock,
      // THE DURABLE HALF OF THE BINDING (P2 item 6). This process's map holds
      // what IT delivered; the store holds what the HOST delivered, before and
      // after a restart.
      bindings: {
        resolve: (attempt: HostCompletionAttempt) => this.durableBindingOf(attempt),
      },
      // THE HOST'S OWN EXECUTION RECORD (P2 item 7): the fact a completion is
      // authenticated against when no bearer value survives the restart.
      executions: {
        executionFor: (attempt: HostCompletionAttempt) =>
          this.executionBindingOf(attempt),
      },
    });
    this.bridges.set(graphId, bridge);
    return bridge;
  }

  /**
   * The graph's outcome runtime over its PERSISTED plan, opened once per graph
   * and kept for the process lifetime (the completion bridge and the declaration
   * seam share it). The loader is the same one the submission ingress uses, so a
   * record that is not this build's outcome-protocol state is refused instead of
   * being run approximately.
   */
  private runtimeFor(graphId: string): Promise<RunningGraphRuntime> {
    const existing = this.runtimes.get(graphId);
    if (existing === undefined) {
      const pending = this.openRuntime(graphId);
      this.runtimes.set(graphId, pending);
      return pending;
    }
    // THE CACHE IS VALIDATED AGAINST THE STORE ON EVERY USE (G14).
    //
    // A runtime is opened once per graph and kept, because a settlement needs
    // the graph's own saved plan. The plan is not the only thing that can
    // change: the DEFINITION ROW can become unreadable after this process
    // cached its runtime, and continuing to run from the cached plan would make
    // the boot sweep answer RESUMED from a plan the audit and the status
    // surface both refuse — the same graph reported three different ways. So
    // the durable definition is re-read here, before the cached runtime is
    // handed to any caller, and a definition that no longer reads (or no longer
    // names the same content) refuses by name instead.
    return existing.then((entry) => {
      this.assertDefinitionCurrent(graphId, entry);
      return entry;
    });
  }

  /**
   * Refuse when the definition the workspace store holds is no longer the one
   * the cached runtime was opened from.
   *
   * TWO FAILURES, ONE RULE — the cached plan is used only while the store still
   * corroborates it:
   * - the row no longer reads at all (damaged, refused by the decoder, or the
   *   store itself unreadable): the graph is BLOCKED, exactly as the audit and
   *   the status surface report it;
   * - the row reads but names different content: a definition a run may be
   *   executing is never replaced in place (`GraphStore.writeDefinition`
   *   preserves an unchanged one and refuses a changed one), so this is a
   *   foreign writer or corruption, and it is refused rather than run.
   */
  private assertDefinitionCurrent(
    graphId: string,
    entry: RunningGraphRuntime,
  ): void {
    const reading = readStoredDefinition(this.storeRoot, graphId);
    if (reading.kind !== "ok") {
      throw new Error(
        "outcome-host: the stored definition of graph " +
          JSON.stringify(graphId) +
          " is no longer readable in " +
          this.storeRoot +
          " (" +
          describeStoredReading(reading) +
          ") — the run path this process opened for it is STALE, and nothing is started, " +
          "resumed or settled from a plan the store no longer corroborates",
      );
    }
    const declared = reading.declared;
    if (
      declared.declarationDigest !== entry.declarationDigest ||
      declared.plan.planRevision !== entry.planRevision
    ) {
      throw new Error(
        "outcome-host: the stored definition of graph " +
          JSON.stringify(graphId) +
          " changed after this process opened its run path (declaration " +
          JSON.stringify(entry.declarationDigest) +
          " -> " +
          JSON.stringify(declared.declarationDigest) +
          ", plan revision " +
          JSON.stringify(entry.planRevision) +
          " -> " +
          JSON.stringify(declared.plan.planRevision) +
          ") — a definition a run may be executing is never replaced in place, so the " +
          "cached run path is refused rather than used",
      );
    }
  }

  private async openRuntime(graphId: string): Promise<RunningGraphRuntime> {
    const reading = readStoredDefinition(this.storeRoot, graphId);
    if (reading.kind !== "ok") {
      throw new Error(
        "outcome-host: graph " +
          JSON.stringify(graphId) +
          " has no readable stored definition in " +
          this.storeRoot +
          " (" +
          describeStoredReading(reading) +
          ") — a declared graph is dispatched only from its SAVED plan, and the " +
          "retired per-graph v2 container is never read as one",
      );
    }
    const plan = reading.declared.plan;
    const ledger = await SqliteAcceptanceLedger.create(this.storeRoot);
    const runtime = new OutcomeGraphRuntime({
      plan,
      ledger,
      dispatch: this.dispatchAdapter,
      // THE CREATE-RIGHT FENCE (P2 §3.3): a lost credential is re-issued only
      // while this host holds the store's own create right for the effect, so
      // a second recoverer cannot replace the verifier of the attempt this
      // process is about to dispatch.
      reissueFence: this.reissueFence,
      validators: this.validators,
      artifactRoot: this.artifactRoot,
      clock: this.clock,
      credentialIsolation: this.credentialIsolation,
      ...(this.declareInvocationIdentity
        ? { hostIdentity: this.hostIdentity }
        : {}),
      ...(this.completionPolicies === undefined
        ? {}
        : { completionPolicies: this.completionPolicies }),
      // THE HOST'S COMPLETION AUTHORITY (P2 item 7). It is installed
      // unconditionally — it is the host's own durable record, and the only
      // thing it enables is the completion channel that would otherwise refuse
      // by name.
      hostCompletions: this.completionAuthority,
    });
    return {
      runtime,
      ledger,
      declarationDigest: reading.declared.declarationDigest,
      planRevision: reading.declared.plan.planRevision,
    };
  }

  /**
   * The sweep's inventory: every graph id the workspace's store holds an
   * immutable DEFINITION for, plus why there is none when the store itself was
   * refused.
   *
   * The definition row is what makes a graph declared (P1 item 5), so the store
   * is the sweep's own listing. A store the FORMAT GATE refuses must not read as
   * "no graphs exist": the audit and the status surface report that workspace as
   * blocked, and a sweep that answered "nothing to do" would be the third
   * surface disagreeing. Only a store that does not exist yet (or a workspace
   * with no definitions) is an empty sweep.
   */
  private declaredGraphInventory(): {
    readonly graphIds: readonly string[];
    readonly blocked?: string;
  } {
    const loaded = loadGraphStoreSync(this.storeRoot);
    if (loaded.kind !== "valid") {
      return Object.freeze({
        graphIds: Object.freeze([]),
        ...(loaded.kind === "absent"
          ? {}
          : { blocked: describeStoreVerdict(loaded) }),
      });
    }
    try {
      return Object.freeze({
        graphIds: Object.freeze([...loaded.value.definitionGraphIds()]),
      });
    } finally {
      loaded.value.close();
    }
  }

  /**
   * The binding of one attempt, read from the host's DURABLE record (P2 item 6).
   *
   * THE DURABLE FACTS, AND NOTHING ELSE. The host's execution row is keyed by
   * the stable effect id derived from the attempt (`dispatch:<attemptId>`) and
   * names the attempt it belongs to; the dispatch EFFECT the run committed
   * carries the node the attempt executes. Both are rows in the workspace's ONE
   * store, so a completion observed after a restart resolves exactly the
   * (graph, node, attempt) binding the delivering process recorded — no attempt
   * id is parsed for structure and no node's current attempt is substituted.
   *
   * `undefined` is the honest answer for every missing half: no row, a row that
   * names another attempt, an effect payload this build cannot read as a
   * dispatch target, or a store that cannot be opened. The caller reports the
   * completion as UNBOUND rather than inventing a binding.
   */
  private durableBindingOf(
    attempt: HostCompletionAttempt,
  ): HostAttemptBinding | undefined {
    // A memory-mode host keeps its bindings in the bridge's own map — that IS
    // its durable record for the process — so there is no file to read.
    const loaded = loadGraphStoreSync(this.storeRoot);
    if (loaded.kind !== "valid") return undefined;
    const store = loaded.value;
    try {
      const effectId = dispatchEffectIdOf(attempt.attemptId);
      const row = store.readExecution({
        graphId: attempt.graphId,
        effectId,
        attemptId: attempt.attemptId,
      });
      if (row === undefined || row.attemptId !== attempt.attemptId) return undefined;
      // THE NODE COMES FROM THE DISPATCH RECORD while the effect is
      // outstanding, and from the recorded RUN STATE once it is terminal: a
      // settled attempt's effect row is DONE and is deliberately not part of
      // the "unsettled work" stream, so a repeated completion observation would
      // otherwise lose a binding it had a moment ago. Both sources are rows in
      // the SAME store, and the runtime re-checks the node/attempt pair against
      // the state it settles, so neither can re-aim a completion.
      const nodeId =
        this.dispatchNodeOf(store, attempt.graphId, effectId, attempt.attemptId) ??
        this.recordedNodeOf(store, attempt.graphId, attempt.attemptId);
      if (nodeId === undefined) return undefined;
      return Object.freeze({
        graphId: attempt.graphId,
        nodeId,
        attemptId: attempt.attemptId,
      });
    } catch {
      return undefined;
    } finally {
      store.close();
    }
  }

  /**
   * The node one dispatch effect names, read from its persisted payload.
   *
   * The payload is the credential-free dispatch target the run path wrote, so
   * its `nodeId` is runtime provenance; the attempt it names must be the one
   * asked about, or the row is not this attempt's dispatch and answers
   * `undefined`. Nothing here trusts a shape it cannot verify: a payload that
   * is not a record, or carries no non-empty `nodeId`, is not a target.
   */
  private dispatchNodeOf(
    store: GraphStore,
    graphId: string,
    effectId: string,
    attemptId: string,
  ): string | undefined {
    for (const effect of store.pendingEffects(graphId)) {
      if (effect.effectId !== effectId) continue;
      const payload = effect.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return undefined;
      }
      const record = payload as Record<string, unknown>;
      if (record.attemptId !== attemptId) return undefined;
      const nodeId = record.nodeId;
      return typeof nodeId === "string" && nodeId.length > 0 ? nodeId : undefined;
    }
    return undefined;
  }

  /**
   * The node the recorded RUN STATE attributes one attempt to, or an absent
   * answer.
   *
   * A DEFENSIVE SCAN OF A ROW THIS BUILD WROTE, not a decoder: the binding only
   * needs the node id an entry carries beside the attempt, and a body that is
   * not a record, carries no node list, or names the SAME attempt on more than
   * one node is not an answer. Nothing here decides whether the attempt settled
   * — the runtime does, against the state it settles — so a body that disagrees
   * with the deployment's expectation is refused there rather than trusted
   * here.
   */
  private recordedNodeOf(
    store: GraphStore,
    graphId: string,
    attemptId: string,
  ): string | undefined {
    const record = store.readGraphState(graphId);
    const body = record?.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return undefined;
    }
    const nodes = (body as Record<string, unknown>)["nodes"];
    if (!Array.isArray(nodes)) return undefined;
    let found: string | undefined;
    for (const entry of nodes) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const node = entry as Record<string, unknown>;
      if (node["attemptId"] !== attemptId) continue;
      const nodeId = node["nodeId"];
      if (typeof nodeId !== "string" || nodeId.length === 0) return undefined;
      // TWO NODES ON ONE ATTEMPT IS NOT A BINDING — it is an ambiguity, and an
      // ambiguous answer is reported rather than resolved by list order.
      if (found !== undefined && found !== nodeId) return undefined;
      found = nodeId;
    }
    return found;
  }

  /**
   * Ask the platform about one CONFIRMED execution, or say why it could not be
   * asked.
   *
   * A THROWING PORT HAS NOT ANSWERED: a port that fails is reported as
   * `unknown` — the same rule the dispatch adapter applies to a throwing
   * execution query — so an unreachable control plane never becomes "it must
   * still be running" and never becomes a fabricated completion. The reason is
   * host-authored text about a QUESTION, and no credential is in scope here:
   * the port receives the host's own confirmed execution id and nothing else.
   */
  private observeExecutionOf(execution: HostExecutionIdentity): HostExecutionObservation {
    const observe = this.observeExecution;
    if (observe === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "this host installs no platform execution-observation port, so it cannot tell " +
          "whether an execution that finished while no process was listening has ended",
      });
    }
    try {
      return observe(execution);
    } catch (error) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: "the platform execution-observation port threw (" + errorText(error) + ")",
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("outcome-host: this host has been closed");
    }
  }
}

// ── Tool attribution ────────────────────────────────────────────────────────

/** How the host resolves the acting agent for one tool invocation. */
export interface OutcomeToolAttribution {
  /** The host's invocation holder (D9). */
  readonly holder: HostInvocationHolder;
  /**
   * The holder for the session THIS call arrives from — the worker side of the
   * identity model. Moved with the invocation holder from the same platform
   * context, and read by {@link OutcomeHost.workerIdentity} SYNCHRONOUSLY: the
   * submission ingress captures the answer in the call's own prologue (before
   * its first await) and corroborates it with the session the tool face threads
   * from the same context. Omitting it leaves the declared worker binding
   * unable to name the session a submission arrives from, and such a
   * submission is refused rather than settled on its credential alone.
   */
  readonly workerSession?: HostWorkerSessionHolder;
  /** Platform acting-agent resolver (`context.agent` wins when populated). */
  readonly getEffectiveAgent?: (sessionID?: string) => string;
}

/**
 * Bind the outcome tool face to the host's invocation holder: every call puts
 * the host's attribution of THIS invocation in effect for the duration of the
 * call and clears it after. The same platform context also moves the worker
 * session holder, which the submission ingress CAPTURES in the call's own
 * synchronous prologue: the check that settles a submission therefore reads a
 * per-call capture, never a holder a concurrent call could have overwritten
 * (the dispatch that arms an attempt still reads the invocation holder inside
 * its own synchronous window).
 */
export function bindOutcomeToolInvocation(
  tools: Record<string, CanonicalToolDef>,
  attribution: OutcomeToolAttribution,
): Record<string, CanonicalToolDef> {
  const bound: Record<string, CanonicalToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    bound[name] = withInvocation(def, attribution);
  }
  return bound;
}

/** The erased argument type one canonical tool's execute receives. */
type ToolExecute = CanonicalToolDef["execute"];
type ToolExecuteArgs = Parameters<ToolExecute>[0];

function withInvocation(
  def: CanonicalToolDef,
  attribution: OutcomeToolAttribution,
): CanonicalToolDef {
  const inner = def.execute;
  return {
    ...def,
    async execute(args: unknown, context: CanonicalToolContext) {
      const agent =
        context?.agent && context.agent.length > 0
          ? context.agent
          : (attribution.getEffectiveAgent?.(context?.sessionID) ?? "");
      attribution.holder.set(hostInvocationIdentity(context?.sessionID, agent));
      // THE WORKER SIDE, FROM THE SAME PLATFORM CONTEXT. The session is taken
      // RAW — the D9 pair needs an agent too, while the worker binding is the
      // session the platform itself attributes the call to. An empty/absent
      // session clears the holder, and a submission under no session is refused
      // by name rather than settled on its credential alone. The ingress
      // captures this answer in the call's own synchronous prologue; the holder
      // is never read across an await on the submission path.
      attribution.workerSession?.set(context?.sessionID);
      try {
        return await inner(args as ToolExecuteArgs, context);
      } finally {
        attribution.holder.clear();
        attribution.workerSession?.clear();
      }
    },
  };
}

/**
 * Why one awaited execution could not be watched (F4), in the platform's own
 * words when it has any: a running execution has nothing more to say, a failed
 * one says how it ended, and an unanswerable one carries its reason.
 */
function describeUnwatched(
  entry: OutcomeHostAwaitingCompletion,
  observation: HostExecutionObservation,
): string {
  if (observation.kind === "failed") {
    return (
      "the platform reports this execution ENDED without reaching its authorized outcome (" +
      observation.reason +
      "), so there is nothing left to watch and the durable failure decision belongs to the " +
      "control path"
    );
  }
  if (observation.kind === "running") {
    return (
      "the platform reports this execution still running and offers no watch to re-establish " +
      "for it in this process, so it stays in the sweep's awaiting inventory"
    );
  }
  if (observation.kind === "completed") {
    // Unreachable through retainAwaitingCompletions (a completed read settles),
    // kept total so the wording never falls through to the unknown branch.
    return "the platform reports this execution COMPLETE";
  }
  return (
    "the platform cannot say whether this execution has ended (" +
    observation.reason +
    "), so no observation is established and the attempt stays unsettled"
  );
}

/**
 * One caught value from the watch channel, described without quoting a platform
 * message wholesale: the watch port is handed an execution id and no
 * credential, and its failure is a diagnostic — not a channel for arbitrary
 * host text.
 */
function describeWatchFailure(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
