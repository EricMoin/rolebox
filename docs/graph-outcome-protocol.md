# Graph outcome protocol — target architecture

Status: design decision; implementation pending.

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

## Loop progress

Loops declare continuation and exit outcomes, next-round input mappings, and
hard round/time/cost limits. Optional progress evaluators compare contract-bound
revision data and relevant artifact/validation versions across completed rounds.

Comparison returns progressed, unchanged, or unknown. Truncation, missing data,
or incompatible versions produce unknown. Successful outcomes do not enter the
revision-staleness path. Unknown progress remains subject to hard limits.
Repeated unchanged results may trigger an explicitly configured stopping policy;
they are not a proof that the underlying task is impossible.

Persist evaluator version, comparison baseline, and counters. Recovery must
continue the same decision semantics instead of resetting progress accidentally.

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

DEFERRED by this slice, and not implied by it: the entire outcome EXECUTION
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
caller's transaction. THE ENGINE STATE DOES NOT YET JOIN IT: the callback's
transaction and its rollback are real, but only the ledger's own tables are
written through it today.

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
- [Loop execution](../src/graph/engine/loop-group-executor.ts): current inferred
  marker and unresolved-content decisions.
- [Persistence](../src/graph/engine/engine-persistence.ts): version gate before
  hydration; graph declarations and loop runtime state are already persisted.
- [Recovery](../src/graph/engine/engine-recovery.ts): current dispatch-ID fencing.
- [Termination](../src/graph/engine/engine-termination.ts): graph notification
  dedupe, distinct from node submission acceptance.
- [Signal tool](../src/signal/signal-tool.ts): shared function/session/observe use.
