# Graph outcome protocol — target architecture

Status: PARTIALLY IMPLEMENTED. This document specifies the target architecture
and records, section by section, what this build already does and what it does
not. The current boundary is stated under "Implementation status" below; a
section describing proposed modules or fields is not a claim that they exist.

## Implementation status

IMPLEMENTED AND COVERED BY TESTS (the protocol-2 outcome path):

- compilation and plan pinning, including the closed progress-policy grammar and
  the natural-completion authorization pinned by exact policy revision and
  content digest (`src/graph/compiler/**`, `src/graph/policy/**`);
- versioned loading: the storage-format capability registry, the
  execution-protocol registry, and state-body readers for versions 1 to 6, with
  an unsupported identity refused before anything hydrates
  (`src/graph/persistence/storage-format.ts`,
  `src/graph/protocol/execution-protocol.ts`,
  `src/graph/outcome/graph-state.ts`);
- runtime-issued scoped attempt credentials and the submission check that binds
  a submission to the attempt it was dispatched for
  (`src/graph/outcome/attempt-credential.ts`);
- credential isolation as the outcome run path's ENABLEMENT CONDITION: the run
  path refuses to start, resume or settle anything, and the submission ingress
  and the startup sweep refuse before opening a ledger, unless a host-injected
  capability declares a protected credential store and per-attempt delivery
  (`src/graph/outcome/credential-isolation.ts`, D7);
- the submission and acceptance core: proposal shape gate, the closed validator
  registry with the artifact-reference validator, receipt replay, and the atomic
  commit of receipt, accepted event, state and pending effects
  (`src/graph/outcome/proposal.ts`, `acceptance.ts`, `validators.ts`);
- the unified dispatch-effect executor (D8): the intent of a first dispatch, a
  successor dispatch and a restart recovery is one durable effect committed with
  the state it belongs to, executed through a host adapter that creates the
  execution and answers whether one already exists
  (`src/graph/outcome/dispatch-effects.ts`, `runtime.ts`, `recovery.ts`);
- host invocation identity as an ADDITIONAL constraint on top of the bearer
  credential (D9): a host that declares `{ version, id, current() }` gets the
  identity of the dispatching invocation recorded on the attempt's own state
  entry (state-body version 7), and a submission that settles that attempt must
  come from the same host attribution — a mismatch, an absent identity or an
  unreadable declaration is refused by name and writes nothing
  (`src/graph/outcome/host-identity.ts`, `graph-state.ts`, `runtime.ts`);
- restart reconciliation that REPORTS its disagreements (D9): every effect whose
  persisted local status and the host's fact about the same stable id contradict
  each other is named in `divergences` with what recovery did about it — never a
  blind re-dispatch and never a silent drop (`runtime.ts`, `recovery.ts`,
  `engine/engine-startup.ts`);
- the durable STOP: hard-limit exhaustion and the declared progress-stalled
  policy end the run inside the same transaction that accepts the outcome
  (`src/graph/outcome/progress.ts`, `graph-state.ts`);
- natural-completion AUTHORIZATION as a run precondition: a plan that pins a
  policy revision this host did not install never starts, resumes or settles
  (`src/graph/policy/completion-policy.ts`, `src/graph/outcome/runtime.ts`);
- the natural-completion SETTLEMENT run path (`settleNatural`): a STRICTLY
  closed completion-fact envelope (the node, the attempt, and that attempt's
  bearer credential — no outcome, no payload, no evidence), the settled outcome
  resolved from the plan's pinned authorization, the outcome's declared
  acceptance gates run through the SAME registry, and the settlement committed
  through the SAME atomic receipt/event/state/effects transaction a submission
  uses; the channel's provenance is a namespaced content-addressed submission
  key (`natural-completion:<digest>`) persisted in the receipt and the accepted
  event, so a repeated delivery replays the first receipt and a worker's claimed
  submission can never wear the natural label
  (`src/graph/outcome/natural-completion.ts`, `runtime.ts`);
- the REPLAY ANSWER is the persisted receipt's decision, on BOTH channels: a
  repeated delivery or submission of the same content re-evaluates the declared
  gates for the record but cannot overturn a persisted rejection into an
  acceptance (or the reverse), and it reports the state the settlement left
  behind — never an advance the transaction did not write
  (`src/graph/outcome/runtime.ts`);
- the COMBINATION of that settlement with the run semantics already in the
  reducer: one `loopTraversals` counter and one hard-cap stop, natural
  completions as durable join ARRIVALS armed exactly once, the progress refusal
  that never enters `loopProgress`, and a field-by-field restart invariant over
  everything the channel persists
  (`tests/graph/natural-completion-combination.test.ts`);
- the read-only drain audit (`src/graph/audit/drain-audit.ts`).

NOT YET ENABLED OR NOT IMPLEMENTED:

- any host credential-isolation adapter: none ships in this build and this build
  cannot provide one (it writes the ledger as an ordinary file), so the outcome
  run path refuses by default until a deployment injects its own (D7);
- the protocol-aware dispatch completion BRIDGE: the runtime exposes
  `settleNatural` for a host that observes a dispatched attempt completing, but
  this build ships no host bridge, and the run path is driven by a synchronous
  host adapter — so production dispatch still settles no node through it and the
  bridge itself remains HOST-side work;
- any HOST implementation of the dispatch adapter or of the identity
  capability: this build ships the contracts and the reconciliation, and no
  adapter, so every production entry refuses an outcome graph until a
  deployment injects a dispatcher (D8), and the identity constraint is simply
  not enabled until one injects an identity capability (D9);
- the remaining validator capabilities: only the registry and the
  artifact-reference validator exist; the schema, command-check and approval
  validators do not;
- storage format 3 and its `2 -> 3` migrator — `ENGINE_PERSISTENCE_VERSION` is
  still the literal `2` — and the `src/graph/persistence/load.ts` module move;
- stage-E retirement: the legacy signal path and the legacy v2 run and recovery
  paths are untouched and still run.

## Objective and scope

Replace implicit interpretation of agent-controlled signal payloads with
contract-bound outcomes and a deterministic decision engine. Optimize for
correctness, extensibility, and recoverability in the existing local graph
runtime. This does not require distributed services, role-specific node types,
or replacing the non-graph function signal protocol.

The protocol guarantees consistent interpretation, authorized submission, and
traceable acceptance. It does not prove that an agent's claims are true. Evidence
checks provide only the guarantees of their individual validators.

## Review conclusions

| Claim | Decision |
| --- | --- |
| Explicit outcomes eliminate ambiguous `findings` routing | Accept when control consumers stop inspecting free-form business data. |
| An `AcceptedEvent` prevents overwritten submissions | Incomplete: durable receipts, uniqueness, and conflict rules are also required. |
| Explicit progress replaces whole-payload fingerprints | Accept; incomplete comparisons must produce unknown, not equal. Repeated successful answers are not inherently stuck. |
| Compilation eliminates `no loop group` failures | Only for declared behavior. Runtime must reject undeclared outcomes and stale or invalid contexts. |
| Payload interpretation is relatively concentrated | Directionally correct; distinguish display extraction from control decisions. A helper count is not a complete change-impact estimate. |
| Contracts must come from role definitions | Reject exclusivity. Contracts are role-independent data; policy authority must be separate from the submitting worker. |
| Existing terminal dedupe provides submission receipts | Reject. Notification dedupe, execution fencing, and submission idempotency are different guarantees. |
| `adoptPrior` is the persistence migration boundary | Reject. Version decoding and migration must precede hydration, before adoption receives an engine state. |
| Contract routing and progress changes require no persistence work | Reject. Additive storage changes may avoid a format-version bump, but durable semantics and recovery still change. |

## Contract ownership and authority

Contracts are versioned declarations in a role-independent registry, referenced
by nodes or supplied inline during graph construction. Role definitions may
select reusable contracts; the engine does not classify roles.

An authorized orchestrator may draft an inline contract. A policy authority
outside the worker fixes required acceptance gates, available validators, and
allowed completion policies. A worker cannot weaken these requirements or edit
its active contract. Immutability alone does not make a contract trustworthy.
The completion-policy authority is implemented (D6 below): a natural-completion
mapping is authorized only by a repository-versioned policy revision the HOST
installed by content, never by the declaration that requests it.

Compilation resolves and persists the effective contract, its content digest,
policy revision, and validator versions. An identifier alone is insufficient:
editing a registry entry must not change an in-flight run. Graph extensions
create validated plan revisions; active attempts remain bound to their original
revision and cannot be rebound to new semantics implicitly.

Node declarations contain outcomes with explicit data contracts, acceptance
requirements, and a completion policy. They do not contain a role-category enum.
Changing prompts or assigning another agent does not alter the protocol.

## Compiler and runtime boundary

The compiler validates outcome references, input/output bindings, explicit
adapters, cycle membership, continuation routes, exit routes, resource limits,
and supported validator capabilities. It proves declared structural properties,
not that a model will emit a valid result or that a loop will converge.

Schema compatibility is checked within a supported schema subset. Unproven
compatibility requires an explicit adapter or fails compilation; it is never
silently assumed. Runtime validation remains mandatory at external boundaries.

All control routing uses accepted outcome identifiers or declared typed
predicates. Business data fields such as `findings`, `items`, and `verdict` have
no global control meaning. A revision outcome may be named freely; its loop
continuation behavior is declared in the compiled plan.

## Submission and acceptance

Graph workers use a graph-scoped `submit_outcome` capability. Its model-facing
schema is generated from the effective node contract. The runtime binds graph,
node, plan revision, execution identity, and source to the authenticated tool
context. Agent-supplied data cannot impersonate runtime provenance.

The processing path is:

```text
OutcomeProposal + trusted execution context
  -> protocol and contract validation
  -> evidence validation
  -> serialized state and authority check
  -> atomic commit of receipt, accepted event, state, and pending effects
  -> acknowledgement
  -> effect execution
```

Evidence validation may run outside the serialized commit. Its result binds to
the exact proposal, contract, execution, and immutable artifact digest. The
commit rechecks those bindings and current authority; superseded validation
cannot settle a newer execution. Mutable artifacts require snapshots or explicit
revalidation, not a path-exists check followed by an unrelated later read.

Each logical submission has a stable idempotency key. Repeating that key with
the same normalized content returns the persisted receipt; reusing it with
different content is a conflict. A distinct terminal submission after settlement
is rejected rather than overwriting the result. The engine commits at most one
terminal outcome per execution. Progress and input requests are separate events.

Rejected proposals do not enter the accepted-event stream or settle the node.
They return structured repair errors. Submission repair, execution retry, and
business revision have separate counters under shared overall resource limits.
Diagnostic retention is bounded and does not require storing sensitive raw data.

Execution identity may reuse existing dispatch task identity where its lifetime
and uniqueness are sufficient. Current task-ID checks and advancement guards are
retained and integrated. Notification epochs remain notification mechanisms;
they are not submission identities or durable command receipts.

## Acceptance validators

Acceptance uses a closed, versioned registry of trusted validator implementations,
not agent-authored executable expressions or a general-purpose rule language.
Initial capabilities are schema validation, artifact-reference validation,
registered command checks, and authenticated approval.

Command checks reference configured commands, run in the existing permission
boundary with time/resource limits, and record results against the artifact and
execution being checked. Agent-reported exit codes are not evidence. A successful
command or matching schema proves only its defined property. Required gates come
from policy and cannot be replaced with a trivial check by the worker.

Validator results are pass, fail, or indeterminate/error. An indeterminate result
cannot satisfy a required gate. Unsupported validators fail compilation; more
capabilities may be added deliberately through registry versions.

## State, storage, and effects

Execution lifecycle and business outcome are distinct. Runtime completion without
an outcome is not implicitly business success. A node may declare a natural
completion policy mapped to one specific permitted outcome; normal acceptance
requirements still apply. The old `__inferred` payload marker disappears, while
its legitimate provenance and completion-policy semantics remain explicit.

A deterministic reducer takes state, validated commands/events, and the pinned
plan and produces state changes plus pending effects. Time and external results
are explicit inputs. Effects perform dispatch, cancellation, and notifications.

Use a local transactional store for acceptance receipts, events, current state,
and pending effects. A transaction commits them together before acknowledgement.
Snapshots support efficient reads; a bounded diagnostic history is not the
authoritative receipt store. Receipt retention must cover the supported replay
window, and expired graph identities must never silently become fresh runs.

Effects use stable IDs. Dispatch creation must support lookup/reconciliation by
effect ID across the crash-after-launch window. External side effects require
their own idempotency or reconciliation; this design does not promise global
exactly-once execution. Cancellation, timeout, and submission races resolve
through the same serialized transition rules.

This build IMPLEMENTS that reconciliation for dispatch (D8, below): a dispatch
intent is committed in the same transaction as the state that arms it, the row
is marked `started` only after the host's create returned, and a recovery asks
the host whether an execution for the effect's stable id exists — `created`
records it without a second create, `absent` creates exactly once, and an
unanswerable query is REPORTED as unsettled work rather than guessed at.

## Loop progress

Loops declare continuation and exit outcomes, next-round input mappings, and
hard round/time/cost limits. Optional progress evaluators compare contract-bound
revision data and relevant artifact/validation versions across completed rounds.

Comparison returns progressed, unchanged, or unknown. Truncation, missing data,
or incompatible versions produce unknown. Successful outcomes do not enter the
revision-staleness path. Unknown progress remains subject to hard limits.
Repeated unchanged results may trigger an explicitly configured stopping policy;
they are not a proof that the underlying task is impossible.

"Consecutive" counts consecutive COMPARABLE results. An unknown never increments
the counter and never triggers the soft stop, and it CLEARS the unchanged streak:
it is not a round in which the run was observed to stand still. The baseline and
the evaluator identity/version it was recorded under are kept, so the next
comparison still answers against the right token. A streak carried across an
unknown would stop a run on repetition nobody observed back to back.

Persist evaluator version, comparison baseline, and counters. Recovery must
continue the same decision semantics instead of resetting progress accidentally.
A body written before the counter cleared on unknown cannot attest that its
counts mean that; its counters are recomputed from zero — the baselines and
identities are kept — by the first advance, which rewrites the body in the
current state-body version (see the state-body version rule below). That rule is
conservative in one direction only: it can delay a stop, never fabricate one.

## Compatibility and migration

Keep the existing `signal` tool for function runtime, observe capture, session
signals, and legacy graphs. New graph outcomes have a distinct ingress. A
protocol-aware dispatch completion bridge selects exactly one authoritative
completion source; it must not merge severity-ranked legacy signals with accepted
outcomes or synthesize a second answer. Information and input-request signals
may coexist only with explicit routing rules.

Pin execution semantics per graph/plan revision. Do not switch protocol based on
whether an individual payload happens to contain an outcome field. Mixed-version
subgraphs require explicit boundary adapters, not implicit per-node fallbacks.

Separate storage format version, execution protocol version, and contract
revision using the ownership and load rules below. Unsupported existing state
must never mean clean start. Version decoding/migration runs before current-type
hydration and before `adoptPrior`.

Existing in-flight graphs retain legacy semantics through a bounded compatibility
runtime until they drain or are explicitly converted at a quiescent boundary.
Do not reinterpret already-running workers or fabricate accepted receipts for
historical signals. Preserve original snapshots and record conversion provenance.
An unsupported or unsafe conversion blocks recovery explicitly without deleting
the snapshot or rerunning completed work. Remove the legacy execution path after
no active graphs depend on it; keep versioned readers/importers as needed.

## Version ownership and load contract

This section specifies proposed modules and fields, not APIs already implemented.
Today `ENGINE_PERSISTENCE_VERSION = 2` owns the snapshot layout, while
`GraphDeclaration.version = 2` owns authoring syntax. Neither identifies execution
semantics or a node contract revision. They currently advance without independent
protocol/contract identities; their equal numeric values do not make them the
same check.

### Implementation status and B2 precondition

Storage format 3 is the target; the B1 delivery still writes and decodes format
2, and the B2 delivery does not change that: no format 3 exists, no real
`2 -> 3` migrator is written, and `ENGINE_PERSISTENCE_VERSION` stays the
literal `2` with no on-disk field added.
`src/graph/persistence/storage-format.ts` no longer holds the B1 number-list
test interface: `classifyStorageFormat` maps an exact version onto a registered
CAPABILITY — a `StorageFormatDecoder` that answers a total
`StorageDecodeResult`, or a `StorageFormatMigration` carrying its own
`validateSource` — and `createStorageFormatRegistry` assembles a deeply frozen
registry, rejecting a duplicate decoder, a duplicate migration source, a
migration whose target has no decoder, and a format that is both decodable and
a migration source.

B2's precondition was that no version may become decodable or migratable
through list membership alone. That now holds structurally — there is no list to
belong to: `migration-required` is returned only after the registered
migration's `validateSource` accepts the body, so an intact source is a missing
capability while a source that violates its own format is `corrupt(storage)`,
and the two never collapse. The detailed loader still lives in
`src/graph/engine/engine-persistence.ts` (`loadEngineStateForResume`), which
also assembles and exports the default registry next to the format-2 decoder:
the decoder needs v2 hydration, so it cannot live in the dependency-leaf
`storage-format.ts`, and the startup sweep imports the registry from
`engine-persistence.ts`. The target location named below,
`src/graph/persistence/load.ts`, is not created yet.

B3 binds the EXECUTION-PROTOCOL identity and refuses it at load when it is
unregistered. `src/graph/protocol/execution-protocol.ts` owns
`LEGACY_SIGNAL_PROTOCOL = 1` and the reserved `OUTCOME_PROTOCOL = 2`, the
deeply frozen `createExecutionProtocolRegistry` (a duplicate version and a
non-positive-safe-integer version are rejected — the same legality rule as
storage formats), and the pure, capability-carrying
`classifyExecutionProtocol`. Support is registry MEMBERSHIP, not comparison
with a latest-version constant: the shipped
`LEGACY_EXECUTION_PROTOCOL_REGISTRY` holds exactly one handler, for protocol
1, so a persisted `executionProtocolVersion: 2` classifies as
`unsupported(execution)` and the load is refused before anything hydrates.
Naming `OUTCOME_PROTOCOL` grants it nothing; the handler interface is today a
marker identity, not a dispatch seam.

The durable identity is an OPTIONAL-ADDITIVE field on the persisted state
(`executionProtocolVersion`) with no storage-format bump:
`ENGINE_PERSISTENCE_VERSION` stays the literal `2`, no format 3 exists, and a
state that never bound an identity serializes exactly as before. Only the
FORMAT-2 decoder may backfill protocol 1 when the field is absent — format 2
IS the legacy layout — and it does so on a state that has already been
validated. A decoder for any newer format resolves nothing, so an absent
identity there is `corrupt(execution)`, never a guessed legacy run. An
illegal identity (`0`, `-1`, `1.5`, `"1"`, `null`, an unsafe integer) is also
`corrupt(execution)`, naming what was received, and a valid file whose
protocol 1 has no registered handler is `unsupported(execution)`. The loader
remains total on every path, including a throwing handler probe (contained as
`corrupt(execution)`).

B4 delivers the CONTRACT IDENTITY surface only.
`src/graph/contracts/contract-definition.ts` owns `ContractRef =
{ id, revision, digest }`, `ContractSnapshot`, and the ONE canonical
`contractDigest`: a protocol-defined JSON-style canonical text (object keys
sorted by UTF-16 code-unit order, every own enumerable data property covered, no
whitespace) hashed as SHA-256 hex over its exact UTF-8 bytes. That text is
EXACTLY the JSON data model, so a body survives
`JSON.parse(JSON.stringify(body))` with an UNCHANGED digest: `-0` is written
`0` (JSON's own text) rather than a `-0` the writer would persist as `0` and
the loader could never reproduce. It REJECTS BEFORE
HASHING — a function, symbol, BigInt, `undefined`, non-finite number, reference
cycle, array hole, symbol key or accessor property, a non-plain container, and
a body beyond the documented `CONTRACT_DIGEST_MAX_BYTES` /
`CONTRACT_DIGEST_MAX_DEPTH` bounds
all throw a descriptive error, so a digest is never computed over a truncated
or partially represented body. `revision` is documented as an OPAQUE IMMUTABLE
identifier: refs compare by exact string identity, never by ordering or a
semver range.

`src/graph/contracts/resolve.ts` owns the deeply frozen
`createContractRegistry`, which verifies digest-before-accept: construction
rejects a malformed ref (empty id / revision / digest), a ref whose three
fields are not own data properties (a getter or an inherited field is not
pinned by `Object.freeze`, so it could move after acceptance), a duplicate
`(id, revision)` pair, and a snapshot whose body does not hash to its claimed
digest — the same capability-not-membership discipline as B1 and B3. Its
`resolveContractRef` is pure and total over a factory-built registry,
`verifyContractBinding` applies the same rules to one in-hand snapshot, and
both answer a four-way `ContractResolution`: `unknown-contract`,
`unknown-revision`, `digest-mismatch` (carrying the ACTUAL digest) or
`resolved`, always re-hashing the body rather than trusting a claim.

Binding a contract ref to nodes or to a retained compiled plan, and refusing a
mismatched or missing binding at load, is the NEXT slice: it needs the
`CompiledPlan[graphId, planRevision]` record (node bindings plus
`contractSnapshots[digest]`) from the durable record shape below, which does
not exist yet. This slice therefore adds no declaration field, no engine-state
field and no loader branch; the identity modules are dependency leaves that the
compiler and loader will call once the plan exists.

B5 delivers the GRAPH COMPILER core for authoring declaration version 3.
`src/graph/compiler/declaration-v3.ts` owns the v3 grammar types and the
structural guard `isGraphDeclarationV3`, `src/graph/compiler/plan.ts` the
immutable `CompiledPlan` whose `planRevision` is content-addressed through the
B4 `contractDigest` over the normalized plan body, and
`src/graph/compiler/compile.ts` the total structural compiler `compileGraph`.
A node's `contractRef` is resolved through `resolveContractRef`, and a
resolved snapshot lands in `contractSnapshots[digest]`, so the two B4 identity
functions are reused rather than duplicated. Compilation is STRUCTURAL
VALIDATION ONLY: it proves declared structure (outcome references, completion
policies, loop routes, contract resolution, validator capability) and never
executes, persists or wires anything. Legacy v2 documents keep the legacy
parser, validator and engine untouched; the v3 grammar is a separate authoring
path that nothing loads yet.

DEFERRED by this slice, and not implied by it: a YAML/JSON authoring front-end
for v3 (no reader from text to `GraphDeclarationV3` exists), plan PERSISTENCE
(no durable `planRevision` record), binding compiled refs into runtime state,
load-time refusal of a missing or mismatched plan binding, adapters/schema
compatibility, the typed-predicate vocabulary (edges bind outcomes only), and
any engine wiring. The in-memory `CompiledPlan[graphId, planRevision]` shape
the B4 paragraph above called the next requirement now exists; what a loader
still needs from it is the durable record and the refusal rules, which are not
in this slice.

B6 persists the PLAN BINDING and verifies it at load, making the `contract`
load dimension real. `EngineState.planBinding` is an OPTIONAL-ADDITIVE record of
`{ planRevision, contractSnapshots, nodeBindings }` with no storage-format
bump: an absent binding means "legacy graph with no compiled plan", is LEGAL,
and serializes with NO key at all, so a state that never carried a plan binding
writes exactly the bytes the previous writer produced. When the field is
present the format-2 decoder verifies it before the load may answer `valid`, in
the same place B3 backfills the execution protocol: `planRevision` must be a
non-empty string; every `contractSnapshots` entry keyed by digest D must have
`ref.digest === D` and a body the ONE B4 `contractDigest` hashes to D, and no
two entries may name one `(id, revision)` identity with different digests —
the same one-identity-one-snapshot rule `createContractRegistry` enforces at
construction, so a load admits no record a compiler cannot produce; every
`nodeBindings` entry must resolve to a snapshot whose ref equals it by
identity (`contractRefsEqual`), never by ordering; no binding may name a node
the state does not declare; and `planRevision` must be
`contractDigest({ contractSnapshots, nodeBindings })` over the records as
persisted, so a tampered binding or a revision copied from a stale one is
refused. (SUPERSEDED BY B7: the binding-body digest rule is deleted and the
field is re-meant as the compiled plan's own revision — see the B7 paragraph
below. Every other B6 rule still holds, and B7 shares its single
implementation with the plan record.) Any failure is `corrupt(contract)` naming the failed check and the
offending digest key or node id — the first producer of that dimension,
reachable ONLY through a persisted binding that fails verification. The decoder
and the loader stay total: a hostile binding (a throwing getter, a Proxy, a
reference cycle, any body `contractDigest` rejects) is contained as
`corrupt(contract)`, never a loader failure. A state WITHOUT a binding loads
exactly as before: storage format 2, the B3 protocol backfill unchanged,
`loadEngineStateFromJson` still `null` for every non-valid input.

DEFERRED by this slice, and not implied by it: compiling the persisted topology
(recovery still runs off the retained declaration, and switching recovery onto a
persisted `CompiledPlan` is a later slice), producing a binding at graph
creation, refusing a binding whose CONTRACT SEMANTICS differ rather than whose
identity does not verify, and any `src/dispatch/**` change. The record was also
honest about what it did NOT carry: the compiled topology (nodes, edges, loop
groups), and therefore the compiler's full-body `CompiledPlan.planRevision` —
`planBinding.planRevision` addressed the persisted binding body itself. B7
removes that limitation by persisting the plan record; see below. One consequence is
reserved for the deferred producer: `contractSnapshots` is keyed by CONTENT
digest, so two distinct `(id, revision)` identities whose bodies are
byte-identical share one entry, and a load then fails check (c) for whichever
binding the stored snapshot does not name. A producer must either refuse that
graph or carry per-identity aliases; the load rule (bound ref equals snapshot
ref by identity) is deliberately not relaxed here, and widening the record
shape belongs to the deferred producer work.

B7 PERSISTS THE COMPILED PLAN RECORD and verifies it at load, and it removes
the naming trap B6 left behind. THE PROBLEM B7 FIXES: B6 had no topology to
persist, so it made `planBinding.planRevision` the content address of the
BINDING BODY `{ contractSnapshots, nodeBindings }` — not the compiled plan
revision. The record model above (`CompiledPlan[graphId, planRevision]` with a
compiled topology) expects a plan revision that identifies a persisted
`CompiledPlan`, so the name would have misled the slice that finally persists
the topology. Nothing produces a binding in production yet, so the meaning is
fixed now, while no stored state depends on the old one.

`EngineState.compiledPlan` is an OPTIONAL-ADDITIVE record of
`PersistedCompiledPlan` — `CompiledPlan` exactly (the plan body plus the
compiler's own content-addressed `planRevision`) and the explicit `nodeBindings`
index the binding already carries — with no storage-format bump. Nothing is
dropped from the in-memory plan: every body value is JSON data because
`contractDigest` accepted the body in order to compute the revision, and the
writer's defensive copy is KEY-PRESERVING for the same reason — it rebuilds only
the containers it must not alias and spreads each record, so an own key the
record carries, declared by the plan model or not, is copied rather than
projected away. `planRevision` addresses the body AS PERSISTED, so a
closed-field projection would drop such a key while keeping the revision, and
the writer's own output would be refused as `corrupt(contract)` on the next
load. An absent record means "no compiled plan was ever persisted", is LEGAL,
and serializes with NO key at all, so a state that never carried one writes
exactly the bytes the previous writer produced.

`planBinding.planRevision` is now the COMPILED PLAN revision — the same value
`compiledPlan.planRevision` carries — and is no longer recomputed from the
binding body. The binding-body digest rule is DELETED, not renamed: one name
never means two identities, and a separate `bindingDigest` would have been a
third content address the record model does not define. A binding that stands
alone therefore keeps its revision as a foreign key the state cannot resolve.
That is the one B6 verification strength the deletion gives up, and it is
given up deliberately: the binding is a projection of a plan B7 can persist,
and per-entry snapshot digests still prove every contract body it carries.

The format-2 decoder verifies the plan record before the load may answer
`valid`, in the same place the binding gate runs. Shape: `planRevision` and
`graphId` are non-empty, `graphId` equals the state's own id,
`declarationVersion` is 3, and `nodes` / `edges` / `loopGroups` are arrays.
Topology: the plan module's own rule owner `inspectCompiledTopology` applies the
compiler plan-level rules — unique node ids, every edge endpoint declared,
every edge outcome declared by its source, loop members and routes declared, a
positive traversal cap — and every topology node id must be one the persisted
state declares. (EXTENDED BY B9: the same inspector now owns the complete rule
set — required outcomes, cycle containment, continuation paths, explicit
terminals and acceptance pinning — and the compiler runs it over its own output
too. See the B9 paragraph below.) The record `nodeBindings` index is the ONE field the plan
revision does not cover, so it is checked as the projection of the plan nodes
it claims to be: every node declaring a `contractRef` must appear with that
same ref, a node declaring none must not appear, and every key must be a
topology node id. Contracts: the SAME `verifyContractRecord` owner the binding
gate calls (snapshot body hashes to its key, `ref.digest` equals the key, one
`(id, revision)` identity has one snapshot, every bound ref resolves to an
equal snapshot ref, every bound node exists in the state). Identity: the
record `planRevision` is `contractDigest` over its OWN plan body (`graphId`,
`declarationVersion`, `nodes`, `edges`, `loopGroups`, `contractSnapshots`),
recomputed at load from the persisted values, so a tampered body or a
revision copied from another plan is refused. When BOTH records are present
they must AGREE: equal `planRevision`, every digest the binding references
(snapshot keys and node binding refs) is pinned by the plan, and every node
the binding binds is bound by the plan to the same ref.
(SUPERSEDED BY B8: the contract rules above are re-meant on a content/identity
split — a snapshot entry carries no `ref`, a node binding resolves through the
`contractIdentities` index, and the plan body the revision addresses includes
that index. See the B8 paragraph below. The topology, index-projection,
identity and agreement checks themselves are unchanged.) EITHER record alone is
legal and verified on its own terms; requiring both would refuse states this
build can still verify, and refusing a lone binding would silently drop the
set B6 accepted. Every failure is `corrupt(contract)` naming the failed check,
and the decoder and loader stay total, so a hostile record (a throwing getter,
a Proxy, a reference cycle, a `BigInt`) is contained rather than thrown.

B8 FIXES TWO REPRODUCED DEFECTS against the B stage without switching recovery
onto the plan.

DEFECT 1 — recovery and adoption silently DROPPED the new persisted identity
fields. `hydrateEngineState` and `adoptPriorNodeStates` copied a fixed field
set and knew nothing about `executionProtocolVersion`, `compiledPlan` or
`planBinding`, and `snapshotEngineState` (the `status()` snapshot the adopt
path receives) dropped them too, so a state loaded with a plan came back
without one and re-serialized with no plan key. The required semantics are NOT
a mechanical copy:

- HYDRATE (same graph, same persisted state) carries all three intact and
  DEEP-CLONED, so the target and the source never share a record or a contract
  body.
- ADOPT (a rebuild from a declaration plus a prior state) carries them ONLY
  when the prior state belongs to the SAME graph AND its declaration is
  unchanged, compared by the canonical digest of the PERSISTED declaration
  through the ONE B4 `contractDigest` (`JSON` round trip = the writer's own
  projection; no second digest is added). A compiled plan is bound to the
  declaration it was compiled from, and the same `graphId` is NOT sufficient
  evidence that it still matches.
- When the declaration CHANGED, adoption REFUSES EXPLICITLY: it throws a typed
  `AdoptPlanRefusalError` naming the carried fields, the two digests and the
  required next step, BEFORE mutating either state. It never silently drops the
  plan and never mechanically copies one that no longer matches. A state with
  no plan identity to carry is never refused, so a legacy rebuild is unchanged.

The refusal is handled deliberately at every caller: `EngineRuntime.adoptPrior`
propagates it; `graph_run`'s existing dispose-and-rethrow block surfaces it and
leaves the prior registry entry untouched; `graph-tools.commit` (the
construction/extension path, where the declaration changed BY CONSTRUCTION)
pre-checks with `planAdoptionRefusal` and throws before the rebuilt runtime
replaces the live one, disposing that runtime first; and the persisted-approval
path rethrows a refusal instead of continuing with a rebuilt engine whose plan
it could not adopt. Nothing in production produces a plan record yet, so the
refusal is unreachable for plans today; it exists so the producer slice cannot
inherit a silent drop.

DEFECT 2 — the compiler could produce a plan its own loader REJECTED. Two
different contract identities with byte-identical bodies compiled fine, but the
digest-keyed snapshot entry held ONE `ref`, so the second identity overwrote
the first while both node bindings kept their own refs, and the load refused the
compiler's own output as `corrupt(contract)`. The model is now explicit and the
identity is separated from the content:

- `contractSnapshots` is CONTENT ONLY, keyed by digest, and its value is
  `{ body }` with no `ref`: one body can belong to several identities, so a
  single ref would have to name one of them and drop the rest. Identical bodies
  hash to one digest and share one entry.
- `contractIdentities` is the IDENTITY INDEX: `id` → `revision` → content
  digest, in BOTH the plan record (inside the plan body, so `planRevision`
  covers it) and the plan binding, and the agreement gate requires the two
  indexes to match exactly. The nested shape makes "one identity, one digest"
  structural. `revision` stays an OPAQUE IMMUTABLE identifier: never ordered,
  never a range.
- COMPILE deduplicates identical bodies to one snapshot and gives every
  identity its own index entry: an existing content entry and an existing
  identity entry are never overwritten (a contradictory rebind is reported as
  `contract-digest-mismatch`).
- LOAD/VERIFY resolves a node binding THROUGH the identity index to a digest
  and then requires that digest to have a snapshot whose body hashes back to it
  (the ONE `contractDigest`, reused). Two identities sharing one digest verify
  CLEAN — that is a regression test, not a tolerated oddity. An identity index
  that disagrees with the snapshot content, a binding whose identity is absent
  from the index, and a binding whose declared digest disagrees with the index
  are each `corrupt(contract)` with their own reason.

The persisted record SHAPE changes. Nothing in production writes a plan record
or a binding (no producer exists at graph creation), so NO MIGRATION is written
and none is required: an older-shape record, if one ever existed on disk, is
refused as `corrupt(contract)` rather than reinterpreted, and the storage
format stays the literal `2` with no on-disk format field added.

RECOVERY IS STILL NOT SWITCHED ONTO THE PLAN. The engine resumes from the
retained declaration, nothing consumes `compiledPlan`, no producer writes one
at graph creation, and a comment at the field says so. B7 made the record, its
rules and its cross-checks exist; B8 makes recovery CARRY and re-serialize them
honestly and separates content from identity, so the slice that finally depends
on a plan cannot lose it in a rebuild.

DEFERRED by this slice, and not implied by it: producing the record (or a
binding) at graph creation, switching recovery onto the persisted plan,
refusing a plan whose CONTRACT SEMANTICS differ rather than whose identity
does not verify, verifying the field-level schema of node / edge internals
beyond what the topology rules read (the gate proves identity and structure,
not every optional field), the `src/graph/persistence/load.ts` module move,
and any `src/dispatch/**` change.

Still unimplemented: storage format 3 with its `2 -> 3` migrator, the outcome
protocol itself (the compiler builds an in-memory plan in B5, but no runtime
consumes one: no submission ingress, reducer or receipt store exists), and the
`src/graph/persistence/load.ts` target module. B6 made the load-side refusal
of the contract binding real, B7 persists and verifies the full
compiled-plan record, B8 carries that record through hydration, adoption
and `status()` while separating contract content from contract identity, and
B9 makes one plan-level inspector own every structural invariant, puts the
compiler's own output under it, and separates an executable plan from a draft;
what remains is producing a plan record at graph creation and switching
recovery onto the persisted plan.

B9 FIXES TWO STRUCTURAL DEFECTS the B stage left open, without enabling the
outcome protocol anywhere.

DEFECT 3 — the compiler could produce a plan its own reader refuses, because
the plan-level rules were only checked at ONE boundary and were incomplete.
The rule set now lives in exactly one implementation,
`src/graph/compiler/plan.ts`'s `inspectCompiledTopology`, and both boundaries
call it: `compile.ts` runs it over the body it just assembled and refuses its
own output as compile errors carrying the inspector's OWN codes, and the load
gate runs it over the persisted body. The compiler's error union is composed
from the inspector's `CompiledTopologyIssueCode` (`| CompiledTopologyIssueCode`),
so one defect has one code on both sides rather than two parallel vocabularies.
The inspection runs after the declaration-level rules have already refused, so
a defect the compiler named itself is not reported a second time.

Rules added to the inspector, each with its stable code:

- CYCLE CONTAINMENT — `cycle-not-in-loop-group`. Every cycle in the compiled
  edge set must lie inside a declared loop group; a cyclic strongly-connected
  component any of whose nodes is not a loop member is an error. The SCC
  computation is the v2 validator's own Tarjan algorithm, EXTRACTED into the
  dependency-leaf module `src/graph/cycle-detection.ts`
  (`stronglyConnectedComponents` / `isCyclicComponent` / `hasDirectedCycle`),
  and `validator-v2.ts` now imports it instead of holding a private copy, so
  the tree has ONE cycle semantics rather than two adaptations of one
  algorithm. The v2 behaviour is unchanged: `hasCycle` keeps its name,
  signature and result, the v2 cycle-containment rule keeps its node-coverage
  semantics and its construct/execution severity split, and the shared module
  reproduces the original traversal order. The v3 rule drops only what is
  v2-specific — the revise-back-edge warning exemption, which names a v2 marker
  that v3 does not have, because v3 loop groups declare their routes.
- CONTINUATION PATH — `loop-continuation-without-edge`. A loop group's
  `continuationOutcome` must be carried by at least one edge that stays INSIDE
  the group (a declared member to a declared member). Declaring a continuation
  outcome with no such edge is an error: the loop could never continue. It is
  checked only once the route is a real member outcome, so a bogus route is
  reported once as `unknown-loop-continuation-outcome` instead of cascading.
- REQUIRED OUTCOMES AT LOAD — `missing-outcomes`. A node with an empty outcomes
  list is an error at BOTH boundaries, with the compiler's own code. The
  compiler already refused it at declaration level; the inspector re-derives it
  from the body, so a persisted `outcomes: []` is `corrupt(contract)` naming
  `missing-outcomes` rather than verifying.
- EXPLICIT TERMINAL — `missing-terminal-outcome` and
  `terminal-outcomes-inconsistent`. A graph states its exits positively instead
  of leaving them to the absence of an edge. An outcome with NO outbound edge
  from its declaring node terminates that node; the compiler computes a
  deterministic `terminalOutcomes` list (canonical order: node id, then outcome
  id) for the plan body, so `planRevision` covers it, and the inspector requires
  the list to be NON-EMPTY and to be exactly the set the edges imply. The
  derivation is one exported function, `terminalOutcomesOf`, used by the
  compiler to write the list and by the inspector to check it. The former
  `unused-outcome` WARNING described exactly this case and is RETIRED, not
  renamed: an outcome that goes nowhere is now a declared exit, and no warning
  code remains (`CompileWarningCode` is `never`; the `warnings` field stays so
  the result shape does not churn).

DEFECT 4 — acceptance capabilities were not resolved, so a syntax-only result
could look executable. Compilation now resolves acceptance against the
installed capability set and PINS what it resolved:

- With `CompileOptions.supportedValidators` provided, every acceptance
  requirement must resolve to a capability at an EXACT version. A VERSIONED
  requirement is satisfied only by a capability declaring that exact version; an
  UNVERSIONED capability can only mark it covered, which is the distinct error
  `unpinned-validator-version` ("covered but not version-pinned"), while a name
  no capability declares stays `unsupported-validator` ("nothing covers it").
  An UNVERSIONED requirement is pinned to the exact version of the first
  matching versioned capability in declared order, and the RESOLVED version is
  written back into the plan, so a bare requirement no longer silently means
  "any version" and the plan records what was checked.
- With NO capability set, compilation still answers, but as an explicitly
  NON-EXECUTABLE DRAFT. The two success shapes have different discriminants —
  `{ ok: true, kind: "executable" }` and
  `{ ok: true, kind: "draft", unresolved }` — and a draft carries the plan
  body's own frozen `unresolved` list. `ok` alone is not a licence to execute
  or persist a plan; `kind` is the discriminator. A plan with no acceptance
  requirements has nothing unresolved and is executable without a capability
  set, so declarations that never used acceptance are unaffected.
- The distinction is PERSISTED. `CompiledPlanBody.executability` is
  `{ kind: "executable" }` or `{ kind: "draft", unresolved: [...] }`, inside
  the plan body so `planRevision` covers it. The load gate REFUSES a non-
  executable record: a persisted draft is `corrupt(contract)` carrying the
  stable code `plan-not-executable`, and a malformed executability value is
  refused as a malformed record. The choice is refusal, not silent marking: a
  state whose persisted `compiledPlan` is a draft never becomes `valid`, so it
  cannot reach `adoptPrior`, dispatch or automatic provisioning. The inspector
  itself accepts a draft as a well-formed plan, because the compiler
  legitimately PRODUCES one — the executability requirement is a load policy on
  top of the structural rules, defined once in `readPlanExecutability`.

DEFERRED by this slice, and not implied by it: producing a plan record at graph
creation, switching recovery onto the persisted plan, a YAML/JSON authoring
front-end for v3, adapters/schema compatibility, the typed-predicate
vocabulary, and any `src/dispatch/**` change. The plan is still not an
execution authority — the inspector proves structure, not that a model will
emit a valid result.

The dispatch completion bridge switch-over is deliberately DEFERRED:
`src/dispatch/completion/completion-evaluator.ts` is not modified in this
slice, because with only the legacy protocol registered there is nothing to
switch between. The rule that must hold when it does switch is the one
`Compatibility and migration` already states: a protocol-aware bridge selects
exactly ONE authoritative completion source and must not merge severity-ranked
legacy signals with accepted outcomes or synthesize a second answer. Protocol
selection is enforced where it belongs today — at the load boundary, which
refuses an unregistered protocol instead of running it under legacy rules.

C1 DELIVERS THE AUTHORING INGRESS — the first PRODUCER of a compiled plan —
without enabling the outcome protocol anywhere.

`src/graph/compiler/parse-declaration-v3.ts` is the front-end B5 deferred: JSON
text or an already-parsed value in, a validated `GraphDeclarationV3` or a list
of STRUCTURED issues out (`code`, `message`, `path`), never an exception. It
owns the strictness the compiler's shallow guard deliberately does not — the
grammar is CLOSED (`unknown-key` at every level, reported in canonical key
order), a field must have the JSON type the grammar declares (`wrong-type`), an
absent required field is `missing-field`, a value the grammar does not admit
(a non-positive or fractional `max_traversals`, an empty identifier, a name
that is blank after trimming, an out-of-bound per-node budget — a negative
`timeout_ms` or ceiling, a negative or fractional `max_retries` — a
non-finite number, a completion policy that is not one policy object, a
`quorum` on the wrong strategy) is `invalid-value`, and `version` other than 3
is `unsupported-version`. Every issue names its path
(`$.nodes[1].outcomes[0].id`). `isGraphDeclarationV3` is reused as the final
agreement check over the value the front-end BUILT, and that value is fresh and
deeply frozen, so it never aliases the caller's containers.

`src/graph/tools/declare-graph.ts` and the additive `graph_declare` tool are
the producer. It parses, compiles with the caller's capability options
(`supported_validators`; the toolset's optional `contracts` dependency
resolves node contract refs), and on success writes the compiled-plan RECORD,
the plan BINDING and the EXECUTION-PROTOCOL identity
(`executionProtocolVersion = OUTCOME_PROTOCOL`) onto a fresh engine state,
persisted through the existing `EnginePersistence` store — no format bump, the
same format-2 layout and the same loader gates. The state's legacy
`graphDeclaration` is a deliberately EMPTY carrier: no v2 declaration is
fabricated for a v3 graph, the compiled plan is the topology authority, and the
state registers one pending runtime node per compiled node so the B7
topology/binding gate verifies against the state that carries the record. A
DRAFT is REFUSED by name with every unresolved acceptance entry and nothing is
persisted; a malformed declaration is refused with its structured codes; an
UNCHANGED re-declaration preserves the stored plan while a changed one refuses
with both declaration digests and the stored plan revision (the B8 adoption
rule); across a restart, where the declaration itself is not persisted, the
comparison is the persisted plan revision, so a record is never overwritten
silently and an unreadable or foreign state file is refused rather than
replaced; an id that already names a legacy graph refuses
(`legacy-graph-conflict`), because a graph's execution protocol is pinned and
is never switched in place. The id reservation is DURABLE, not merely
in-memory: `graph_create` also consults the persisted record, so in a fresh
process it suffixes the name (`name-2`) instead of handing back an id whose
first legacy save would replace the persisted plan, and an on-disk file that
cannot be shown to belong to the requested id (including a slug collision such
as `"a/b"` and `"a b"` sharing one state file) is treated as reserved too. A
legacy record this build can resume is deliberately NOT a reservation, so
same-id legacy resume is unchanged.

(SUPERSEDED BY C3b, below. The paragraph that follows describes the C1
boundary; C3b registers the outcome handler, so a declared graph LOADS as valid
and RUNS through the outcome run path. The part that still holds exactly as
written is the legacy entry-point refusal — and restart recovery remains
deferred.)

A DECLARED GRAPH IS DELIBERATELY NOT RUNNABLE. This build registers exactly one
execution-protocol handler (protocol 1), so the loader refuses a persisted
protocol-2 state as `unsupported(execution)` before hydration: the declaration
is durable, but it cannot be resumed under legacy rules. Inside the toolset a
declared graph lives OUTSIDE the legacy registry, and every legacy operation —
`graph_run` (including `dry_run`), the construction tools, cancel, approve and
targeted status — refuses with `OutcomeProtocolUnavailableError`, naming the
missing protocol handler and dispatching no node. That holds after a restart
too: when the in-memory map is empty and a declared record owns the requested
id, the refusal is resolved from the persisted plan revision instead of
degrading to "does not exist". Nothing falls back to the legacy signal
protocol. `graph_declare` also returns the plan revision with
`runnable: false` and the same reason, so the boundary is visible to the
caller, not only enforced.

DEFERRED by this slice, and not implied by it (the execution path's CORE — the
run path, the reducer and the state's place in the acceptance transaction — is
delivered by C3b below; the model-facing `submit_outcome` tool, effect
execution and restart recovery stay deferred): the entire outcome EXECUTION
path — the graph-scoped `submit_outcome` ingress, protocol/contract validation,
evidence validators, the deterministic reducer, the atomic acceptance/receipt
store with its idempotency keys, effect execution, and restart recovery
switched onto the persisted plan — plus the protocol-aware dispatch completion
bridge, storage format 3 with its `2 -> 3` migrator, the
`src/graph/persistence/load.ts` module move, adapters/schema compatibility,
the typed-predicate vocabulary, progress evaluators, and any `src/dispatch/**`
change. The plan is not an execution authority in this slice, and no runtime
consumer reads the record yet.

C2 DELIVERS THE DURABLE ACCEPTANCE LEDGER — the atomic receipt/event/effect
store the execution path requires — and NOTHING ROUTES INTO IT.

`src/graph/ledger/types.ts` owns the record model and the PORT. `ReceiptRecord`
is one committed decision keyed by `(graphId, attemptId, submissionId)` — the
submission's idempotency key; `AcceptedEventRecord` is the accepted-event
stream, at most one event per `(graphId, attemptId)`; `PendingEffectRecord` is
one effect keyed by `(graphId, effectId)` with a
`pending | started | done | failed` status and an opaque payload. `CommitResult`
encodes the protocol rules verbatim: the same logical submission with the same
`proposalDigest` is `replayed` with the PERSISTED receipt and writes no second
row, the same key with a different digest is a `conflict` that writes nothing,
a distinct terminal submission for an already-settled attempt is `settled` and
never overwrites the accepted result, and otherwise the batch is `committed`.
Timestamps are epoch milliseconds supplied by the CALLER: time is an explicit
protocol input, and the store never reads a clock.

`src/graph/ledger/sqlite-ledger.ts` is the durable substrate over the portable
in-tree driver (`src/memory/db-driver.ts`), on the same delete-journal default
the driver was verified under — no journal pragma, no module-level connection,
no singleton. `SqliteAcceptanceLedger.create(directory)` derives its file from
an injected directory (tests use `mkdtemp`), initializes the schema and format
row in one transaction, and thereafter opens only a file whose format version
is EXACTLY `LEDGER_FORMAT_VERSION` and whose schema is intact — every table
present AND every column present with the affinity, nullability and PRIMARY KEY
position this format writes, so a store reshaped at the column level is refused
at open instead of failing later with a raw driver error. An unknown, newer,
older, incomplete, reshaped or foreign store is refused with a typed
`LedgerFormatError` and left untouched — never recreated, never downgraded.

ATOMICITY IS THE POINT. Every commit writes the receipt, the accepted event and
all pending effects inside ONE transaction that commits before the verdict is
returned. A constraint violation, an effect row that cannot be stored, or a
payload JSON cannot represent throws a typed `LedgerWriteError` and the
transaction ROLLS BACK — no receipt, no event and no effect from that batch
survive — and `committed` is never reported for an uncommitted batch. Effects
are BOOKKEEPING ONLY and are never executed here: a restart is a read, and
`pendingEffects` answers the rows a previous process left `pending` or
`started`, which IS the resume path. `runInTransaction` is the documented
EXTENSION POINT for the single atomic boundary the protocol requires —
acceptance receipt + accepted event + engine state change + pending effects in
ONE transaction — and it exposes the same read/write surface inside the
caller's transaction. THE ENGINE STATE DOES NOT YET JOIN IT (SUPERSEDED BY C3b:
`writeGraphState` now joins the acceptance transaction): the callback's
transaction and its rollback are real, but only the ledger's own tables are
written through it in C2.

DEFERRED by this slice, and not implied by it: the entire outcome EXECUTION
path — the graph-scoped `submit_outcome` ingress, protocol/contract validation,
evidence validators, the deterministic reducer, and effect execution — plus
restart recovery switched onto the persisted plan and its ledger, the
protocol-aware dispatch completion bridge, storage format 3 with its `2 -> 3`
migrator, the `src/graph/persistence/load.ts` module move, adapters/schema
compatibility, the typed-predicate vocabulary, and progress evaluators. Nothing
under `src/graph/engine`, `src/graph/tools` or `src/dispatch` imports the
ledger, and the outcome protocol still has no registered handler: a declared
graph remains un-runnable and the ledger is a substrate no runtime consumes yet.

C3a DELIVERS THE SUBMISSION AND ACCEPTANCE CORE — proposal, validators and the
decision/commit path — and NOTHING IS WIRED TO DISPATCH.

`src/graph/outcome/proposal.ts` owns the ONLY shape a worker may supply:
`{ nodeId, outcomeId, data?, evidenceRefs? }` (SUPERSEDED IN PART BY D2, below:
the shape also carries the runtime-issued `credential`, which is a bearer
capability the runtime looks up in its own state and NOT an identity a worker
can choose). It carries no graph, attempt or
submission identity and no plan revision, so provenance comes from the trusted
runtime context and impersonating another execution is impossible BY
CONSTRUCTION rather than by a check a later caller could forget — the shape is
closed, and a proposal that tries to name its own execution is refused as an
unknown key. `readOutcomeProposal` is the total shape gate, `normalizeProposal`
is the canonical deeply frozen form (fixed key order, `data` present exactly
when supplied, `evidenceRefs` a sorted de-duplicated set), and `proposalDigest`
is the digest of that form through the ONE existing `contractDigest` — no second
digest exists, and key order cannot move the result because the canonical form
sorts keys itself.

`src/graph/outcome/validators.ts` owns the CLOSED, versioned registry: an
implementation is keyed by EXACT `{ id, version }`, the caller supplies the
implementations, and the plan pins `{ validator, version }` per acceptance
requirement. `ValidationOutcome` is pass, fail or indeterminate/error, and an
indeterminate result never satisfies a required gate. The shipped
`artifact-reference` v1 implementation reads every declared evidence reference,
requires each to be a regular file that RESOLVES inside the configured root (a
`..` escape or a symlink out of the root is refused), and records the SHA-256
digest and byte size of the bytes it actually read — a digest is never recorded
for a file the check did not read. An empty evidence set FAILS: a required
artifact gate whose subject set is empty is the trivial check the protocol
forbids.

`src/graph/outcome/acceptance.ts` is the decision core. It consumes the committed
compiled plan and the committed ledger and re-implements neither: the plan
supplies the topology and the pinned gates (`readPlanExecutability` classifies
executability), the ledger port supplies the atomic commit and the idempotency
rules, and `contractDigest` supplies the digest. The request gates refuse —
writing nothing — a malformed proposal, an unknown node, an outcome its declaring
node does not declare, a draft plan, a plan revision or graph identity that
disagrees with the submitted/trusted binding, an effect batch with an empty or
duplicated id, and a clock that is not epoch milliseconds; a requirement whose
implementation is not registered is ALSO a refusal, and every implementation is
resolved BEFORE any gate runs, so a missing capability can never read as a pass
and a partially checked submission is never evaluated. `validateSubmission` runs
the gates outside any transaction, binds every result to the proposal digest,
the plan revision and the execution identity, and decides: every required gate
passing is `accepted`, any fail or indeterminate is `rejected`.
`commitSubmission` commits ONE batch inside the ledger's transaction — accepted:
receipt + accepted event + pending effects; rejected: receipt ONLY, so the
attempt stays open — and RECHECKS the live binding inside the transaction,
refusing a superseded proposal, plan revision or execution instead of settling a
newer execution with stale evidence. `submitOutcome` composes the two phases for
the ordinary caller. The ledger verdict is returned with the decision
(`committed` / `replayed` / `conflict` / `settled`), so a repeated submission
answers with the persisted receipt rather than a second row. Time is an explicit
input; the core never reads a clock, and effects are recorded, never executed.
The recheck binds the submission's identity — proposal digest, plan revision,
execution — and deliberately not the validator registry, the artifact root or
the clock, which are caller-supplied infrastructure rather than part of what the
submission IS.

DEFERRED by this slice, and not implied by it (the deterministic reducer and the
engine state's place in the acceptance transaction are DELIVERED BY C3b, below;
the rest stays deferred): dispatch wiring, the deterministic
reducer and the engine state's place in the acceptance transaction, the
model-facing `submit_outcome` tool and its generated schema, effect execution,
restart recovery switched onto the persisted plan and its ledger, the
protocol-aware dispatch completion bridge, storage format 3 with its `2 -> 3`
migrator, and the schema, command-check and approval validators. In the C3a
build nothing under `src/graph/engine`, `src/graph/tools` or `src/dispatch`
imported the new modules, the outcome protocol had no registered handler, a
declared graph was un-runnable and the acceptance core was a decision no runtime
consumed. (C3b, below, supplies the run path and the handler; the model-facing
tool and restart recovery stay deferred.)

C3b MAKES OUTCOME-PROTOCOL GRAPHS RUN, WITH THEIR STATE IN THE ACCEPTANCE
TRANSACTION.

`src/graph/ledger/types.ts` and `sqlite-ledger.ts` add the GRAPH-STATE seam.
`GraphStateRecord` — graph id, plan revision, the state body, updated-at — is
readable and writable on BOTH the port and the transaction surface
(`readGraphState` / `writeGraphState`), so a caller's `runInTransaction` writes
the state snapshot together with the receipt, the accepted event and the pending
effects instead of beside them. One row per graph; a second write replaces the
snapshot. The strict format gate is extended to the new table exactly as the
other tables are guarded — a store missing `ledger_graph_state`, or carrying it
reshaped, is refused and never recreated — and a state body that cannot be
stored (unrepresentable as JSON, or beyond `GRAPH_STATE_MAX_BYTES` of encoded
text) fails the WHOLE transaction: the batch the same transaction already wrote
rolls back with it, so a half-committed acceptance cannot exist.

`src/graph/outcome/graph-state.ts` owns the state MODEL (`phase`, per-node
status and attempt, loop traversal counters, the attempt counter), the STRICT
reader of a persisted record, and the pure reducer. A terminal outcome settles
its node; any other outcome arms its successors; a declared loop continuation
advances the counter of EVERY declared group that takes that outcome as its
continuation and contains the emitting node — a node may belong to several
groups, so the groups a continuation advances are selected by DECLARATION, never
by position, and the round is refused when ANY of their hard caps would be
exceeded; re-entering a settled node is legal only when source and target share
a declared loop group. Attempt ids are minted from a graph-wide counter the state
carries — never supplied by a worker — and a settled node keeps the attempt that
settled it, which is what lets a repeated submission derive the SAME execution
identity. A state this build cannot read is refused, never reset to a clean
start.

`src/graph/outcome/runtime.ts` is the RUN PATH of a declared graph.
`start()` derives the entry nodes from the compiled plan (excluding loop
continuations, so a two-node loop whose back edge points at its entry is still
startable), writes the starting snapshot in ONE transaction and then calls the
dispatch seam. `submit(proposal)` derives the execution identity from its own
context — graph from the plan, attempt from the state, submission from the
proposal's canonical digest — and runs the acceptance core with a JOIN into its
transaction: the accepted decision's successor effects are written into the same
batch, and its state write runs only after that batch actually committed. A
duplicate submission therefore derives the same key, replays the persisted
receipt and advances nothing; a refused proposal and a rejected gate leave the
graph exactly where it was; a distinct submission for a settled attempt is never
committed. The core's refusals are returned verbatim as structured repair
diagnostics.

`src/graph/protocol/execution-protocol.ts` registers the handler LAST.
`OUTCOME_PROTOCOL_HANDLER` declares what it owns — the accepted-outcome
submission as the ONLY completion source, the graph-scoped ingress, and legacy
completion as unreachable — and the shipped
`DEFAULT_EXECUTION_PROTOCOL_REGISTRY` (now the loader's default) carries it
beside the legacy marker, so a persisted protocol-2 state loads as valid and
nothing has to compare a number against a latest-version constant. The runtime
reads those capabilities BEFORE dispatching and refuses a handler registered
under 2 that does not declare them. The legacy path stays unreachable for such a
graph: the toolset's legacy entry points keep refusing, the startup sweep
reports a protocol-2 state as NOT resumed, and the legacy runtime's OWN resume
entry — `EngineRuntime.recover()` — refuses a valid record bound to any protocol
but the legacy one (`status: "protocol_refused"`, carrying the bound identity)
BEFORE it adopts, dispatches or writes anything. A declared state is therefore
never re-entered under legacy rules, and the legacy writer never rewrites its
persisted body. `LEGACY_EXECUTION_PROTOCOL_REGISTRY` remains a legacy-only
construction, so a caller that must refuse protocol 2 still can.

DEFERRED by this slice, and not implied by it: the model-facing
`submit_outcome` tool and its generated contract schema (the run path's
`submit` is a plain programmatic seam), the protocol-aware dispatch COMPLETION
BRIDGE selection rule (this runtime drives a scripted synchronous dispatch seam
and performs no completion-bridge selection), effect execution beyond calling
that seam, restart recovery switched onto the persisted state and its ledger,
storage format 3 with its `2 -> 3` migrator, the
`src/graph/persistence/load.ts` module move, adapters/schema compatibility, the
typed-predicate vocabulary, progress evaluators, and the schema, command-check
and approval validators. Legacy v2 graphs keep their file persistence and their
run path unchanged: nothing here imports or alters them.

(SUPERSEDED IN PART BY C3c, below: the model-facing `graph_submit_outcome`
ingress and restart recovery onto the persisted state are DELIVERED there. The
completion-bridge selection rule and effect execution beyond the dispatch seam
remain deferred.)

C3c COMPLETES THE VERTICAL PATH FOR OUTCOME-PROTOCOL GRAPHS — declare, save
the plan, submit, accept, duplicate receipt, restart recovery — WITH THE FIRST
EXECUTION AND THE RECOVERY SHARING ONE SAVED PLAN.

`src/graph/tools/submit-outcome.ts` is the model-facing ingress
(`graph_submit_outcome`, the doc's graph-scoped `submit_outcome` capability).
Its args are the MINIMUM a worker may supply — `graph_id`, `node_id`,
`outcome_id`, optional `data`, optional `evidence_refs` — and it is registered
additively beside the existing `graph_*` tools, whose schemas are unchanged.
Attempt id, submission id and plan revision are NOT args: the tool resolves the
node's contract from the graph's PERSISTED compiled plan (never from a
declaration argument and never by recompiling), and
`OutcomeGraphRuntime.submit` derives the attempt from the state and the
submission id from the proposal's canonical digest, so forging any of them
cannot move the execution (a test forges all of them). The result carries the
decision, the ledger verdict (including `replayed`), a rejected decision's
per-requirement outcomes, and structured repair diagnostics on a refusal — which
writes nothing. A LEGACY v2 graph is refused BY NAME before a ledger is opened:
the signal protocol owns that graph, and this ingress never synthesizes an
answer for it.

RESTART RECOVERY IS REAL, AND IT REUSES THE SAME PLAN.
`OutcomeGraphRuntime.resume` reads the graph state from the LEDGER, refuses a
record bound to another graph or another plan revision, and continues from that
state: a `pending` dispatch effect the state corroborates is launched (the
crash-after-commit-before-launch window) after being durably marked `started`,
a `started` effect a dead process left behind is REPORTED as unsettled and
never re-launched or dropped, and every node the state records as in flight is
reported as armed with the attempt a submission must settle. Marking the effect
`started` BEFORE the seam runs is what makes a second resume dispatch nothing.
A graph with NO state is a FIRST EXECUTION from the runtime's plan — the same
saved plan a later recovery reads back. `src/graph/outcome/recovery.ts` is the
composition seam: it reads the persisted plan and its binding, refuses a
missing plan (`missing-persisted-plan`) or a plan/binding revision
disagreement (`plan-revision-mismatch`) by name, and hands the runtime that
plan. `engine-startup.ts` routes every valid protocol-2 record there instead
of skipping it, and reports the optional `outcomeProtocol` bucket —
`started`, `resumed`, `dispatched`, `armed`, `unsettledEffects`,
`refused` — so a resume is evidence rather than a count. A graph whose state
exists is never started from scratch, and a mismatched state is reported and
left exactly as it was. The LEGACY resume entry `EngineRuntime.recover()`
keeps refusing protocol 2 with `protocol_refused`: that guard is the routing
boundary, not a missing capability, and a legacy-only store keeps exactly its
old report shape (the bucket is absent).

THE SUBMISSION INGRESS IS THE ONLY COMPLETION SOURCE — verified, not assumed.
A declared graph is never an entry of the legacy registry, every legacy tool
entry point (`graph_run` including `dry_run`, construction, cancel, approve,
targeted status) refuses it before a node is read, no legacy engine is built for
it, and the outcome runtime neither imports `src/graph/engine/**` nor reads a
severity-ranked signal or a synthesized answer. A test declares and starts a
graph, submits through the ingress, and shows every legacy entry point refusing
with the legacy dispatch port never called.

`EnginePersistence.load()` is NOT a protocol filter: under the shipped registry
a protocol-2 record loads as `valid` and is returned like any other. The guard
lives at the RECOVERY boundary (the legacy `recover()` refusal above, and the
sweep's protocol routing); the stale "legacy null-only compatibility shell"
comment was corrected in C3c to say exactly that.

DEFERRED by this slice, and not implied by it: stage D — moving outcome ROUTING,
loops and natural-completion policy onto the new path, progress evaluators, and
the protocol-aware dispatch COMPLETION BRIDGE (the run path drives a synchronous
scripted seam and performs no bridge selection); stage E — draining or
migrating legacy executions and retiring the legacy execution path; effect
EXECUTION beyond calling the dispatch seam (an effect is recorded and launched,
never retried by a second process); and the contract/validator registries'
POLICY layer (which requirements are mandatory, and the schema,
command-check and approval validators). Storage format 3 with its `2 -> 3`
migrator and the `src/graph/persistence/load.ts` module move also remain
deferred. Legacy v2 graphs keep their file persistence and their run and
recovery paths unchanged: nothing in C3c alters them.

D2 MAKES ATTEMPT IDENTITY A RUNTIME-ISSUED, ATTEMPT-SCOPED BEARER
CREDENTIAL — AND RESOLVES A SUBMISSION BY IT, NEVER BY THE NODE.

The defect this closes was reproduced end to end: in a loop graph a late
submission for `work#1` was accepted, `work` was re-armed as `work#3`, and the
SAME late message was accepted AGAIN against `work#3`, because identity was
derived from the node's CURRENT attempt (`state.nodes[i].attemptId`) and the
submission carried nothing that named an attempt.

`src/graph/outcome/attempt-credential.ts` owns the credential: a high-entropy
nonce (32 bytes from the platform CSPRNG, hex) minted by the runtime AT ATTEMPT
CREATION and bound to `graphId + nodeId + attemptId + planRevision +
permission` (`submit-outcome` is the one permission this protocol issues). The
nonce is written into that attempt's own state entry — the body carries
`graphId`/`planRevision`, the entry carries `nodeId`, `attemptId` and the nonce
— so the binding is reconstructed from the STATE and never from a submission.
`OutcomeGraphRuntime` injects the runtime source; a test injects a deterministic
one, and `advanceOutcomeGraph` takes the source as an explicit input (its purity
is "pure given its inputs").

THE CREDENTIAL TRAVELS ONLY OVER THE DISPATCH CHANNEL. It is a field of
`OutcomeDispatchRequest` and of nothing else: the dispatch effect PAYLOAD is
credential-free (a payload that carries one is refused as malformed, because
this runtime never writes one), a receipt, an accepted event, the armed report
and the graph state block carry none, the startup sweep reports attempt ids
only, and no log line in the run path prints it. On resume the credential is
re-bound FROM THE STATE ENTRY of the attempt the effect names — never from the
effect, which does not carry it — and a launch that cannot find one is refused
(`credential-missing`) rather than handed a fresh credential for a new
execution.

THE RESOLUTION ORDER IS THE RULE. `submit` resolves the credential against the
persisted state FIRST and only then consults the execution state. A known
credential binds the submission to exactly the attempt it was issued for; an
unknown, tampered or superseded one is `credential-unknown` and another node's
is `credential-node-mismatch` — both with `$.credential` — and the node's
CURRENT attempt is never substituted. A credential whose attempt is still the
node's recorded (settled) attempt keeps resolving to it, so a repeated
submission still replays the persisted receipt; a credential whose attempt a
loop round has superseded is refused, never accepted against the newer attempt.
`attemptId`/`submissionId`/`planRevision` remain unknown keys: the credential
proves possession of an attempt, it does not let a caller name one.

THE PROPOSAL CARRIES THE CREDENTIAL, SO THE DIGEST COVERS IT.
`OutcomeProposal` gains an OPTIONAL `credential` (closed shape, non-empty
string, `$.credential`); normalization and `proposalDigest` include it when
present, so two submissions that differ only in their credential are different
submissions and an old credential cannot collide with the receipt committed
without it. Absent is legal at the shape gate because whether a submission may
proceed without one is the RUN PATH's refusal (`credential-missing`), not a
shape question. The acceptance core neither reads nor needs it: the runtime
hands it the attempt it resolved.

BODY VERSION 2 ADDS THE FIELD, AND VERSION 1 STAYS READABLE.
`attemptCredential` is required on a `dispatched`/`settled` node entry of body
version 2 and forbidden on a `pending` one; version 1 (the previous layout) is
still installed as a reader because its bodies are well-formed snapshots — but
an ATTEMPT a version-1 body records carries no credential, so recovery refuses
to launch it and reports it as refused instead of armed, a submission for it is
`credential-unknown`, and the reducer refuses to advance a state that cannot
carry a credential (`unsupported-state-version`). There is no migrator: a
credential is issued once, at dispatch, and one invented on read would be a
capability the worker does not hold.

WHAT A BEARER CREDENTIAL PROVES — STATED HONESTLY. It proves POSSESSION of the
nonce: guessing it is infeasible, and it cannot be re-aimed at another attempt
because the binding is checked against the runtime's own state. It does NOT
prove that the presenter is the original worker: whoever can READ the
credential — the dispatch channel, or the store it is persisted in — holds the
same bearer token and is indistinguishable. This build writes the ledger as an
ordinary file under the configured store root
(`<stateDir>/.rolebox/state/graph-acceptance-ledger.sqlite`), so a
same-account process — including a dispatched worker with ordinary file tools —
can read every resident attempt's credential and be accepted for it. NOTHING IN
THIS BUILD PREVENTS THAT READ, and the two gestures that are sometimes offered
as a boundary do not create one: moving the file to another directory of the
same account changes no access, and a read-only mount stops writes, not reads.
THIS REPOSITORY'S DEFAULT DOES NOT MEET THE REQUIREMENT; `stateDir` defaults to
the workspace, so the ledger sits inside the tree a worker can read.

BECAUSE THE BOUNDARY CANNOT BE A PROPERTY OF THIS BUILD, IT IS AN ENABLEMENT
CONDITION (D7). The outcome run path — `start`, `resume`, `submit`, the
`graph_submit_outcome` ingress and the startup sweep — refuses with
`credential-isolation-unavailable`, BEFORE reading or writing anything, unless
the HOST injects a version-1 credential-isolation adapter declaring a protected
credential store (`credentialStoreRoot`, where the ledger is then opened) and
per-attempt delivery. The adapter is an ASSERTION by the host, not a proof:
this build checks its shape and presence, never the filesystem, because no path
comparison is evidence about what another process can read. A trusted host
invocation context (session, agent) can only ADD a constraint — this build
records none on an attempt and therefore claims none; the core depends on no
host.

ENFORCED BY TESTS. A late credential across a loop round is refused (the
reproduced defect), a cross-node credential is refused, a tampered credential is
refused, a duplicate after a restart replays its original receipt and settles no
new attempt, a version-1 attempt is refused on recovery and on submission, and
the credential is shown present in the state row and absent from the effect
payload, the receipt, the accepted event and the recovery report.

D3 MAKES A CONVERGENCE NODE ARM BY ITS DECLARED JOIN, EXACTLY ONCE, AND PERSISTS
WHO HAS ARRIVED.

The defect this closes was reproduced end to end: in the diamond
`arb -> {brc, crb} -> djoin` with `join: { strategy: "all" }`, the dispatches
were `["arb#1","brc#2","crb#3","djoin#4","djoin#5"]` — `brc` completing armed
`djoin`, `crb` completing armed it AGAIN, and the persisted state ended on
`djoin#5` with the attempt in flight overwritten. The compiled plan carried the
join configuration all along; the successor-arming loop never read it and armed
every edge target unconditionally.

THE ARRIVAL SET IS THE JOIN'S INPUT, AND IT IS PERSISTED. Each node entry of
state-body version 3 carries `arrivals`: one `{ from, outcome, attemptId }`
record per feeder that has arrived, in plan node order. A feeder has arrived
exactly when it is SETTLED on its current attempt with an outcome a declared
edge routes from it to the target — the same "latest accepted result per
predecessor" fact the legacy evaluator reads from `upstreamResults` — and the
list is the CANONICAL MATERIALIZATION of that fact, recomputed by one function
after every advance and written inside the acceptance transaction that produced
it. The reader verifies the list against the plan's edges AND the node entries,
so a snapshot that omits an arrival its own entries corroborate (a stalled join)
or invents one they do not (an unearned arm) is `malformed-state` rather than
trusted or silently corrected. A restart therefore decides the join from the
state, not from a re-derivation a caller might perform differently.

THE ARM RULES. A successor is armed only when its declared join is satisfied;
until then NOTHING is armed — the acceptance still commits (the outcome is a
real, accepted result) and the only write is the arrival record itself: no
attempt id, no `dispatched` status and no dispatch effect exist for a node
whose join is unsatisfied. When the join IS satisfied the node is armed exactly
once, on a fresh attempt with a fresh credential, and a node already
`dispatched` is never armed again — which is what makes two feeders completing
out of order unable to overwrite the running attempt. A candidate the advance
arms can be re-entered only through the existing re-entry rule (a settled target
the emitting node shares a declared loop group with); that check still runs once
per candidate, before anything is applied, and its refusal rolls back the whole
acceptance.

THE STRATEGY IS RESOLVED, NOT REIMPLEMENTED. `resolveJoinStrategy` and
`readQuorum` moved to the dependency-leaf module `src/graph/join-strategy.ts`
and are re-exported unchanged from `src/graph/engine/join-evaluator.ts`, so the
legacy signal engine and the outcome reducer read one `join` declaration
through ONE resolver instead of two that could drift. What the reducer does NOT
reuse is the evaluator itself: `evaluateJoin` is defined over
`EngineState`/`NodeRuntimeState` and per-source `EdgePayload` signals, and
importing its module would drag `src/graph/engine/engine-persistence.ts` (file
I/O) into the outcome run path, which is deliberately free of
`src/graph/engine/**`. The outcome rule is therefore the equivalent
satisfaction predicate over arrivals: `all` requires every distinct feeder,
`any` at least one, `quorum:N` at least N. The ONE semantic difference is
stated where it lives: the legacy evaluator counts severity-ranked signals and
can return `failed` (a non-answer terminating signal aborts an `all`/`any`
join). The outcome protocol has no severity ranking — an outcome either routes
along a declared edge or terminates its node — so there is no failure
vocabulary to mirror, and an unsatisfied join WAITS. Waiting is chosen over
refusing the acceptance because a refusal would leave the emitting attempt
unsettled forever (its outcome was legitimately accepted) and would strand a
join that a later arrival is supposed to satisfy; a join that can never be
satisfied stays visibly pending instead of being silently failed or completed.
A feeder that terminates without routing to the target never arrives; it does
not fail the join.

ROUNDS DO NOT MIX. An arrival is scoped to the attempt that produced it, so a
feeder that has been re-armed is no longer settled and its earlier answer stops
counting the moment its new attempt starts. The arm set for one advance is
computed as a whole: a candidate this advance arms is treated as already in
flight and is therefore not evidence for another candidate armed beside it, and
the self-consistent set is found by a monotone fixpoint that does not depend on
the order candidates are examined in. The removal is MONOTONE: a candidate that
fails while the candidates still standing are suppressed is never reconsidered,
because dropping it can only add arrivals for the rest, so the not-armed set
grows to its fixpoint in at most one round per candidate and cannot stop on the
parity of the candidate count. A dependency CYCLE among candidates therefore
arms NONE of its members on that advance — each member's required arrival
belongs to another member being re-armed beside it — and the cycle waits for an
arrival that is not itself superseded, the same WAIT any unsatisfied join gets.
A loop's convergence node therefore cannot be armed on the previous round's
arrival of a branch that is being re-armed in the same breath, and round N+1's
join cannot be satisfied by round N's evidence.

BODY VERSION 3 ADDS THE FIELD, AND VERSIONS 1 AND 2 STAY READABLE. `arrivals`
is required on every node entry from body version 3 onward — the current layout
is version 6 — and forbidden on versions 1 and 2, whose readers refuse it
rather than dropping it (a version-2 body carrying an `arrivals` list is
`malformed-state`). A body of version 1 to 4 is refused with
`unsupported-state-version` rather than rewritten in a newer layout: version 1
records no credential, version 2 no arrivals and version 4 no progress baseline.
Version 5 is the one older layout that IS advanced, and only by recomputing its
progress counters (see the loop-progress rule below). As
with the credential, there is no migrator: an arrival is a fact about an attempt
that already settled.

ENFORCED BY TESTS. The diamond arms `djoin#4` exactly once, and only when the
last feeder answers — the first feeder's completion dispatches nothing and
leaves no attempt on the join node; with `join:any` a second arrival while the
node is in flight leaves its attempt id unchanged (the reproduced overwrite); a
restart decides the half-arrived join from the persisted arrivals and arms it
once when the second feeder finally answers; and in a loop the two-branch join
is re-armed once per round only after BOTH branches have answered in that round,
so a single round-2 arrival cannot re-arm it. A three-candidate dependency
cycle arms nothing on the advance that would have re-armed all three together,
keeps every member on the attempt it settled on, and then advances one member at
a time once an arrival that is not itself superseded reaches it. No existing
assertion encoded the old overwrite; the reducer, reader and version tests were
extended rather than rewritten.

D4 MAKES A HARD LIMIT END THE RUN IN A PERSISTED STOP, IN THE ACCEPTANCE
TRANSACTION (defect 3).

The defect this closes was reproduced end to end: a continuation past a loop
group's `max_traversals` was refused (`loop-limit-exceeded`, zero writes) and
the graph then stayed `phase: executing` FOREVER with the emitting node
`dispatched` — no durable stop, no reason, no round, no recovery rule and no
legal way to finish short of a forged approval. The refusal was right; what was
missing was an ending.

A CAP NO LONGER ROLLS THE ACCEPTANCE BACK. The outcome that asks for the
over-cap round is a real, ACCEPTED result: its node settles, its receipt and
its accepted event commit, and the reducer refuses only the CONTINUATION — the
round is not taken, the group's counter does not move (it stands ON the cap)
and NO successor of that outcome is armed, so not even a branch the outcome
also routes to is started. The stop travels out of the reducer inside the state
the same acceptance transaction writes, so the commit is one batch: receipt +
accepted event + pending effects + graph state. A crash therefore leaves either
the previous state with nothing committed (the submission is retryable) or the
stopped state with its receipt — never "the continuation was refused and no
stop was recorded", and never "the stop was recorded and the state did not
move". `phase` becomes `stopped`, which is deliberately NOT `complete`:
`complete` says the run has no work left, while `stopped` says it was cut short.

THE REASON VOCABULARY IS CLOSED AND MACHINE-DECIDABLE.
`src/graph/outcome/graph-state.ts` owns `OUTCOME_STOP_REASONS` — today exactly
`loop-exhausted` — and `OutcomeStop`, a union discriminated by it. Every member
is a condition the runtime decides from the plan and the persisted state, never
a judgement about the work ("review passed", "failed") and never something
derived from a worker's prose. A persisted body carrying a reason this build
does not define is `malformed-state`, so a reader never reports a stop whose
meaning it does not have. `loop-limit-exceeded` is RETIRED as a refusal code:
the decision it named is now the stop REASON, and keeping a refusal code no
path can produce would claim a vocabulary this build does not have. A further
stopping policy (the deferred progress evaluator, which needs a declared
stopping policy in the plan) extends the union with a member, its shape and a
reader case — it never widens an existing reason.

THE STOP FABRICATES NO SETTLEMENT. It settles exactly the node whose outcome
was accepted and writes exactly that outcome's accepted event: it substitutes
no exit outcome for the continuation it refused, invents no attempt, and
settles no node that did not answer. A node still recorded in flight stays in
flight — no outcome settled it, so nothing is written for it. A test asserts
the accepted-event stream is exactly the workers' answers in order, with no
event for the loop's exit outcome, and that every settled node is corroborated
by exactly its own event.

THE STOP IS THE WHOLE RUN'S, AND THAT IS A STATED DECISION. A capped loop
could in principle be stopped on its own while other branches keep running;
this protocol does not do that. The reasons are where the decision lives (the
reducer's own comment): an accepted outcome routes as ONE transition, so
arming only part of its successors is a state the model cannot describe; the
declared caps are run-level resources of one graph; and a graph that continued
past a capped loop would eventually report `complete` — the phase a run that
finished properly reports — for a run that was cut short. So `phase` becomes
`stopped`, in-flight branches are left exactly where they are (not settled, not
dropped, not re-armed), and `advanceOutcomeGraph` refuses to advance a stopped
state at all: a submission from any branch is refused with `graph-stopped`
(naming the reason, the group and the cap) and writes nothing.

RECOVERY READS THE STOP, REPORTS IT AND CONTINUES NOTHING. `resume` reads the
graph state from the ledger as before and, when it carries a stop, launches NO
effect (not even a `pending` one the crash window left behind), marks no effect
`started`, arms NOTHING, and answers `resumed` with the `stop` record itself, an
empty armed list and a `graph-stopped` refusal per node still recorded in
flight. Reading and reporting are the whole call, so a second resume is
idempotent by construction: the same report, the same row, no writes. The
startup sweep reports the stop twice over — in the resume line (`phase stopped,
STOPPED by loop-exhausted (loop …, round n/m, attempt …)`) and in its own
`outcomeProtocol.stopped[]` bucket — so a run that ended on a declared hard
limit is never counted as one that merely continued.

STATE-BODY VERSION 4 ADDS THE FIELD, AND VERSIONS 1 TO 3 STAY READABLE. The
body gains a `stop` record that is present EXACTLY when `phase` is `stopped`;
a `stopped` body without one and a running body that carries one are both
`malformed-state`, because the phase and the record are one fact written twice.
The phase vocabulary is per-layout too: versions 1 to 3 cannot produce
`stopped`, so a version-3 body carrying either the phase or the field is
refused rather than read with a meaning its writer never had. The reader
verifies the stop against the plan and the very entries it is stored beside —
the group must be declared, its cap must be the plan's, the node must be a
member, the outcome must be that group's continuation, the node's entry must
be SETTLED on that attempt with that outcome, the round must equal the recorded
counter, and that counter must equal the cap (the round that would have
exceeded it was never taken) — so an invented stop is refused rather than
trusted and a self-contradicting one is refused rather than corrected. There is
no migrator, as with the credential and the arrivals: a stop is a fact about a
decision the run took, and one invented on read would fabricate the ending.

ENFORCED BY TESTS. The over-cap submission is accepted with a durable
`loop-exhausted` stop (reason, group, round, cap and trigger attempt) and zero
dispatches; the counter stands on the cap; a branch that is still in flight is
left in flight and its outcome is refused with `graph-stopped`; repeating the
stopping submission replays its receipt, moves nothing and clears nothing; the
accepted-event stream contains only the workers' answers; the three existing
assertions that encoded "refused, still executing, nothing written" were
REWRITTEN to the new contract (each carries the reason it changed); the reader
refuses every self-contradicting or out-of-vocabulary stop; and a restart
reports the stop, launches and arms nothing, dispatches nothing on a second
sweep, and leaves the row byte-identical.

DEFERRED by this slice, and not implied by it: the progress evaluator and the
declared stopping policy that would produce a `progress-stalled` reason, effect
EXECUTION beyond the dispatch seam, the protocol-aware dispatch completion
bridge, storage format 3 with its `2 -> 3` migrator, the
`src/graph/persistence/load.ts` module move, adapters/schema compatibility, the
typed-predicate vocabulary, and any `src/dispatch/**` change.

D5 DELIVERS THE PROGRESS PROTOCOL: A PROJECTION BUILT OUTSIDE THE ACCEPTANCE
TRANSACTION, A THREE-WAY COMPARISON INSIDE IT, AND A PERSISTED STOP THE DECLARED
THRESHOLD PRODUCES.

A COMPILED LOOP GROUP MAY DECLARE A PROGRESS POLICY.
`CompiledLoopGroup.progress` is `{ evaluator, version, subject, maxUnchanged }`,
declared in the v3 grammar as `progress: { evaluator, version, subject,
max_unchanged }` on a loop group and covered by `planRevision` like every other
plan field. `evaluator` is the comparison SEMANTICS and `subject` the comparison
OBJECT (one field of the continuation outcome data); `version` is the EXACT
evaluator version and `maxUnchanged` the EXPLICIT stagnation threshold. Absent
means the loop declares no comparison at all: its continuations are never
measured and the hard cap alone bounds the run. The grammar is closed as
everywhere else (`unknown-key`, `wrong-type`, `invalid-value`), and the compiler
and the plan inspector share ONE reader and ONE code
(`malformed-progress-policy`), so a declaration boundary and a load boundary
cannot disagree about what a policy is. Whether this build IMPLEMENTS the
declared evaluator is deliberately NOT a structural question — it is a run-path
refusal (`progress-evaluator-unavailable`), because capability resolution is not
a property of the declaration.

THE PROJECTION IS PRODUCED OUTSIDE THE TRANSACTION, AND IT IS BOUNDED AND BOUND.
`src/graph/outcome/progress.ts` owns `projectProgress`, a pure and total
function that runs in the run path BEFORE the acceptance transaction opens. It
reads the declared subject ONCE (own-property lookup, so `__proto__` names a
missing field rather than an inherited object), reduces it to a revision token
of at most `PROGRESS_VALUE_MAX_LENGTH` (256) UTF-16 code units, and binds the
result to the proposal digest, the attempt, the plan revision and the graph —
the acceptance core own validation binding — plus the evaluator identity and
version. What travels into the transaction is that bounded value, never the raw
payload and never a digest computed there: reading the payload, truncating it
and binding it all happen outside, which is exactly why a large or
unrepresentable payload cannot make the serialized commit do file or hashing
work. NOTHING OF THE PROJECTION IS PERSISTED as such; what is persisted is the
BASELINE (the last comparable token, at most the bound) and the counters.

A REQUIRED SUBJECT IS REFUSED, NOT ANSWERED "UNKNOWN". When a declared policy
governs the submitted outcome, the declared subject is required: absent, or
present as an explicit `undefined`, is `progress-subject-missing` at
`$.data.<subject>` with nothing written, so the worker repairs the submission and
the same attempt settles on the repaired one. A value that is PRESENT but not a
non-empty string (a number, a boolean, `null`, an object, an array, an empty
string) is legal payload that this evaluator cannot compare: it is UNKNOWN, and
it is never coerced into a token, because coercion would let two different JSON
values look equal and turn an incomparable submission into an invented
"unchanged". A value longer than the bound is `truncated` and compared as
unknown too: a prefix comparison is not a comparison.

THE COMPARISON HAS THREE ANSWERS, AND THE TRANSACTION DOES ONLY FOUR THINGS.
Inside the acceptance transaction the reducer reads the persisted entry, compares
it with the projection it was handed, updates the counter and writes the result
in the SAME batch as the receipt, the accepted event and the pending effects:

- `progressed` — the token differs from the baseline, whether a baseline existed
  or not. A FIRST comparable observation ESTABLISHES the baseline and answers
  `progressed`: there was no earlier value to stand still against, so the run
  has not been observed to repeat itself. The baseline is replaced and the
  counter resets to zero;
- `unchanged` — the token equals the baseline. Only this answer increments the
  counter, and the counter is persisted with the baseline;
- `unknown` — the comparison could not be made: the persisted entry was recorded
  under another evaluator identity, version or subject
  (`evaluator-identity-mismatch`), or the observation is truncated or
  incomparable. The counter is CLEARED, while the baseline and the recorded
  identity and version are kept. An unknown never reaches the threshold itself,
  so it never triggers the soft stop; clearing is what makes the threshold mean
  consecutive COMPARABLE repetition, because a streak carried across a round
  nobody compared would stop the run on repetitions never observed back to back.
  The declared HARD limits still apply to the run.

A MODEL-SUPPLIED REVISION IS NOT PROGRESS BY ITSELF. The comparison object, the
comparison semantics and the evaluator version are DECLARED by the plan and
PERSISTED with the baseline; a payload that merely contains something
revision-shaped is never consulted for what to compare or how. The evaluator
VERSION in particular is a compatibility fact: a persisted baseline recorded
under another version yields `unknown` rather than `unchanged` or `progressed`,
because the meaning of "changed" may itself have changed. The reader deliberately
ACCEPTS such a record (it verifies the evaluator identity and the subject against
the plan, but not the version), so the comparison — not the shape check — decides
compatibility, and no whole body is refused over a number.

SUCCESSFUL OUTCOMES NEVER ENTER THIS PATH. A projection is produced only for an
outcome a declared policy governs: the group must declare the submitted outcome
as its `continuationOutcome` and the submitting node as a member. The outcome
that leaves the loop, terminates its node, or routes anywhere else is not
measured, requires no subject and cannot be refused for one — the
revision-staleness question belongs to continuing a loop, never to a result the
loop accepted as finished.

A DECLARED THRESHOLD ENDS THE RUN IN THE SAME PERSISTED STOP AS A HARD CAP.
`OUTCOME_STOP_REASONS` gains `progress-stalled` and `OutcomeStop` its second
member, `OutcomeProgressStalledStop`: the group, the node, the outcome and the
attempt that carried the last unchanged comparison, the count (EQUAL to the
declared threshold, because the comparison that reached it was made and the round
it asked for is the one not taken), the threshold, the evaluator identity and
version, the subject and the baseline token the run stood still on. The outcome
itself stays ACCEPTED, its node settles, no successor of it is armed — not even a
branch beside a stopping one — and `phase` becomes `stopped`, so a stalled run is
never reported as one that finished. The stop travels out of the reducer inside
the state the same acceptance transaction writes, so the crash window cannot
separate the acceptance from the ending; `resume` reports the stop, launches and
arms nothing, and a submission from a branch still recorded in flight is refused
with `graph-stopped`, naming the reason. `describeOutcomeStop` is ONE formatter
for the run path and the startup sweep, so a new reason is described once.

REPLAYS DO NOT DOUBLE COUNT. A repeated submission of the same attempt replays
its receipt, the join contributes no state write and no comparison runs at all
(an already-settled node returns before the reducer), so the counter keeps the
value the first acceptance wrote. An advance that reaches a declared policy with
NO projection bound to this submission, or with one bound to another attempt,
plan revision or proposal, is refused (`progress-unbound`) rather than skipping
the declared comparison: skipping it would decide the stopping policy from data
the run never measured.

STATE-BODY VERSION 5 ADDS THE RECORD, VERSION 6 FIXES WHAT A COUNTER MEANS, AND
VERSIONS 1 TO 5 STAY READABLE. The body carries `loopProgress`, one entry per loop
group whose plan declares a policy
(`{ loopGroupId, evaluator, version, subject, unchanged, baseline? }`),
materialized at `start()` so a body that never compared anything still says so;
a version that does not define the field refuses one rather than dropping it, and
a missing entry for a declared policy is refused rather than read as "no
baseline yet". The reader verifies the entry against the plan (identity and
subject) and against the stop (count, baseline, version) and refuses a counter
above its threshold or standing ON it without the stop. There is NO MIGRATOR, as
with the credential, the arrivals and the stop: a baseline is a fact about
comparisons the run actually made, and one invented on read would decide
stagnation from data the run never observed.

VERSION 6 HAS THE SAME SHAPE AS VERSION 5 AND A DIFFERENT COUNTER MEANING. Version
5 was written before an unknown cleared the streak, so a persisted version-5 count
may span a round nobody compared and cannot be told apart from a trustworthy one.
Version 6 attests the corrected meaning. A version-5 body is READABLE — its
completed graphs report cleanly and its stop is verified against its own record —
and it is ADVANCED only by recomputing every counter from zero, keeping the
baselines, the evaluator identity and the version, in the same transaction that
rewrites the body in version 6. The recomputation is conservative in one direction
only: it can delay a stop, never fabricate one, and it happens once per body
because a version-6 counter is produced by the comparison alone. Versions 1 to 4
are never advanced: version 4 has no baseline at all, and advancing it would
silently restart the counters and re-baseline the comparison — the accidental
reset recovery must not perform — so such a body is refused with
`unsupported-state-version`.

ENFORCED BY TESTS. The three answers each have a case (a first token establishes
the baseline and answers progressed, a repeated token is unchanged, a truncated
or non-token value is unknown); a truncated value that STARTS WITH the baseline
is still unknown, never a prefix match; an unknown CLEARS the streak, so the next
comparable unchanged token counts one and only the one after it reaches a
threshold of two, and an unknown itself never stops the run; a baseline recorded
under another evaluator version answers unknown with its identity and baseline
kept and its counter cleared; a version-5 body's counter is recomputed rather
than trusted, so a count that would have reached the threshold under the old
counting does not stop the run and the advance rewrites the body in version 6; a
continuation without the declared subject is refused with
`progress-subject-missing` and the repaired submission settles the same attempt;
a plan declaring an unimplemented evaluator is refused by name; a replayed
continuation does not move the counter, so a threshold of three is not reached by
a duplicate; the exit outcome of the loop is measured by nothing and requires no
subject; the stopping submission is accepted with a durable `progress-stalled`
stop, commits one receipt and one accepted event with the stopped state, leaves a
beside branch in flight and refuses its outcome with `graph-stopped`; and a NEW
PROCESS resuming the same store continues the same comparison — same baseline,
same evaluator version, counter continued — which is also what the two-process
self-verification probe shows.

DEFERRED by this slice, and not implied by it: effect EXECUTION beyond the
dispatch seam, the protocol-aware dispatch completion bridge, storage format 3
with its `2 -> 3` migrator, the `src/graph/persistence/load.ts` module move,
adapters/schema compatibility, the typed-predicate vocabulary, and any
`src/dispatch/**` change. The evaluator registry is deliberately a closed
one-implementation set rather than a plugin surface: `revision-token` is the
comparison this build implements and any other declared identity is refused,
never silently approximated.

D6 MAKES NATURAL COMPLETION AUTHORIZED DATA: REPOSITORY-VERSIONED POLICIES,
HOST-INSTALLED BY CONTENT, PINNED IN THE PLAN, AND A RUN PRECONDITION.

The defect this closes is an authority gap rather than a crash: the v3 grammar
and the compiler already carried a node's `completion: { mode: "natural",
outcome }` request into the plan, but nothing separated "the author asked" from
"a trust boundary granted it". Any declaration could therefore produce a plan
whose natural completion no policy had authorized, and the plan looked exactly
like one whose completion an operator had approved.

WHERE THE DECLARATIONS LIVE. `src/graph/policy/declarations.ts` is this
repository's own catalog: reviewed source, one immutable `revision` per
declaration, versioned by git. A declaration's digest is the ONE canonical
`contractDigest` over its body — there is no second digest — so an
authorization names exact CONTENT rather than a mutable file, and a body edited
after review stops matching the digest that was authorized. The declarations are
deliberately NOT policy files in the workspace: the working tree is writable by
the very workers a graph runs, so a policy document dropped next to a graph
would let it authorize itself. "A file is committed in the repository" is not
authority either, for the same reason.

THE DECLARATION SHAPE AND THE DECISION TABLE. A body is
`{ version: 1, default: "deny" | "ungranted", rules: [{ graphId, nodeId,
outcome, decision: "allow" | "deny" }] }`. Matching is EXACT on all three of
graph, node and outcome — no wildcard, no prefix, no case folding — and the
reader refuses a declaration that decides one mapping twice, so the answer never
depends on rule order. A mapping no rule lists answers the body's declared
`default`: `"deny"` means the policy explicitly forbids what it does not
list, while `"ungranted"` means it is SILENT — not granted, and not forbidden.
The repository ships the same policy id at two revisions that differ exactly
there: `@1` grants nothing and forbids nothing, `@2` denies every natural
mapping.

THE HOST DECIDES; THE DIGEST PROVES. `loadCompletionPolicies({ catalog,
authorized })` takes the host's trusted list of exact `{ id, revision, digest
}` refs plus a catalog, and admits a declaration only when the host authorized
that identity AND the catalog body hashes to the authorized digest; a body that
is malformed, missing, tampered, or authorized twice with conflicting digests
installs nothing and is reported. A catalog entry the host did not authorize is
reported `not-authorized` and is NOT installed. The compiler and the runtime
receive only the resulting registry through `CompileOptions.completionPolicies`
and the runtime's `completionPolicies` option (recovery, the startup sweep, the
toolset's `graph_submit_outcome`, and `graph_declare`'s HOST dependency);
neither reads a file, and the declaration itself can only REQUEST a revision —
the grammar has no field for rules, a request that carries extra keys is refused
as `unknown-key`, and rules inlined into a raw declaration are never read.

THE FOUR OUTCOMES OF THE DRAFT RULE TABLE, EACH WITH ITS OWN CODE.
A natural mapping (a node whose `completion` is natural, naming a declared
outcome) is resolved against the graph's `completion_policy` request:

- the request is absent, or the compilation has no installed capability → a
  NON-EXECUTABLE DRAFT whose `unauthorizedCompletions` names the mapping and
  `completion-policy-unavailable`; an unknown policy id is
  `completion-policy-unknown`, an uninstalled exact revision is
  `completion-policy-unknown-revision`, and a resolved policy that is silent
  about the mapping is `completion-policy-ungranted`. The node's declared
  policy is NOT rewritten to `explicit`: "keep explicit" means "do not enable
  unauthorized natural completion", never "silently change what the author
  declared";
- the resolved policy EXPLICITLY denies the mapping (by rule, or by its
  declared deny-by-default) → the compile is REFUSED with
  `completion-policy-denied` at `nodes.<id>.completion`. Silence is never
  reported as a denial: "not authorized (yet)" and "forbidden" are different
  answers with different next steps;
- the resolved policy GRANTS the mapping and the required acceptance capability
  is complete → an EXECUTABLE plan that PINS the authorization: the plan body
  carries `completionAuthorizations` (node, outcome and the exact policy ref),
  `completionPolicySnapshots` (the declaration body, keyed by digest) and
  `completionPolicyIdentities` (`id → revision → digest`), all covered by
  `planRevision`. The load gate recomputes the body digest over those fields
  too, so the writer's own output stays loadable;
- a PERSISTED executable plan is resumed in a process that does not hold the
  policy it pins → recovery is BLOCKED with the state preserved. The runtime
  corroborates every pinned ref against the installed capability BEFORE it
  reads or writes anything: no capability is
  `completion-policy-unavailable` (naming the pinned policies), an
  uninstalled id or revision is reported by name, and a revision installed with
  different content is `completion-policy-digest-mismatch` — the plan's pinned
  digest is the authority and is never re-bound to a republished body.

THE INSPECTOR OWNS THE PLAN-LEVEL RULE. `inspectCompiledTopology` gained the
completion bundle: an EXECUTABLE plan must pin exactly one authorization per
natural mapping (`missing-completion-authorization`), every pinned
authorization must name a mapping the topology really declares as that node's
natural completion (`unknown-completion-authorization`), and every pinned ref
must be corroborated by the snapshot and identity the body carries
(`inconsistent-completion-policy`). A draft is not held to completeness — its
unauthorized mappings are exactly why it is a draft — but its draft reasons must
come from the closed vocabulary, so a persisted reason this build does not
define is refused rather than read with an invented meaning.

NATURAL COMPLETION AND EXPLICIT SUBMISSION SHARE ONE TRUSTED ATTEMPT AND ONE
ATOMIC BOUNDARY. The authorization is plan-level and therefore covered by
`planRevision`, which is exactly what the D2 attempt credential binds
(`graphId + nodeId + attemptId + planRevision`): an attempt that may settle a
node is bound to the exact policy revision its plan pinned, republishing the
policy produces a different plan revision and so a different attempt identity,
and there is no second channel in which an old attempt could meet new
authorization semantics. The capability check is a precondition of the ONE run
path: `start`, `resume`, `submit` and `settleNatural` all consult it
before any state is read, so a plan this process cannot support does not advance
one step under weaker semantics — the blocked recovery writes nothing, including
no effect transition (the D4 atomic boundary) — and a natural mapping never
acquires a settlement channel of its own. What D6 fixes is that a plan whose
completion authorization is missing, denied or unsupported can never run, reach
a receipt, or pass a stop boundary at all.

THE SETTLEMENT RUN PATH REUSES THAT ATTEMPT AND THAT ATOMIC ENTRY. The runtime
entry point it compiles for is `settleNatural(delivery)`: the host's dispatch
completion bridge presents one attempt's completion fact as a STRICTLY closed
envelope — the node, the attempt, and that attempt's bearer credential, and
nothing else. The envelope names no outcome and carries no payload, no evidence
list and no completion metadata (an extra field is `malformed-natural-delivery`
at its own path), because a completion fact that could route a result would be a
second submission channel in disguise. The node and attempt are CROSS-CHECKS
against the binding the runtime persisted at dispatch (`credential-missing`,
`credential-unknown`, `credential-node-mismatch`, `attempt-mismatch` with the
offending field's path), never selectors: the attempt is resolved from the
credential. The outcome is then the pinned authorization's — a node with no
pinned authorization, or a node the plan does not declare, is refused
(`natural-completion-unauthorized` / `unknown-node`) and is NEVER downgraded to
the explicit path or settled under a policy that was not authorized. From there
the settlement is the SAME path a submission takes: the proposal is the
canonical `{ nodeId, outcomeId, credential }`, the outcome's declared
acceptance gates run through the same validator registry (a failing gate or an
indeterminate one writes a rejection receipt and leaves the attempt open), and
the receipt, the accepted event, the graph state and the pending effects commit
in the ONE transaction the acceptance core owns. Because the envelope is
content-addressed, a repeated delivery derives the same key and the ledger
REPLAYS the first receipt — one settlement, one accepted event — while a
delivery for an attempt already settled by a different logical submission is
reported `not-committed` with the ledger's `settled` verdict.

THE REPLAY ANSWER IS THE PERSISTED DECISION. A repeated delivery is re-validated
outside the commit like any submission, but nothing that second evaluation
answers can change what the receipt already decided: a first delivery rejected
by a gate stays rejected on every repeat — its content-addressed key can never
be re-decided, and the attempt stays open only for a submission with different
content — and a first delivery accepted stays accepted even if a later
evaluation fails or cannot answer. The answer's state is the state the
settlement left behind, never an advance the transaction did not write.

THE COMBINATION WITH LOOPS, JOINS, STOPS AND RESTART IS ONE STATE AND ONE
TRANSACTION, and it has its own regression suite
(`tests/graph/natural-completion-combination.test.ts`) rather than being
asserted here:

- LOOPS. A natural continuation advances the ONE `loopTraversals` counter an
  explicit submission advances — there is no per-channel counter, because both
  channels reach the same reducer — and it stops through the same durable stop
  when the declared cap binds: the outcome is accepted, the node settles, the
  round is not taken and nothing the outcome routes is armed, inside the
  transaction that accepted it.
- JOINS. A natural completion is a predecessor ARRIVAL: the shared reducer
  materializes it into the durable inbox the join is decided from, the
  convergence node is armed only when its declared strategy (all/any/quorum) is
  satisfied by the arrivals, and it is armed EXACTLY ONCE — an already
  dispatched target is never re-armed and a repeated delivery replays its
  receipt without touching the state. A feeder that has been re-armed is no
  longer settled, so the answer it gave before its new attempt began stops
  counting the moment that attempt starts, while a node still waiting at an
  unsatisfied join keeps the arrivals that are its reason to wait.
- PROGRESS. A continuation a declared progress policy governs is REFUSED
  `progress-subject-missing` (`$.data.<subject>`), exactly as a submission
  without that subject is, because the payload-free envelope carries no
  comparison object and a declared comparison is never skipped. The refused
  round enters `loopProgress` NOT AT ALL — it is refused before the acceptance
  transaction opens, so it can neither grow the unchanged streak nor clear it,
  and the next comparable round still answers against the untouched baseline
  (the combination suite pins this by making that next round reach the declared
  threshold). A natural completion therefore reaches `loop-exhausted` when the
  hard cap binds and can NEVER reach `progress-stalled`: no natural round is
  ever compared. An outcome the policy does not govern — the loop's exit
  outcome, for example — needs no subject and is measured by nothing, exactly
  as an explicit exit is.
- STOP. A completion fact delivered for an attempt the state still records in
  flight after the run has stopped is refused `graph-stopped` and writes
  nothing — no receipt, no accepted event, no state advance — while a repeat of
  the very delivery that stopped the run replays its receipt. The stop and the
  arrivals the stopping round materialized are durable facts, so both read back
  after a restart.
- RESTART. The settled state reads back field for field: the raw state record,
  the parsed state, the accepted-event stream, the effect rows and every
  receipt. Recovery reconciles dispatch EFFECTS only and has no completion
  channel, so an undelivered completion fact is never fabricated into a
  settlement by a restart, and a second resume reports the same state and
  dispatches nothing. A completion fact delivered to a NEW process still
  settles the attempt it was issued for, because the credential binding is
  persisted on the attempt's own state entry, and its repeated delivery replays
  the first receipt across the process boundary.

NO NEW PERSISTED FIELD CARRIES THE COMBINATION. The natural channel writes the
same state body the submission channel writes, and its provenance is the
`natural-completion:<digest>` submission key on the receipt and the accepted
event — not a parallel state field — so the durability rules of the existing
body version cover it unchanged.

THE SOURCE IS READABLE BACK FROM THE DURABLE RECORD. A natural completion is a
distinct logical submission in its own key namespace: the ordinary ingress
always derives `submission:<digest>`, the natural channel derives
`natural-completion:<digest>`, and the receipt row, the accepted-event row and
the acceptance decision all carry that key. The namespace is derived from the
canonical proposal digest (so replay is content-addressed) and can only be
minted by the runtime's own settlement source — a proposal's content cannot
choose it — so "settled by a completion fact" and "settled by a worker's claimed
submission" are told apart without a second store, a log line or a payload
convention.

WHAT IS STILL HOST-SIDE. This build implements and tests the run path above; it
does not ship the production dispatch completion BRIDGE that would observe a
dispatched attempt reaching its end and deliver the fact. Until a deployment
injects one, no natural completion is delivered in production, and the run path
is exercised by the settlement tests instead.

ENFORCED BY TESTS. The four rows each have a case (the codes under a missing
capability and each unresolvable request; a denial by rule and by default; an
authorized executable plan with the policy snapshot, digest and authorization
pinned and read back through the durable record; a blocked recovery whose state
row and effects are byte-identical before and after, and which resumes once the
capability is injected). The authority rules are covered too: a repository
revision is not installed merely because it exists, an edited body fails the
authorized digest, rules cannot be smuggled through the request, a repository
`@1` request is an ungranted draft while `@2` is refused, and
`graph_declare` refuses the draft by name without the host capability and
persists with it. The settlement's combination with the existing run semantics
has its own cases: the one loop counter and its cap stop (with the stop and a
still-in-flight attempt read back after a restart), a natural arrival arming a
join exactly once (and a re-armed feeder's earlier arrival no longer counting),
the progress refusal that leaves the unchanged streak untouched, and the
field-by-field write -> restart -> read -> write-again invariant. The replay
answer's persisted-decision rule has cases in both directions on both channels:
a gate that fails first and passes later still answers rejected (and the
attempt stays settleable by different content), while one that passes first and
fails later still answers accepted with the persisted state.

DEFERRED by this slice, and not implied by it: the HOST implementation of the
dispatch completion bridge that would observe a dispatched attempt completing,
deliver that fact to `settleNatural` and report the settlement it produced;
effect EXECUTION beyond the dispatch seam, storage format 3 with its
`2 -> 3` migrator, the `src/graph/persistence/load.ts` module move,
adapters/schema compatibility, the typed-predicate vocabulary, and any
`src/dispatch/**` change.

E0 DELIVERS THE READ-ONLY DRAIN AUDIT — THE PHASE-E ENTRY POINT, AND NOTHING
ELSE. Stage E is "drain or explicitly migrate legacy executions, then retire
legacy execution support", and its first requirement is evidence: which
persisted graphs are terminal, which still owe work, and which cannot be read
at all. `src/graph/audit/drain-audit.ts` (`auditGraphStore`) produces it over
the same `engine-*.json` set the startup sweep scans, and the additive
`graph_audit` tool exposes it with no arguments (it reads the configured
`stateDir`, default cwd — the same store root the persisted `graph_status`
scan reads). The audit dispatches nothing, recovers nothing, migrates nothing
and compiles nothing.

THE VERDICT IS NOT A COUNT. Every entry is classified three ways: `terminal`
(readable AND quiescent — legacy phase `complete`; outcome phase `complete`
or `stopped`, with the exact phase and the stop reported so "cut short" is
never read as "finished"); `in-flight` (readable and still owed work — a
non-`complete` legacy phase, an outcome phase `ready`/`executing`, or a
declared outcome graph whose ledger holds no state row yet — a ledger STORE
that does not exist at all counts, since nothing has ever been committed to
it — whose first execution is still owed); or `blocked`. A readable entry
names the WORK, not just the phase: a legacy entry carries its per-status node
counts and the ids of the
nodes the engine has not settled, an outcome entry carries every node the
persisted state records in flight (with its attempt, never its credential) and
every effect still `pending` or `started`. `drained` requires ALL THREE of:
no blocker, no in-flight entry, and no unsettled effect — a store whose only
graph is terminal but whose ledger still holds an unsettled effect is
`in-flight`, not `drained`, so "nothing looked non-terminal" is never the
completion signal.

UNREADABLE AND VERSION-UNKNOWN RECORDS ARE BLOCKERS, LISTED INDIVIDUALLY. A
corrupt record, an unknown storage format, an unknown execution protocol, an
acceptance ledger this build must refuse, an outcome state body whose declared
version has no reader, a plan identity that is absent or self-contradicting
(the same three rules recovery applies), and a ledger row the store's own row
gate refuses each become their own blocker with a stable code, its axis, and
file/graph attribution — never a skipped file and never a count. A
`migration-required` snapshot is intact but not executable, so it blocks the
drain until its registered conversion commits. A VALID record under a
registered protocol this audit has no terminality rule for is also a blocker:
an unknown protocol's phase vocabulary is not guessable from outside it.

READING IS STRUCTURALLY READ-ONLY. The audit opens the acceptance ledger
through `SqliteAcceptanceLedger.openReadOnly` — an open that does not create
the directory or the file, never initializes a schema, and holds a connection
whose writes SQLite itself refuses (`createDatabase` gained the read-only open
option for it). A WAL-mode store is refused before a connection exists
(`wal-journal-mode` → a `ledger-refused` blocker): SQLite cannot read a WAL
database without attaching to — and rewriting — its `-shm` side file, so
reading it would change the store being read. The shipped writer is never WAL
(delete journal), so that refusal only answers a store this build did not
write. A store that does not exist answers `absent`, which is a
reading and never a licence to initialize one; for a protocol-2 record that
absent store is reported as an in-flight first execution (`hasState: false`),
not as a blocker, because the run path — never the audit — creates it and
calling the record unreadable would stall the drain on a graph that only needs
its first execution. The regression test snapshots
every file under the audited workspace (SHA-256, size, mtime) before and after
a full audit over a mixed legacy/outcome store INCLUDING the SQLite ledger and
fails on any new, changed or touched file.

DEFERRED by this slice, and not implied by it: every MIGRATION (a
`migration-required` record is reported, never converted), storage format 3
with its `2 -> 3` migrator, the `src/graph/persistence/load.ts` module move,
draining or converting any graph, retiring any legacy execution path, effect
EXECUTION beyond the dispatch seam (an unsettled effect is reported, never
retried or settled by the audit), and any `src/dispatch/**` change.

D7 MAKES CREDENTIAL ISOLATION AN EXPLICIT HOST CAPABILITY AND REFUSES TO RUN
THE OUTCOME PATH WITHOUT ONE.

THE DEFECT THIS CLOSES WAS REPRODUCED END TO END. With the credential gate
absent, a process that only READ the acceptance ledger — a read-only open of
the SQLite file, no write and no rebind, the file byte-identical afterwards —
extracted one attempt's credential and submitted that attempt's outcome with
it: ACCEPTED. A worker holding only its own credential settled another
attempt's node. A bearer token cannot tell who read it, so no check inside the
submission path can fix this: the property lives at the store boundary, and
this build does not have one (see D2).

THE CAPABILITY IS HOST-INJECTED, AND ITS ABSENCE REFUSES THE PATH.
`src/graph/outcome/credential-isolation.ts` owns the contract:
`CredentialIsolationAdapter = { version: 1, id, credentialStoreRoot,
guarantees: { protectedCredentialStore: true, perAttemptDelivery: true } }`,
read by a STRICT closed-shape reader (exact keys, exact version, literal-true
guarantees, non-empty id and root). `credentialIsolationRefusal(adapter)` is
the ONE rule every entry consults; it answers
`credential-isolation-unavailable` with a diagnostic naming the host
obligation, both for an absent capability and for a value this build cannot
read (never downgraded to "it runs anyway"):

- `OutcomeGraphRuntime` takes `credentialIsolation` and checks it FIRST in
  `start`, `resume` and `submit`, before any state is read or written, so an
  unprotected process mints, persists, hands out and settles NOTHING;
- `graph_submit_outcome` refuses BEFORE it opens a ledger, carrying the same
  code and message as its typed `OutcomeSubmissionRefusedError.reason`;
- the startup sweep checks it before opening the ledger and reports the refusal
  in `outcomeProtocol.refused`, leaving the record exactly as it found it — but
  only AFTER the record's own identity (a missing persisted plan, a
  plan/binding disagreement) has been reported by name, so an environment
  refusal never hides a broken record;
- `graph_declare` is deliberately NOT gated: a declaration writes no
  credential, and a declared plan that cannot run is refused at the run path by
  name.

WHERE `credentialStoreRoot` POINTS, THE LEDGER IS OPENED. The ingress and the
sweep open the acceptance ledger at the adapter's declared root instead of the
workspace default, so the host's protected store is the one actually used. It
is a ROUTING instruction, never a check: this build does not compare the root
against the tree, a mount table or permissions, because none of those is
evidence about another process's read access.

THE GATE IS AN ASSERTION, NOT A PROOF, AND THIS DOCUMENT SAYS SO. This build
verifies that a READABLE adapter was injected; it cannot verify that the host's
declaration is true. A host that declares guarantees it does not provide is
lying to the protocol and is undetectable here — which is exactly why the
declaration is the gate rather than a comment. No adapter ships in this build:
`createGraphToolSet`/`createGraphTools` and `recoverInterruptedGraphs` accept
one and nothing installs a default, so a deployment that has not provided a
protected host gets the refusal by construction.

THE EXPOSURE SURFACE IS CLOSED WHERE THIS BUILD OWNS IT. The credential is a
field of `OutcomeDispatchRequest` and of nothing else, and the committed REPORT
surfaces carry none: the ingress result, `graph_status`, the shared
`<graph_state>` block, `graph_audit`, the startup sweep's report, the
runtime's `armed`/`unsettledEffects`/refusal readings and the
`graph_declare` result. The one place the runtime could relay a credential is a
FAILING DISPATCH SEAM: the seam is handed the attempt's credential, and a
failure text that echoes the request (a plausible adapter bug) would otherwise
travel back into the submitting worker's transcript — for `submit` the
launched request is a SUCCESSOR's credential, which the submitter is not
entitled to. `start` and `submit` now sanitize that error text against the
launch set before it escapes (the value is replaced by a fixed marker and the
original is kept as `cause`), and the `dispatch-failed` refusal sanitizes the
text it reports.

ENFORCED BY TESTS. `tests/graph/credential-isolation.test.ts` covers the
refusal at `start`/`resume`/`submit` and at the ingress and the sweep with
nothing written and no ledger created; the strict reader against a version
mismatch, an extra key, a false guarantee and a missing one; the enabled path
end to end with the ledger opened at the declared root; the read-only theft
that is still possible (the honest limitation, with the store byte-identical
across the read); every report channel listed above with a positive control
proving the probe sees credentials where they DO travel; and the seam-failure
redaction.

DEFERRED by this slice, and not implied by it: any host implementation of the
adapter, a store this build protects itself, per-worker filesystem isolation,
platform identity and a signature over submissions, and stage-E retirement.

D8 MAKES FIRST DISPATCH, SUCCESSOR DISPATCH AND RECOVERY ONE PERSISTED EFFECT
EXECUTOR, AND REFUSES A RUN WITH NO DISPATCHER.

TWO DEFECTS WERE REPRODUCED END TO END. (1) With the entry dispatch failing
before delivery, the graph state read `executing` and NO dispatch effect existed
— the intent lived only in the state — so a restart dispatched nothing, refused
nothing and merely reported one armed node: a SILENT ZERO in which nobody could
tell whether work had started and no record named what was missing. (2) A
successor dispatch that SUCCEEDED left its effect row `pending` (only a recovery
ever marked one `started`), so the next process treated the row as un-launched
and created the SAME attempt a second time: the call count went 1 -> 2 for one
attempt.

THE INTENT IS ATOMIC WITH THE STATE. `start` writes the starting snapshot and
the entry attempts' dispatch effects in ONE ledger transaction, and an accepted
outcome still writes the successor's effect in the same transaction as its
receipt, accepted event and state (C2). `AcceptanceLedgerTx.writeEffect`
(`INSERT ... ON CONFLICT DO NOTHING`) is the port method for the intent half: a
row is `pending` when written, an existing row is left exactly as it is, and a
status transition still goes through `markEffectStarted` / `markEffectDone`,
which carry the terminal guard.

A STATUS RECORDS A CALL THAT RETURNED; IT IS NOT A SUBSTITUTE FOR ONE. The row
is marked `started` only AFTER the host's create returned — never before — so
the crash window is a `pending` row, not a row that claims a launch nobody
performed. When the attempt settles, the SAME transaction that settles it marks
its dispatch effect `done`, so a terminal graph leaves no unsettled row behind
and an `unsettledEffects` reading means "work still owed", not "history".

THE HOST ADAPTER OWNS BOTH HALVES (`src/graph/outcome/dispatch-effects.ts`).
`OutcomeDispatchHost = { create(request, effect), lookup(effect) }`, keyed by
the stable `{ graphId, effectId, attemptId }` with
`effectId = "dispatch:" + attemptId` written by ONE function for all three
paths. `create` MUST be idempotent per `(graphId, effectId)` — at most one
execution — and `lookup` answers `created`, `absent` or `unknown` (with a
reason), and says `unknown` rather than guessing. A bare `(request) => void`
seam remains accepted as the degenerate host: it can create, its `lookup` is
`unknown`, and the restriction is visible at every entry rather than hidden.

RECOVERY ASKS THE HOST, THEN ACTS ON THE ANSWER — three answers, three actions:

| Row | `lookup` | Action |
| --- | --- | --- |
| `pending` | `created` | mark `started`, report `reconciled: host-reported-created`; **never** create |
| `pending` | `absent` | create ONCE, then mark `started`; the commit-then-crash window |
| `pending` | `unknown` (or no query capability) | create NOTHING; report `dispatch-unreconciled` for host/manual reconciliation |
| `started` | any | never re-create; report `reconciled: recorded-started` (or, on an `absent` contradiction, `dispatch-unreconciled`) |
| any | attempt settled in the state | mark `done`, report `reconciled: attempt-settled` |

Neither direction of guessing is available: re-issuing a create the protocol
cannot prove absent could run an attempt twice, and reporting success would hide
an attempt that never started. A create that THROWS leaves the row `pending`
(its outcome is genuinely unknown) and reports `dispatch-failed`; the next
recovery asks again. The in-process path (`start`/`submit`) does NOT query
first, and says why: those effects were committed by the transaction that is
running, under attempt ids minted in it, so no earlier process can have created
them — the create is the first attempt, not a retry.

NO DISPATCHER, NO OUTCOME GRAPH. There is no no-op default anywhere. A no-op
would let the run record a dispatch nobody performed (and hand no worker its
attempt credential) while every report read as if the node were running. The
runtime refuses `start`, `resume` and `submit` with `dispatch-unavailable`
before reading or writing anything; `graph_submit_outcome` refuses with the same
code BEFORE it opens a ledger (`OutcomeSubmissionRefusedError.reason`); and the
startup sweep reports `[dispatch-unavailable]` in `outcomeProtocol.refused`
before opening one, after the record's own identity has been checked, so an
environment refusal never hides a broken record. No adapter ships in this build,
so a deployment that has not injected one gets the refusal by construction.

ENFORCED BY TESTS. `tests/graph/outcome-dispatch-effects.test.ts` reproduces
both defects as probes (the failed first dispatch leaves
`dispatch:work#1@pending` and the recovery reports `dispatch-unreconciled`
instead of dispatching nothing; one successor attempt is created exactly ONCE
across a restart, count 1), covers the three host answers and the idempotent
second resume, pins the effect lifecycle (settlement completes the effect), and
refuses the runtime, the ingress and the sweep without an adapter.
`tests/graph/outcome-recovery.test.ts` covers the same paths through the startup
sweep, `tests/graph/submit-outcome-tool.test.ts` through the model-facing
ingress, and `tests/graph/drain-audit.test.ts` the audit's reading of a started
row.

DEFERRED by this slice, and not implied by it: any host IMPLEMENTATION of the
adapter, the protocol-aware dispatch completion bridge, storage format 3 with
its `2 -> 3` migrator, a cross-process effect executor beyond the adapter
contract, and stage-E retirement.

D9 ADDS THE HOST INVOCATION IDENTITY AS AN ADDITIONAL CONSTRAINT, AND MAKES
RESTART RECONCILIATION REPORT ITS DISAGREEMENTS.

THE HOLE THIS NARROWS WAS REPRODUCED IN D7, AND IT IS NOT CLOSABLE INSIDE THE
SUBMISSION PATH. An attempt credential is a bearer nonce: a process that can
read the ledger can copy another attempt's credential and submit that attempt's
outcome. D7 answers that with a store boundary the HOST must provide. D9 adds a
second, independent constraint for hosts that can attribute an invocation: the
host declares WHO is asking, the runtime records that attribution on the attempt
at dispatch, and a submission that settles the attempt must come from the same
attribution — so a credential copied into a different host invocation no longer
settles the attempt it was copied from.

THE HOST ADAPTER CONTRACT, IN FULL, IS FOUR ITEMS, EACH WITH ONE RULE. Three
were delivered by D7 and D8; this slice adds the fourth and states the four
together, because a host deployment has to satisfy all of them to run an outcome
graph:

| Capability | What the host declares | When it is absent | When it is unreadable | Refusal codes |
| --- | --- | --- | --- | --- |
| Protected credential store (D7, `credential-isolation.ts`) | every persisted attempt credential, and the state body inside the ledger, lies outside every dispatched worker's read and write scope | the run path refuses enablement — start, resume, submit, the ingress and the sweep all refuse before opening a ledger | same: a value this build cannot read is refused, never downgraded | `credential-isolation-unavailable` |
| Per-attempt credential delivery (D7, same adapter) | a dispatched attempt receives ONLY its own credential, over its own dispatch channel; no report channel is a delivery channel | same as above | same as above | `credential-isolation-unavailable` |
| Execution create plus stable-id lookup (D8, `dispatch-effects.ts`) | `create(request, effect)` starts an execution idempotently per `(graphId, effectId)`, and `lookup(effect)` answers `created`, `absent` or `unknown` — `unknown` rather than a guess | no dispatcher at all: the run path, the ingress and the sweep refuse enablement; a bare create-only seam is accepted as the DEGENERATE host and its lookup answers `unknown` | — (a bare function IS the degenerate adapter, by design) | `dispatch-unavailable`; `dispatch-unreconciled` when an unsettled effect cannot be established |
| Host invocation identity (D9, `host-identity.ts`) | the invoking session and agent the host attributes to the operation being performed now; `undefined` when this invocation has none | NO constraint: nothing is recorded and nothing is checked, which is exactly the behavior every path had before this rule — the core protocol depends on no host | the operation is refused before anything is read or written | `host-identity-unavailable` (unreadable declaration, or a recorded binding judged without a capability), `host-identity-mismatch`, `host-identity-absent` |

IDENTITY IS AN ADDITION, AND THE ASYMMETRY IS THE RULE. Identity binding never
replaces a credential check: the credential resolves the attempt first, and the
identity is checked against that attempt's OWN dispatch record second. The
reference is always what the DISPATCH recorded — never the current invocation,
never the node's current attempt — which yields exactly one asymmetric rule:

- an attempt dispatched under NO host identity carries no binding and is NOT
  constrained; a later process never fabricates one for it, exactly as this
  build never invents a credential for an attempt that was issued none;
- an attempt that DID record one cannot be settled without the check. A
  mismatch (`host-identity-mismatch`), an invocation the host supplies no
  identity for (`host-identity-absent`), and a judging process that holds no
  readable capability (`host-identity-unavailable`) all REFUSE the submission
  and write nothing. Dropping the constraint to let the submission through is
  the one outcome this rule must not produce.

THE BINDING IS LAYOUT, NOT AN EXTRA, AND IT SURVIVES A RESTART. The identity is
recorded on the attempt's own node entry and the state body version becomes 7
(`OUTCOME_STATE_BODY_V7`). Version 6 and version 5 stay ADVANCEABLE — version 6
carries every field version 7 requires except the OPTIONAL identity, so
advancing it invents nothing — while versions 1 to 4 stay readable only
(`graph-state.ts`). A restart NEVER re-binds a recorded identity to the
invocation that happens to be recovering: `resume` reports the attempt it finds
and does not ask the host for the current identity at all. The write -> restart
-> read -> write round trip is enforced by the regression test below.

THE BOUNDARY IS THE HOST'S, AND THIS DOCUMENT SAYS SO. This build can compare
the identity the host DECLARES at dispatch with the identity the host DECLARES
at submission. It cannot verify either declaration, cannot force a host to
attribute a worker's invocation correctly, and cannot isolate anything at the
filesystem level: a host that answers the same identity for every call, or whose
attribution a thief can influence, defeats this constraint and is undetectable
here — exactly as a host that declares a protected store it does not provide
defeats D7. A host whose dispatched workers submit under a different
attribution than the dispatch was made under will see those submissions refused
BY NAME; that is the constraint working, and such a host must not declare the
capability (or must fix its attribution) rather than have the check disappear.
No adapter ships in this build, so a deployment that has not injected one gets
the unconstrained (pre-D9) behavior by construction.

RESTART RECONCILIATION NOW REPORTS ITS DISAGREEMENTS. D8 resolves the
commit-then-crash window by asking the host, but a resolution is not a report:
`resume` also carries `divergences`, one entry per effect whose persisted LOCAL
status and the host's FACT about the same stable id contradict each other.

| Local row | Host fact | Reported as | Recovery action |
| --- | --- | --- | --- |
| `pending` | `created` | `divergences[] = { local: pending, host: created, resolution: reconciled-started }`, and `reconciled[]` names the positive resolution | mark `started`; **never** create a second execution |
| `started` | `absent` | `divergences[] = { local: started, host: absent, resolution: reported-unreconciled }`, and `refusals[]` carries `dispatch-unreconciled` | change NOTHING; report for host/manual reconciliation |
| `pending` | `absent` | not a divergence — the ordinary commit-then-crash window | create exactly ONCE, then mark `started` |
| `pending` | `unknown` (or no query capability) | not a divergence — the host stated no fact | create nothing; report `dispatch-unreconciled` |
| `started` | `created` | not a divergence — the two records agree | `reconciled: recorded-started`, nothing launched |

A SECOND RECOVERY IS IDEMPOTENT: the reconciled row now AGREES with the host and
reports no fresh divergence, while a contradiction that no host fact has
resolved is reported again with NOTHING written either time. The startup sweep
carries the same records in `outcomeProtocol.divergences`, so the restart report
names the contradictions instead of leaving them to be inferred from the
reconciled/refused buckets.

ENFORCED BY TESTS. `tests/graph/host-identity.test.ts` covers the strict reader
and the four shapes of a missing/malformed declaration; the write -> restart ->
read -> write round trip with the recorded identity surviving and the successor
being bound to the submitting invocation; a mismatch refused with no receipt, no
event and no state change; the unverifiable cases (`absent` identity, no
capability, unreadable capability) refused instead of settled; an attempt
dispatched under NO identity left unconstrained; the ingress and the sweep
refusing an unreadable capability before opening a ledger; and both divergence
directions with an idempotent second recovery.
`tests/graph/ledger-graph-state.test.ts` pins the version-7 reader, the refusal
of the field on a version that does not define it, and the malformed-identity
refusal.

DEFERRED by this slice, and not implied by it: any host IMPLEMENTATION of the
identity capability or of the dispatch adapter (this build ships the contracts),
a signature over a submission, platform-level process isolation, and the
protocol-aware dispatch completion bridge.

### Definitions, locations, and comparison owners

| Axis | Definition owner | Durable location | Comparison owner and rule |
| --- | --- | --- | --- |
| Storage format | `src/graph/persistence/storage-format.ts`: `CURRENT_STORAGE_FORMAT = 3`; explicit decoder and migration registries | Root `storageFormatVersion`; transactional-store metadata carries the same format identity | `src/graph/persistence/load.ts` selects an exact registered decoder, then determines whether the store can be resumed as-is or requires a registered format migration. No numeric less-than compatibility rule. |
| Execution protocol | `src/graph/protocol/execution-protocol.ts`: `LEGACY_SIGNAL_PROTOCOL = 1`, `OUTCOME_PROTOCOL = 2`; handler registry keyed by exact version | Each graph's root `executionProtocolVersion`; compiled plans, attempts, and receipts belong to that graph and cannot change its protocol | Loader selects an exact handler before semantic hydration; dispatcher and reducer use that bound handler. Registry membership, not equality with a latest-version constant, decides support. |
| Contract revision | `src/graph/contracts/contract-definition.ts`: `ContractRef = { id, revision, digest }`; no global current-contract constant | Immutable contract snapshots plus node bindings in each retained compiled plan revision; attempts and receipts refer to their exact plan revision | `src/graph/contracts/resolve.ts` resolves exact references during compilation and verifies snapshots/bindings during load. Revision is an opaque immutable identifier; compare identity and content digest, never ordering or a semver range. |

All three proposed modules are dependency leaves; the loader depends on their
registries, not vice versa. The old `ENGINE_PERSISTENCE_VERSION` remains a legacy
decoder constant during transition and is retired with the old writer. It must
not become an alias for the execution protocol version.

The two execution protocols may both live in storage format 3. A new storage
format does not imply new behavior. A contract revision does not imply a new
execution protocol. Changing either protocol constant's meaning in place is
forbidden; an incompatible decision-rule change gets a new protocol handler.

Contract digests use a protocol-defined canonical representation and digest
algorithm over the complete effective contract. Unsupported values or sizes are
rejected, never truncated before hashing. The binding freezes defaults,
completion policy, acceptance requirements, and validator identities/versions.
The normalized contract representation is owned by the execution protocol; it
does not gain an implicit dependency on the current registry implementation.

`GraphDeclaration.version` remains an authoring-format tag, checked by the
declaration parser/compiler at creation or explicit import. It is not a fourth
resume decision and is never compared with these three identities. Legacy v2
documents use the legacy compiler. The new authoring grammar uses declaration
version 3 and requires an explicit supported execution protocol. Recovery uses
the persisted compiled plan, not a reparse/recompile under today's compiler.
Any retained source declaration is provenance, not an alternative authority.
Malformed executable legacy declarations are still validated by the legacy
decoder/handler because legacy snapshots do not have compiled outcome plans.

### Concrete durable representation

Storage format 3 has a stable header containing graph identity, storage format,
and execution protocol. Its logical records are:

```text
GraphRecord
  graphId
  storageFormatVersion: 3
  executionProtocolVersion: 1 | 2
  currentPlanRevision

CompiledPlan[graphId, planRevision]
  nodeBindings[nodeId].contractRef: { id, revision, digest }
  contractSnapshots[digest]: complete immutable effective contract
  policy and validator bindings
  compiled topology and adapters

Attempt[graphId, attemptId]
  planRevision
  nodeId
  attemptCredential (runtime-issued nonce, scope-bound to this attempt)

Receipt[graphId, attemptId, submissionId]
  planRevision
  normalizedProposalDigest
  committed decision
```

This is the outcome-protocol record shape; protocol 1 instead carries a validated
legacy-state body with no invented contract revisions or outcome receipts.
Retain all plan revisions referenced by live attempts, replayable receipts, or
pending effects. Foreign-key/binding checks prevent a receipt or attempt from
silently resolving through `currentPlanRevision`. A format-3 graph with protocol
2 and missing required contract snapshots is corrupt, not an implicit legacy run.

### Structured loading results

`load.ts` owns `GraphLoadResult`. Every non-valid result is non-executable; none
may reach `adoptPrior`, dispatch, or automatic clean-start provisioning.

| Result | Required diagnostic data | Meaning and permitted caller action |
| --- | --- | --- |
| `absent` | `graphId` | No authoritative graph record exists. Creation is a separate explicit action; a missing dependent snapshot is never absent. |
| `corrupt` | `graphId`, `axis`, `code`, `path` | A recognized representation violates its schema, digest, or binding invariants. Preserve it and require repair; never rerun as fresh. |
| `unsupported` | `graphId`, `axis`, `found`, `supported`, `code` | A well-formed version/capability has no installed handler or usable migration path. Requires compatible code/capabilities, not inferred defaults. |
| `migration-required` | `graphId`, `axis: storage`, `from`, `to`, `migrationId` | A recognized, validated snapshot has a registered storage conversion path, but cannot execute until that conversion is committed. |
| `valid` | `graphId`, storage/protocol identities, validated plan bindings, hydrated state and selected handler | Every gate passed. Resume using the selected protocol and pinned contracts, which need not be the latest ones. |

`axis` identifies `storage`, `execution`, `contract`, or `capability` as
appropriate. Filesystem permission errors and store unavailability are typed I/O
failures, not `absent` or `corrupt`; implementation exceptions are surfaced as
loader failures rather than relabeled as bad user data.

### Exact mismatch rules

| Situation | Result |
| --- | --- |
| Unknown, structurally valid storage version | `unsupported(storage)`; do not validate its body against today's layout. |
| Missing/invalid format discriminator or malformed known-format body | `corrupt(storage)`. |
| Valid legacy format 2 and registered `2 -> 3` importer, with legacy protocol handler installed | `migration-required(storage)`; conversion pins protocol 1 and preserves its behavior. |
| Recognized old format without a usable importer | `unsupported(storage)`. |
| Protocol differs from the default but exact handler is installed | Continue loading that protocol; mismatch alone is not an error or migration request. |
| Valid protocol identifier without an installed handler | `unsupported(execution)`; never substitute a newer handler. |
| Format 3 is missing its protocol field or protocol-bound state is internally inconsistent | `corrupt(execution)`. Only the explicit format-2 decoder may infer protocol 1. |
| Registry latest contract revision differs from a pinned snapshot, or the registry no longer contains the old entry | Continue using the valid persisted snapshot; no migration and no latest-registry dependency. |
| Stored contract snapshot fails its digest, is missing, or disagrees with a node/attempt binding | `corrupt(contract)`. |
| A persisted compiled plan is a DRAFT, or its executability marker is malformed | `corrupt(contract)`; a draft is refused by name (`plan-not-executable`) and never loaded as executable. |
| A persisted plan carries an acceptance requirement without an exact validator version | `corrupt(contract)` naming `unpinned-validator-version`; never loaded as executable. |
| Intact contract requires an unavailable validator version or unsupported schema capability | `unsupported(capability)`; never weaken acceptance to load. |
| An exact registry identity is republished with different content | Reject new compilation with `CONTRACT_IDENTITY_CONFLICT`; existing valid snapshots remain authoritative on recovery. |

An authorized request to change execution protocol or contract revision is a
separate conversion/replanning operation, not a load mismatch. Protocol conversion
requires a declared semantic converter, a quiescent graph, and an atomic commit;
unavailable converters or non-quiescent state return explicit operation errors.
Contract changes create a new compiled plan revision, leaving existing attempts
bound to the old one. A loader never selects either upgrade on the user's behalf.

### Gate ordering and migration lifecycle

Loading is read-only and follows this deterministic order:

1. Locate the authoritative record; distinguish absence from I/O failure.
2. Read the minimal format discriminator and select its exact decoder. Unknown
   formats stop here as unsupported; malformed discriminators are corrupt.
3. Validate the recognized storage representation and decode a detached candidate.
   The format-2 adapter assigns protocol 1 only after validating a legacy record.
4. Select the exact execution handler, validate protocol-specific structure,
   verify all pinned contract/plan bindings, and resolve required capabilities.
5. If all checks pass but a registered storage conversion must be committed,
   return migration-required. Otherwise return valid and hydrate current runtime
   objects under the selected handler. Do not recompile or dispatch during load.

Return the first failing gate in this order, with its owning axis. For example,
an importable old store with a missing legacy execution handler returns
unsupported(execution), not migration-required promising an unusable conversion.
Within a gate, report paths in stable order and preserve additional diagnostics.

The migration runner takes an exclusive graph/store lock, rechecks the source
generation, and preserves the original snapshot. It stages and verifies the
target, then atomically switches the authoritative record/catalog reference.
For legacy files imported into the transactional store, retain the file as backup
and commit target rows plus an import marker/source digest in one transaction;
repeated imports reconcile through that marker. A crash before commit leaves
the source authoritative; after commit the target is authoritative. Reload through
the same gates before returning executable state. Until this succeeds, no worker
is launched or replayed. Missing contract data is never fabricated during import.

Stage B starts by implementing these registries, result types, and fixture-based
load/migration tests before adding runtime branches. Required fixtures cover every
row above, storage 3 with each supported protocol, registry changes after graph
creation, retained old plan bindings, and interrupted/repeated format imports.

## Implementation order and release gates

1. Specify protocol invariants, contract authority, version handling, and crash
   semantics. Add targeted diagnostics concurrently; observed frequency is not a
   prerequisite for fixing confirmed control-flow errors.
2. Implement compiler, contract registry, loader/version dispatch, and durable
   metadata. Shadow compilation is read-only and makes no runtime guarantee.
3. Deliver one complete execution path: scoped submission, validation, reducer,
   atomic acceptance, receipt replay, effects, and restart recovery. Do not enable
   new routing until this path has durable correctness.
4. Move outcome routing and loops onto the new path, add progress evaluators,
   and connect dispatch and natural-completion policies. Existing graphs stay
   on their pinned protocol during the transition.
5. Drain or explicitly migrate legacy executions, then remove payload-based
   decisions from the new engine and retire legacy execution support.

Required tests cover ambiguous business fields, provenance spoofing, undeclared
outcomes, weakened acceptance policy, duplicate/conflicting submissions, stale
executions, mutable evidence, timeout/approval races, unknown progress, round-trip
contract preservation, and crashes before/after acceptance and effect launch.
Legacy tests remain on the legacy path; tests specifying replaced behavior are
versioned or rewritten rather than constraining the new protocol to old defects.

## Existing implementation references

- [Node declarations](../src/types.graph-v2.ts): role-independent configuration.
- [Condition resolver](../src/graph/engine/condition-resolver.ts):
  `signal_observed` tests a defined ledger value, not payload content.
- [Natural-completion settlement](../src/graph/outcome/natural-completion.ts):
  the closed completion-fact envelope and the `natural-completion:` provenance
  namespace the run path persists.
- [Loop execution](../src/graph/engine/loop-group-executor.ts): current inferred
  marker and unresolved-content decisions.
- [Persistence](../src/graph/engine/engine-persistence.ts): version gate before
  hydration; graph declarations and loop runtime state are already persisted.
- [Recovery](../src/graph/engine/engine-recovery.ts): current dispatch-ID fencing.
- [Termination](../src/graph/engine/engine-termination.ts): graph notification
  dedupe, distinct from node submission acceptance.
- [Signal tool](../src/signal/signal-tool.ts): shared function/session/observe use.
