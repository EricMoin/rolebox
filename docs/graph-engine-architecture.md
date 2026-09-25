# Graph engine architecture

The Graph engine executes declared multi-agent workflows for a host session. A
graph is authored as data, compiled into an immutable plan, then advanced one
attempt at a time: each node dispatches a worker, and each node settles only when
one of its declared outcomes has passed the acceptance gates the plan pins. This
page orients a reader in the system's parts and the boundaries between them. The
binding details are in the [protocol reference](graph-outcome-protocol.md) and the
operator-facing configuration is in the [operations guide](graph-v3-operations.md).

## The pipeline

Work moves through one direction: declaration to compiled plan to run to attempt
to proposal to acceptance to effects. A declaration is parsed and compiled once;
the resulting plan is the only topology authority the run path reads. A run mints
attempts, a worker proposes an outcome for its own attempt, acceptance judges the
proposal against the plan's pinned gates, and the decision commits with the graph
state in a single transaction. Effects — dispatch intents and notifications —
are durable rows committed with that state and delivered only afterwards.

## Responsibilities

| Responsibility | Component |
| --- | --- |
| Declaration parsing, capability preflight, compilation | The compiler: the v3 declaration reader, the structural guard, the capability-set resolver and the plan builder |
| Topology authority | The immutable compiled plan, carrying canonical node/edge/loop order, pinned acceptance requirements, contract bindings, completion authorizations and terminal outcomes |
| State transitions | The outcome runtime's pure reducer: node-status transitions, arrival materialization, join evaluation (`all`, `any`, `quorum`) and loop progress comparison |
| State shape | The outcome state model, its versioned body layouts and the strict state codec |
| Acceptance and effect orchestration | The acceptance core and the outcome runtime |
| Trusted controls and approvals | The control application service with its stop, retry and approval commands |
| Host ports | The dispatch adapter, the execution index and identity binding, the credential vault, the completion bridge and the delivery path |
| Durable business state | The SQLite graph store and its ledger tables, rooted in one workspace store |
| Shared read model | The graph query view, its renderer and the read-only drain audit |
| Assembly and entry points | `GraphApplication`, and the pi and dsh host entry points that register the canonical tools |

## Host and kernel boundary

A host installs ports; the kernel owns policy.

| The host supplies | The kernel owns |
| --- | --- |
| Dispatch delivery and the platform's child-session start | The compiler and its capability preflight |
| Session identity and the declaring invocation | The state reducer, joins and loop progress |
| Execution observation, cancellation and lifecycle hooks | The control application service |
| The validator and completion-policy capabilities, the artifact root, the credential store and the approval policy | The ledger, the store and the single commit boundary |
| The worker tool face it presents to a child | The read model, the audit and the tools' semantics |

A host never supplies a second scheduler, a second store or a second read model,
and the kernel never starts an execution on its own: dispatch is a durable intent
first, and the platform is asked to start a worker only once that intent exists.

## Trust boundaries

| Principal | What it may do |
| --- | --- |
| Declaring session | Declare graphs, start and resume runs, issue every control command, raise approval requests, and read the shared read model |
| Dispatched worker | Submit an outcome for its own attempt with the credential it was handed; run commands inside its platform sandbox where the host provides one |
| Approver | Decide the one approval request that names it, while the policy that authorized it is still installed |
| Host process | Install capabilities and policy, dispatch workers, report execution facts, and corroborate completion |

Three rules hold across those boundaries. A declaration can request a capability
identity but never grant one; only the host installs capabilities. A worker's
payload is data, never authority: it cannot route the graph, satisfy an approval,
forge budget usage or choose a plan revision. And every identity the protocol
compares — a plan revision, a validator version, a contract or policy revision, a
storage format — is matched exactly, never by ordering or by "latest".
