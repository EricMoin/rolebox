# Graph outcome protocol (engine v3)

The Graph engine runs *declared* multi-agent workflows: a host session declares a
graph as data, the compiler turns it into an immutable plan, and the engine
dispatches one worker per node and settles each node only when a declared outcome
has passed its acceptance gates. This document is the reference for that
protocol: the identities it compares, the declaration grammar it compiles, the
tools it ships, and the invariants its storage, controls and recovery rules
enforce. Operator-facing configuration is documented in the
[operations guide](graph-v3-operations.md); a shorter orientation page is
[Graph engine architecture](graph-engine-architecture.md).

## Purpose and execution model

The engine advances one graph through a fixed pipeline:

| Stage | What it produces | What it means |
| --- | --- | --- |
| Declaration | A version-3 document supplied to `graph_declare` | The author's statement of nodes, outcomes, routes and budgets |
| Compiled plan | An immutable, content-addressed topology | The only authority the run path reads: which nodes exist, which outcomes they may produce, which gates each outcome must pass |
| Run | One execution of that plan | A run identity ordered by sequence within the graph; the greatest sequence is current |
| Attempt | One worker's execution of one node inside one run | The unit a credential is bound to and the unit a control command names |
| Proposal | A worker's claimed outcome plus optional data and evidence references | Untrusted input, judged against the plan |
| Acceptance | A decision, one accepted result per attempt at most | What the plan's gates answered, committed with the graph state |
| Effects | Durable dispatch and notification intents | External work that must happen after the commit, never before it |

**The single atomic commit boundary.** Acceptance is one transaction. The receipt
(the idempotency record of one submission), the accepted event, the accepted
result, the state transition, successor dispatch intents and the effect rows all
commit together or not at all. External execution happens *after* commit:
dispatch is a durable intent first, and the platform is asked to start a worker
only once the intent exists. A failed acceptance writes no accepted result and
cannot route a successor. If the accepting transaction cannot also reserve the
successors' budget, the whole acceptance rolls back.

**What the host supplies and what the kernel owns.** A host (the pi platform or
the dsh platform) installs ports, not policy: dispatch delivery, session
identity and the declaring invocation, execution observation, cancellation,
lifecycle hooks, the validator and completion-policy capabilities, the artifact
root and the credential store. The kernel owns everything else: the compiler and
its capability preflight, the pure state reducer with its join and loop-progress
rules, the control application service, the ledger and store, and the shared read
model. `GraphApplication` is the assembly point that binds one trusted capability
set to the canonical tools; neither host installs a second scheduler, a second
store or a second read model.

**Exactly one completion source.** A graph declared under this protocol has one
completion source: the graph-scoped outcome submission, which commits the state
with the acceptance. The registered protocol capability states this positively —
the accepted-outcome submission is the completion source, the ingress is the
graph-scoped outcome submission, and the legacy signal completion path is
unreachable. There is no incremental node or edge construction tool and no
signal-driven execution path: a graph's topology is fixed when its plan is
compiled, and a worker's payload never routes it. Severity-ranked signals, free
form payload fields and synthesized second answers settle nothing.

## Definitions, locations, and comparison owners

This protocol carries several version-like numbers, and confusing them is the
most common source of wrong conclusions. They are different kinds of identity,
they live in different artifacts, and only some of them are ever compared.

| Identity | Current value | Where it lives | What it is compared with | What it is never compared with |
| --- | --- | --- | --- | --- |
| Authoring-format tag | `version: 3` | The declaration document | The compiler's grammar check: a document tagged anything else is not a v3 declaration | Any stored format, protocol or revision number |
| Compiled plan revision | A content digest (no number) | The compiled plan and every record that pins it | The revision the attempt was bound to, and the digest the acceptance re-derives | Any version number |
| Execution-protocol identity | `2` | The persisted graph definition, alongside the plan | The installed handler registry: a handler must declare the outcome protocol's completion source and ingress | The authoring tag, the storage format, the state-body version |
| Storage format number | `9` | The format-version row of the store's metadata | The format this build writes: greater is refused as newer, smaller as older with no registered migration | The execution protocol, the state-body version |
| Outcome-state body version | `9` | Every persisted run-state body | The state-body layouts this build reads; a body version with no reader is refused | The storage format (the two advance independently) |
| Validator identity | e.g. `schema@1`, `artifact-reference@1`, `command-exit@1`, `principal-approval@1` | Pinned by the plan's acceptance requirements | The installed validator registry, at the same exact `(id, version)` | Any ordering: a version is an identity, never a minimum |
| Contract identity | `(id, revision)`, with the contract body carried under its own content digest | Pinned by a node's contract reference; the plan carries the body snapshot and the identity index beside it | The installed contract registry, by identity and by digest | Any other graph's contracts |
| Completion-policy identity | `(id, revision)` with a body digest | Requested by the declaration, pinned by the plan, installed from a host-authorized catalog | The installed completion-policy registry: the pinned body must hash to the pinned digest | Whether the policy is present in the repository — a catalog entry is not an authorization |
| Approval-policy identity | `(policyId, revision, digest, mode)` | Recorded on each durable approval request | The policy the host has installed when the decision is recorded | Any worker payload, including one claiming approval |

Two rules follow from the table.

First, **only same-kind identities are compared**. A submission is judged against
the plan revision its attempt is bound to, never against "the latest" plan. An
attempt's control decisions, receipts and accepted results keep addressing the
revision they were accepted under, even after the graph has moved on. Conversely
the authoring tag is never compared with the execution protocol or the storage
format: a version-3 declaration, protocol 2 and storage format 9 describe three
different things.

Second, **capability is membership, not a number**. Support for an execution
protocol is decided by whether an installed handler declares that protocol's
semantics; support for a storage format is decided by the format this build
writes; support for a validator requirement is decided by a registered
implementation at that exact identity. A bare number that appears somewhere is
never sufficient to make something runnable.

The **authority** for each identity is also distinct: the declaration is the only
source of the authoring tag; the compiled plan is the only topology authority and
the only source of plan revisions; the ledger metadata is the only storage-format
authority; the state body itself declares its own layout; and every host-side
capability (validators, contracts, completion policies, approval policy, command
mappings, artifact root, credential store) is installed by the host, never by a
declaration or a tool argument. A declaration can *request* a capability
identity; only the host can *grant* one.

## The declaration

`graph_declare` accepts one declaration document. The grammar is closed: an
unknown key, a wrong type or a malformed limit is refused with a stable code and
the failing path, and nothing is persisted.

### Root fields

| Field | Required | Type and meaning |
| --- | --- | --- |
| `version` | Yes | The literal `3`. The authoring-format tag. |
| `name` | Yes | Non-empty graph name. The grammar carries no separate graph id, so the name **is** the graph id; an explicitly supplied `graph_id` must equal it or the declaration is refused. |
| `budget` | No | `{ max_executions }`, a non-negative safe integer. Absent means the run declares no execution ceiling. Any other key is refused. |
| `nodes` | Yes | The node declarations. Each id must be unique. |
| `edges` | Yes | The directed control edges. Each edge binds exactly one outcome of its source node. |
| `loop_groups` | No | The bounded-cycle groups. Each id must be unique. |
| `completion_policy` | No | `{ id, revision }`: the completion-policy revision the graph requests for its natural-completion mappings. A request, never a grant. |

### Node fields

| Field | Required | Type and meaning |
| --- | --- | --- |
| `id` | Yes | Unique node identifier within the graph. |
| `agent` | Yes | The agent to dispatch. The host resolves it from its role catalog at dispatch time. |
| `prompt` | Yes | The prompt text the worker executes. |
| `outcomes` | Yes | At least one outcome declaration; outcome ids are unique within the node. |
| `completion` | No | `{ mode: "explicit" }` or `{ mode: "natural", outcome }`. Absent leaves the policy open. |
| `contractRef` | No | The exact contract identity this node is bound to. A ref that does not resolve, or whose digest disagrees, is a compile error. |
| `join` | No | Fan-in strategy: `{ strategy: "all" }`, `{ strategy: "any" }` or `{ strategy: "quorum", quorum: N }` with a positive integer `N`. |
| `budget` | No | Per-node ceilings: `timeout_ms`, `max_input_tokens`, `max_output_tokens`, `max_cost_usd`. `max_retries` is refused by name. |
| `inputs` | No | The accepted results this node consumes, each `{ from, outcome }`. Resolved against declared nodes and outcomes at compile time. |

### Outcome fields

| Field | Required | Type and meaning |
| --- | --- | --- |
| `id` | Yes | Unique within its node. Edges bind outcomes by this id. |
| `data` | No | The payload contract: `{ schema, version? }`. |
| `acceptance` | No | An **ordered** gate sequence of `{ validator, version? }` requirements. Order is meaning; the plan preserves it. |

### Edge fields

| Field | Required | Type and meaning |
| --- | --- | --- |
| `from` | Yes | Source node id. |
| `to` | Yes | Target node id. |
| `outcome` | Yes | The outcome of `from` this edge routes on. The declaration front-end requires it and refuses an edge that omits it at that edge's own `outcome` path. The compiler's structural shape guard deliberately omits the field — which is why the compiler carries a dedicated missing-edge-outcome code — but that code is reachable only for a declaration handed to the compiler already built, never through the front-end a declaring caller uses. |

### Loop-group fields

| Field | Required | Type and meaning |
| --- | --- | --- |
| `id` | Yes | Unique loop-group identifier. |
| `nodes` | Yes | The member node ids. A member that is not declared is an error. |
| `max_traversals` | Yes, semantically | A hard positive cap on cycle traversals. A group that leaves it open is a structural defect. |
| `continuation_outcome` | Yes, semantically | The outcome that re-enters the loop. It must be declared by a member, and every edge carrying it must stay inside the group. |
| `exit_outcome` | Yes, semantically | The outcome that leaves the loop. It must be declared by a member. |
| `progress` | No | `{ evaluator, version, subject, max_unchanged }`: the comparison semantics, the version of that semantics, the outcome-data field compared across rounds, and how many consecutive unchanged comparisons stop the run. |

### Compile-time rules

The compiler refuses a declaration outright rather than compiling something
weaker than what was written. The rules that decide this:

- **Uniqueness.** Two nodes with one id, two outcomes with one id on a node, or
  two loop groups with one id are errors. An outcome id has exactly one
  declaration, otherwise an edge binding it would be ambiguous.
- **Reference resolution.** Every edge endpoint must name a declared node; every
  edge outcome must be declared by its source node; every input must name a
  declared node and an outcome that node declares; a loop member, continuation
  outcome and exit outcome must all resolve against the declared nodes.
- **Edges bind a declared outcome of their source.** There is no implicit
  "any signal" edge, no severity-ranked fallback and no predicate field. An edge
  whose source does not declare the outcome cannot be compiled into a decision.
- **Inputs are fixed and upstream.** A node that consumes an accepted result must
  be reachable from the producing node along declared edges. A self-referential
  input, a repeated reference, or a producer that no edge path reaches, is an
  error: a consumer never reads "the latest result of some type" at run time.
- **Loops declare their routes and their cap.** A group that leaves its traversal
  cap, continuation outcome or exit outcome open, or whose continuation edge
  leaves the group, is refused as a structural defect, not deferred to run time.
- **Cycles must be contained.** A cycle that no declared loop group covers cannot
  be compiled; loop traversal is the engine's only bounded repetition.
- **A graph must be able to terminate.** An outcome with no outbound edge is a
  declared exit. A graph in which every declared outcome is bound by an edge
  declares no exit at all and is refused; the plan states the terminal set
  explicitly, and the inspector checks that the stated set agrees with the
  topology.
- **Acceptance must be pinnable.** Every requirement must resolve to an installed
  validator at an exact version. An unversioned capability can cover an
  unversioned requirement but cannot make it executable: an executable plan pins
  every requirement, and an unpinned gate is never widened to "any version".
- **Concrete capability, not just identity.** An installed validator identity is
  not an installed capability. The schema a data contract names must be
  registered, and a command-exit requirement must have a trusted mapping
  authorized for its exact graph, node and outcome — otherwise the plan is a
  draft rather than a plan whose gates could never pass.
- **Declared order versus set semantics.** Nodes, edges and loop groups are
  canonicalized by id; outcome ids and loop members are sets, and their
  declaration order carries no meaning. Two things keep their declared order
  because order *is* their meaning: a node's `inputs`, and an outcome's
  `acceptance` gate sequence.
- **Agents are resolved by the host.** The compiler does not validate the agent
  name against a role catalog; the name is carried into the compiled plan and
  resolved by the host when the node is dispatched.
- **Re-declaration.** Declaring an existing graph id again with a plan revision
  that differs from the persisted one is refused: the persisted plan is
  authoritative for the declaration it was compiled from and is never overwritten
  silently. Re-declaring the *same* graph with an *identical* declaration
  preserves the stored plan and reports that nothing was rebuilt.
- **Drafts are not persisted.** A declaration that can only compile as a
  non-executable draft is refused by name, with every unresolved acceptance
  requirement and every unauthorized natural-completion mapping listed
  separately, because the two have different owners.

### A complete declaration

The following declaration exercises inputs, a join, a loop group with a progress
policy, explicit and natural completion, acceptance gates and per-node budgets.

```json
{
  "version": 3,
  "name": "release-review",
  "budget": { "max_executions": 12 },
  "completion_policy": { "id": "rolebox.graph.completion", "revision": "2" },
  "nodes": [
    {
      "id": "draft",
      "agent": "team--writer",
      "prompt": "Draft the release note.",
      "outcomes": [
        {
          "id": "ready",
          "data": { "schema": "release-note", "version": 1 },
          "acceptance": [{ "validator": "schema", "version": 1 }]
        }
      ],
      "budget": { "timeout_ms": 600000, "max_cost_usd": 2 }
    },
    {
      "id": "audit",
      "agent": "team--auditor",
      "prompt": "Audit the drafted note.",
      "inputs": [{ "from": "draft", "outcome": "ready" }],
      "outcomes": [{ "id": "passed" }, { "id": "flagged" }]
    },
    {
      "id": "summarize",
      "agent": "team--writer",
      "prompt": "Summarize the audit findings.",
      "join": { "strategy": "all" },
      "inputs": [{ "from": "audit", "outcome": "passed" }],
      "completion": { "mode": "natural", "outcome": "done" },
      "outcomes": [
        {
          "id": "done",
          "acceptance": [{ "validator": "artifact-reference", "version": 1 }]
        }
      ]
    }
  ],
  "edges": [
    { "from": "draft", "to": "audit", "outcome": "ready" },
    { "from": "audit", "to": "summarize", "outcome": "passed" },
    { "from": "audit", "to": "draft", "outcome": "flagged" }
  ],
  "loop_groups": [
    {
      "id": "revision",
      "nodes": ["draft", "audit"],
      "max_traversals": 3,
      "continuation_outcome": "flagged",
      "exit_outcome": "passed",
      "progress": {
        "evaluator": "revision-token",
        "version": 1,
        "subject": "revisionToken",
        "max_unchanged": 2
      }
    }
  ]
}
```

`draft` and `audit` form the bounded revision cycle: a `flagged` audit sends the
work back for a new draft, a `passed` audit exits the loop to `summarize`, and
three traversals is the hard cap. The loop compares the `revisionToken` field of
each round's accepted data, and two consecutive unchanged comparisons stop the
run. `summarize` completes naturally into `done`, which requires the host to have
authorized that exact mapping in the requested completion-policy revision.

## Tools

| Tool | Purpose | Availability |
| --- | --- | --- |
| `graph_declare` | Parse, compile and persist a declaration, then start or resume it | Every host |
| `graph_submit_outcome` | Submit a worker's claimed outcome for one node | Every host; a worker's only granted graph tool |
| `graph_control` | Apply a trusted lifecycle command to a run or an attempt | Every host |
| `graph_status` | Read the shared read model | Every host |
| `graph_audit` | Read-only drain and migration inventory | Every host |
| `graph_worker_exec` | Run one shell command in the worker's sandbox | Hosts that install it (the dsh platform) |

### `graph_declare`

| Argument | Required | Meaning |
| --- | --- | --- |
| `declaration` | Yes | The v3 declaration, as JSON text or an already-parsed value. |
| `graph_id` | No | Must equal the declaration's `name` when supplied; a mismatch is refused. |
| `supported_validators` | No | A **narrowing** of the host-installed validator set, each entry `{ validator, version? }`. |

The tool parses, compiles and persists the compiled plan with its contract
binding and the outcome-protocol identity. Its result reports the graph id, the
content-addressed plan revision, the executability, the authoring version, the
execution protocol, topology counts, contract bindings, and two fields that are
easy to confuse:

- `persisted` — whether the immutable definition reached the on-disk store.
- `start` — what the host's start decision was. `saved` means the declaration is
  persisted and the host performed no start step; `started` and `resumed` carry
  the phase, the armed attempts and any refusals or divergences; `blocked` means
  a start step could not be completed and carries the reason; `refused` carries
  the structured refusals.

A saved declaration is not evidence that a worker started. `supported_validators`
can only narrow: an entry the host did not install refuses the declaration with
`validator-capability-not-installed`, and omitting the argument means every
installed capability is in scope, never "no capabilities". A declaration that
compiles only as a draft is refused with the unresolved entries named and nothing
persisted.

### `graph_submit_outcome`

| Argument | Required | Meaning |
| --- | --- | --- |
| `graph_id` | Yes | The declared graph to submit to. |
| `node_id` | Yes | The plan node whose outcome is claimed. |
| `outcome_id` | Yes | The outcome that node declares in the compiled plan. |
| `credential` | No, but required in practice | The attempt credential the dispatch request carried. |
| `data` | No | The outcome payload, any JSON value. Digested into the submission id. |
| `evidence_refs` | No | Artifact references the acceptance gates validate, each resolving inside the workspace artifact root. |

The runtime resolves the node's contract from the **saved** compiled plan,
derives the execution identity from its own state and the proposal digest, runs
every acceptance requirement the plan pins, and commits the decision with the
graph state. The attempt credential names the one attempt the submission may
settle: a missing, unknown, tampered or other node's credential is refused rather
than re-bound to the node's current attempt. Attempt id, submission id and plan
revision are **runtime provenance**: they are derived by the runtime from its own
records, never accepted as arguments, so a worker cannot choose a plan revision,
impersonate another session or address another attempt.

A refusal returns structured repair diagnostics and writes nothing; the attempt
stays exactly as it was, so the caller can repair the input and submit again. A
rejection returns the per-requirement outcomes that failed and leaves the attempt
open. A record that is not this build's declared outcome-protocol state is
refused by name.

A dsh worker that cannot settle through this tool does not have to lose its claim:
its prompt asks it to end its final turn with the outcome it reached, and the host
reads that declaration — from the turn it already holds — into the credential-free
host-derived completion channel. A declaration is not a submission: it settles
nothing by itself, the plan still decides whether the outcome exists and passes
its gates, and the attempt stays open when it does not.

### `graph_control`

| Argument | Required | Meaning |
| --- | --- | --- |
| `graph_id` | Yes | The declared graph whose run is controlled. |
| `command` | Yes | One member of the closed vocabulary. |
| `node_id` | No | Required for the commands that name one attempt (`failure`, `timeout`, `retry` in its attempt-scoped form, `approval-request`, `approve`, `reject`); refused for the run-wide `cancel` and `budget-stop`, and omitted by a run-scoped `retry` that orders re-execution. |
| `attempt_id` | No | The in-flight attempt; defaults to the node's current attempt, and a value that is not current is refused rather than re-attached. |
| `reason` | Yes | Stored verbatim on the durable decision and reported by later refusals. |
| `approver_session_id` | No | Required for `approval-request`; ignored by every other command. |
| `expires_at` | No | Required for `approval-request`: a positive epoch-millisecond deadline in the future. |

The vocabulary is closed: `failure`, `timeout`, `cancel`, `budget-stop`,
`retry`, `approval-request`, `approve`, `reject`. The principal is the session
the platform attributed to the call, never an argument. Only the declaring
session may control the graph; a dispatched worker is refused before the command
body runs. Commands are durable and idempotent in the sense that matters: a
repeated command replays its recorded fact, and a competing command is refused
rather than applied. A control command is never an outcome — it writes no
accepted result, starts no successor, and a worker's payload can never issue one.

### `graph_status`

`graph_status` reads the shared read model and never writes it.

| Group | Arguments |
| --- | --- |
| Target | `graph_id`, `node_id`, `loop_id`, `run_id` |
| Scope | `scope`: `session`, `persisted` or `all` |
| Format | `format`: `summary`, `tree` or `json`; `group_by`: `hour`, `day` or `agent` |
| Filters | `query` (case-insensitive match on node id, prompt or agent), `status` (`pending`, `dispatched`, `settled`), `agent`, `from_date`, `to_date` |
| Inclusion | `include_output`, `include_progress`, `include_budget`, `include_loops`, `include_artifacts`, `include_evidence`, `include_history` |
| Window | `limit`, `depth`, `offset`, `max_chars`, `tail` |
| Export | `export_path` |

`include_output` attaches accepted results with their data, artifacts and
evidence; without it or `include_history`, an attempt carries only its result
identity and timestamp. `run_id` selects one archived run; without it the current
run is read. `export_path` writes the selected rendering atomically to that path.
An unreadable store is an error, never an empty successful inventory.

### `graph_audit`

`graph_audit` takes no arguments. Its report carries one entry per stored
definition, sorted by graph id, each with the graph's execution-protocol version,
whether it is terminal or in flight and the work it still owes; then the blockers
— every record it cannot read or whose version it does not know — and the totals
and verdict derived from them.

| Verdict | Condition |
| --- | --- |
| `drained` | No blocker, no in-flight graph, and no unsettled effect |
| `in-flight` | Something is still moving or still owed |
| `blocked` | At least one record could not be classified; this verdict wins over `in-flight` |

It is strictly read-only: it opens the ledger read-only, never creates or
initializes a store, and writes no graph, state, ledger or file.

## Acceptance and results

Acceptance is a sequence of gates that ends in one decision.

1. **Request shape.** The clock must be epoch milliseconds, and an effect batch
   must be well formed: non-empty ids and kinds, and no repeated effect id.
2. **Plan gates.** The plan must carry a readable executability marker, be
   executable rather than a draft, be the same graph as the execution provenance,
   and match the plan revision the attempt is bound to.
3. **Proposal shape.** The proposal must be a closed record, and it must be
   content-addressable: a value that cannot be digested (a function, a cycle, a
   non-finite number) is refused rather than silently dropped or nulled.
4. **Plan membership.** The claimed node must be declared by the plan, and the
   claimed outcome must be declared by that node. The plan's own pinning rule is
   re-applied here: a requirement without an exact version makes the plan
   non-executable for this submission.
5. **Gate resolution.** Every acceptance requirement is resolved to an installed
   implementation *before any of them runs*, so a partially checked submission
   can never look evaluated. A requirement with no implementation is a refusal,
   never a skipped gate.
6. **Gate execution.** Each resolved implementation judges the proposal against
   the plan's own pinned content — for a schema gate, the data contract the plan
   declares, never anything the submission carried. Each answers `pass`, `fail`
   or `indeterminate`; an implementation that throws is `indeterminate`. An
   indeterminate result never satisfies a required gate, and the submission is
   accepted only when every required gate passed.
7. **Evidence agreement.** The artifact revisions the passing gates actually
   read are collected at validation time. Two gates that digested different bytes
   for one reference describe two revisions, so the acceptance is refused rather
   than committed with a self-contradicting artifact list.
8. **Size bound.** Accepted data beyond the store's ceiling is a structured
   refusal that writes nothing: an accepted value is never truncated into a
   smaller, dishonest one.

**Validation runs outside the commit.** A gate's own work is external — reading
artifact bytes, running an authorized command, reading a durable approval — and
none of it belongs inside the commit that records the decision. The commit
therefore rechecks the durable state the validation was bound to: the proposal
digest, the plan revision and the execution identity. A validation that no
longer re-binds to the live inputs is refused as stale with nothing written, so
evidence gathered for one execution can never settle a newer one.

The installed validator vocabulary is closed and versioned:

| Validator | What it checks |
| --- | --- |
| `schema@1` | The submission payload against the data contract the compiled plan declares. A required schema gate whose outcome declares no contract fails: an undeclared contract is not a passing one. |
| `artifact-reference@1` | Reads every evidence reference inside the artifact root and digests the bytes actually read. A required artifact gate with no references fails: absence of evidence is not evidence. |
| `command-exit@1` | Runs the trusted command the host authorized for this exact graph, node and outcome, in the policy's working directory, against a re-read artifact revision. A worker cannot turn a command string into trusted authorization, and a killed or timed-out check never satisfies the gate. |
| `principal-approval@1` | Requires the attempt's durable approval row to have been approved by the authorized approver. A rejection fails, an expired request fails, a pending request is indeterminate, and an attempt with no request fails — a submission cannot raise or decide one. |

**Accepted, replayed, rejected.** A commit answers with one verdict: `committed`
means this decision is the persisted one and its effects may run; `replayed`
means an identical submission found the committed receipt and returns it without
a second event or successor; `conflict` means another submission already settled
that logical submission differently; `settled` means the attempt is already
settled; `controlled` means a trusted run-wide command stopped the run;
`attempt-stopped` means a trusted stopping command ended that attempt while the
run keeps executing; `superseded` means a retry replaced the attempt. At most one
accepted result can exist per attempt — the accepted-event key is
`(graph, attempt)`, so settlement is single-shot.

**Payload fidelity.** Absence is preserved. `absent` (the submission carried no
`data` at all) and `value` (it carried `null`, `{}`, `""`, `0` or anything else)
are distinct stored forms, and an empty object is not the same as no payload.

**Artifacts by content identity.** Artifact bytes are retained under their
content identity, and the accepted result records the revisions the gates read —
not the paths they came from. A later change to the producer's original file
cannot change what was accepted.

**Downstream materialization.** A consumer's inputs are materialized from the
accepted revision of the producing outcome when its own attempt is dispatched.
The consumer receives a manifest and real files inside its workspace, and it
reads the revision the acceptance named. A consumer that cannot receive a
declared input records an input refusal rather than silently proceeding with
nothing.

## Runs, controls and limits

A graph owns a sequence of runs; a run owns attempts; an attempt is the unit a
credential, a reservation and a control decision name. Runs and attempts have
separate identities, and history is retained: historical runs, every reserved
attempt, execution bindings, control decisions, approval requests, accepted
results and unsettled effects stay queryable.

| Command | Scope | Durable decision it records |
| --- | --- | --- |
| `failure` | One attempt | The host reports that the attempt's execution ended without reaching an authorized outcome. The decision is recorded on the ATTEMPT and never claims the run's control fact, so the run keeps executing: sibling attempts still settle and the successors they arm are still dispatched. A platform-confirmed failure marks that attempt's dispatch effect failed, releases its outstanding budget reservation and creates no accepted business result. The release withdraws the attempt's claim on the node's remaining budget; the dispatch itself stays counted, its unreported consumption stays unknown rather than zero, and a later bill still reconciles it. The stopped attempt accepts nothing afterwards (a late submission is refused `attempt-stopped`), is never paused by an approval request and is never launched again; its node stays in flight with its dependents unreleased until a node-scoped `retry` mints a successor attempt — bounded by the plan's declared budget, which the successor spends — or a run-wide `cancel`/`budget-stop` ends the run. |
| `timeout` | One attempt | The attempt exceeded its time. Scoped to the attempt alone, exactly like `failure`: it never claims the run's control fact, so the run keeps executing and sibling attempts settle normally, while this attempt accepts nothing afterwards and its node waits for a node-scoped `retry` or a run-wide stop. |
| `cancel` | Whole run | A stop plus a cancel intent for every attempt still in flight. Confirmation requires the platform to substantiate termination; an issued request remains visible as unsettled work. |
| `budget-stop` | Whole run | Claims the run's control fact so no submission settles and no further dispatch is armed, records one decision per in-flight attempt, and reports the run's budget state including any actual overrun. It is not a platform cancellation. |
| `retry` | One attempt, or one terminal run | Naming a node mints a successor attempt that carries the node forward, and is refused when the run was stopped or ended on a declared stop. Naming no node orders the named terminal run re-executed as a new run, and is refused unless the previous run is terminal and its external effects are accounted for: a run still executing, or one that still owes external work whose fate is unknown, cannot be retried. |
| `approval-request` | One attempt | A durable pause naming the only session that may decide it and the deadline it expires at. |
| `approve` / `reject` | One attempt | The decision itself; only the named approver may issue it, a repeat replays, a competing decision is refused, and a decision after the deadline is refused as expired. |

**The first run-wide command recorded for a run is the run's control fact, and an
attempt-scoped command never claims it.** `cancel` and `budget-stop` claim it to
stop the run; a run-scoped `retry` claims it to close the run it re-executes as a
successor. A run that holds one takes no further step: it dispatches nothing,
arms nothing and settles nothing. A late worker submission and a late completion
fact both meet the same refusal, and the stop reports every still-unsettled effect
and every unconfirmed execution, so a stopped graph never hides external work.

**A node-scoped stop claims nothing but its attempt.** `failure` and `timeout`
are ATTEMPT-scoped: they record their decision on the attempt they name and leave
the run's control fact — if the run holds one — exactly as it stood, so the run
keeps executing and is reported as executing, not stopped. The stopped attempt is
the whole effect: it accepts nothing afterwards (a late submission is refused
`attempt-stopped`), it is never launched again, and an approval request naming it
is refused `attempt-stopped` rather than pausing an execution no decision can
move. Its node stays in flight with its dependents unreleased until a node-scoped
`retry` mints a successor attempt — spending one execution from the plan's
declared budget — or a run-wide `cancel`/`budget-stop` closes the run. A run such
a stop left in flight is therefore *reported*, not settled: the stopped attempt
stays visible with its decision, with its dispatch effect failed and its
reservation released when the host reported the failure, and with both left
exactly as they stood when a principal issued the command.

**A node-scoped stop contains an attempt; it is not a kill switch.** `failure`
and `timeout` say nothing about the platform's execution, and nothing on their
path ends it. What they do is record their decision on the attempt they name,
and that decision is the whole containment: the engine accepts nothing the
stopped attempt produces, never pauses it and never (re-)launches it, so the
execution cannot re-enter the run through any of those doors. What they do not
do is terminate it. Two further effects belong to the host-reported failure
alone: the attempt's dispatch effect is marked failed and its outstanding
budget reservation is released only when the host reports the failure —
`hostFailure`, corroborated against the attempt's durable execution binding and
the host's own observation that the execution ended `failed` — while a
principal-issued `failure` or `timeout` does neither, so the effect keeps the
status it had and the attempt's reservation keeps standing. No platform cancel
is delivered for either: the host's cancel path forwards the run's stopping
decisions whose command is `cancel` or `budget-stop` and nothing else, so a
node-scoped stop hands nothing to the platform, and an execution whose attempt
was stopped this way may still be running. Such an execution stays visible as
an unsettled effect, and the run keeps reporting every unconfirmed execution.

**The intended use follows from that asymmetry.** `failure` presupposes that an
execution has ALREADY ended: the host reports a platform execution that
finished without reaching an authorized outcome, and a principal records the
same decision on an attempt whose worker is gone. An operator who must stop a
LIVE execution uses a run-wide command instead: `cancel` records a cancel
intent for every attempt still in flight and asks the platform to terminate
each one, while `budget-stop` stops the run's own ledger so nothing settles and
no further dispatch is armed. A run-wide `cancel` does not revisit a node-scoped
decision: an attempt that already carries one is reported as a skipped target
(`control-already-decided`), and the cancel it delivers names the run's other
in-flight attempts. Stopping one attempt while its execution runs on is
therefore containment, not termination — the engine holds that attempt shut
while the worker keeps running — and this asymmetry is a property of the
current contract, stated here so that it is not discovered by surprise.

**Budget accounting.** `budget.max_executions` is a run-wide, transactional
ceiling counted over the run's dispatch reservations. One reservation is written
per authorized dispatch, so entry nodes, successors armed by an acceptance, loop
iterations and retry attempts each spend one execution. Re-delivery of the same
attempt does not spend it twice, and settling, cancelling or reconciling an
attempt does not refund it. Declaring no ceiling means no execution limit; `0`
prevents the first dispatch. When the ceiling leaves no headroom, the claim is
refused as `budget-exhausted`, and no attempt, state change, effect or credential
record is written for it. An attempt already in flight is not killed: its own
claim stands and it runs to its settlement. If an acceptance would need to arm a
successor whose reservation cannot be made, the entire acceptance transaction
rolls back.

**Node ceilings and reporting.** Per-node ceilings are `timeout_ms`,
`max_input_tokens`, `max_output_tokens` and `max_cost_usd`, applied per attempt
through the same reservation mechanism. A declared ceiling this build cannot
enforce — an unauthorized key, or `max_retries` — is refused by name rather than
ignored or defaulted away. The budget report carries `runLimits`, per-node facts
(`limits`, `executions`, `used`, `reserved`, `unknownUsageAttempts`, `overruns`),
`totals`, `reservedTotals`, `unknownUsageAttempts`, and the flattened `overruns`
list whose entries carry the ceiling, the recorded usage and the actual excess. A
node's declared `timeout_ms` is a plan ceiling, separate from the platform's own
transport and command timeouts: they are different mechanisms with different
owners, and neither substitutes for the other.

**Unreported usage is unknown, not zero.** Dispatch reservations are reconciled
against host-reported usage. An attempt that ended with no usage report has its
claim withdrawn and its consumption stays unknown; it is counted in
`unknownUsageAttempts` and never recorded as a measured zero. The shipped
completion ports do not provide a complete token and cost billing feed, so
execution-count enforcement deliberately does not depend on one. A delayed
platform bill that exceeds a ceiling is reported as the real overrun.

**No automatic retry policy exists.** Nothing retries an attempt on its own; a
retry is a trusted command, and `max_retries` is refused until automatic retries
have defined semantics.

**Progress is counted only from the declared comparison object.** Join
strategies, declared loop routes, hard traversal limits and versioned progress
evaluators are kernel responsibilities. Only the outcome-data field the plan
names as the comparison subject contributes to progress; an unknown or
incomparable observation counts as neither improvement nor stagnation, so it
never reaches the stagnation threshold itself and never lets a streak that spans
it reach the threshold later.

## Natural completion and approval

### Natural completion

Natural completion lets the host's own execution report settle a node, without a
worker submission. It requires **both** halves:

1. the node declares `{ "mode": "natural", "outcome": "<id>" }`, and the named
   outcome is one the node declares; and
2. the declaration requests a completion-policy revision, and the host has
   installed that exact revision with a rule that allows this exact graph, node
   and outcome mapping.

A natural policy may produce only the outcome it names. It is not a licence to
emit any declared outcome, and the named outcome's acceptance requirements still
apply: the policy changes where completion comes from, never which gates the
outcome must pass. A natural completion runs through the same acceptance
requirements and the same transaction as an explicit submission, so a failed or
merely inactive worker cannot produce success.

The delivery envelope is closed: it carries the node id, the attempt id and the
attempt credential, and any other key is refused by name. That is the
no-data-channel rule — a completion fact that could carry an outcome, a payload
or an evidence list would be a second submission channel. A mapping with no
pinned authorization is refused, never re-interpreted as an explicit submission.

`ROLEBOX_GRAPH_COMPLETION_POLICIES` is the host policy that installs
content-pinned completion-policy revisions; a catalog entry alone authorizes
nothing, and a policy body must hash to the identity it is authorized under.
`ROLEBOX_GRAPH_APPROVAL_POLICY` decides which sessions may approve each graph and
node. Its configuration format belongs to the
[operations guide](graph-v3-operations.md).

### Approval

Approval is control, not an outcome. A request is raised by the declaring
principal, which names the only session that may decide it and the deadline it
expires at; a request with no approver or no future deadline is refused before
anything is written. The default mode is independent review, which forbids
self-approval even when the declarer appears in the allowed list; only an
explicit operator-confirmation rule permits confirming one's own request, and
that mode does not claim independent review. A request stores its policy id,
revision, content digest and mode, and a decision must come from the recorded
session while the host still installs the same policy content — a policy
republished with different content under the same id and revision cannot decide
the request it once authorized. An expired request is never approved afterwards.
Session identity is not evidence of a human action: the protocol records which
principal a session was attributed to, and makes no claim that a human operated
it.

### Host-derived completion

A worker execution can end without ever presenting an outcome — a timeout, a
killed process, a provider that returned no final submission. The outcome is not
invented to fill that gap: the worker's own **final turn** declared it, and the
host reads that declaration from the turn it already holds and delivers it to the
runtime. The delivery envelope is closed and carries exactly
`{ nodeId, attemptId, executionId, outcomeId, data?, evidenceRefs?, derivation? }`
— the optional keys are the declaration's payload, its evidence references and
the host's indication of which turn declared it. Any other key is refused by name
(`malformed-host-derived-completion`), and `credential` above all: this channel
presents no bearer value and refuses one offered beside the declaration. It is
authenticated instead by the attempt's **durable execution record** — the host's
own record of the execution it created, compared against the `executionId` the
delivery names and never re-bound to whichever execution happens to exist — which
is what lets a lost credential be irrelevant here rather than re-issued. An
authority that does not exist is refused `host-completion-unavailable`, and a
record that is missing, foreign, or cannot be answered is refused
`host-completion-unauthenticated`; both write nothing. The channel is reachable
only from the host — no graph tool binds it, so a worker cannot reach it at all —
and the fact the runtime reads (`HostDerivedCompletionFact`) has no credential
field to carry one.

**An announcement is still not an outcome.** What the host delivers is the
worker's own claim, read from the turn it holds, and the plan decides whether it
becomes a result. Nothing on this channel chooses an outcome: `outcomeId` is the
outcome the worker's own last turn declared, carried through verbatim with no
default, no repair and no synthesis, so the host never decides it. The plan still
decides what happens next: an undeclared outcome is refused by the acceptance
core, and the outcome's declared acceptance gates still run, so a payload that
fails them is a rejection and the attempt stays open. A node whose compiled plan
pinned a natural completion (`completion.mode === "natural"`) is refused by name
(`derived-completion-natural-node`), because the plan already decided that node's
outcome and this channel must not choose another; a node with no completion
policy, or an `explicit` one, leaves the outcome to the attempt, which is exactly
what the declaration carries. The settlement then runs through the same atomic
transaction as every other submission, and the accepted receipt's submission id
answers which channel settled it: the ordinary ingress derives
`submission:<digest>`, natural completion derives `natural-completion:<digest>`,
and this channel derives `host-derived:<digest>`.

**The host's own entry.** An execution the host confirmed is over is settled
through one entry, `settleFinishedAttempt`: it asks the plan's pinned completion
channel first — a natural-completion node has exactly one authorized outcome and
the worker's last turn must not pick another — and only then reads the worker's
own last turn through the port the host installed (`HostDerivedOutcomePort`) and
settles a declared outcome through the runtime's `settleHostDerivedCompletion`.
An attempt that already has an accepted event answers `already-settled` with that
settlement's own submission key and writes nothing; an attempt the host cannot
settle — a graph it cannot open, no confirmed execution, no reading port, or a
reading that is absent, ambiguous, malformed or unavailable — is reported as
unsettled with its reason, and nothing is fabricated to make it settle.

**What the runtime does not prove.** The runtime cannot independently verify that
the host's port read the worker's own final turn: the guarantee is the port's
implementation, the plan-declaration gate and the durable-execution match — the
same trust level the existing host-completion channel already has. The runtime
checks the closed envelope, the host's durable execution record and the plan; it
does not re-read the session transcript, and it never settles on a claim about a
turn it did not see.

**Two closed envelopes, two jobs.** Natural completion's envelope carries the node
id, the attempt id and the attempt credential and refuses any other key — the
no-data-channel rule above — because the plan already named the outcome and no
payload may cross that boundary. The host-derived envelope is the other way
round: it carries no credential and does carry the worker's declared outcome,
payload and evidence, because the plan left the outcome to the attempt. Neither
envelope can do the other's job.

## State, storage, and effects

Each workspace has **one** graph store, and one authoritative file inside its
root: `graph-acceptance-ledger.sqlite`. It owns the durable business state:
definitions and their compiled-plan snapshots, runs, run-state bodies, receipts,
accepted events, accepted results, effect rows, execution bindings, credential
records, invocation origins, control decisions, re-execution orders, approval
requests and budget reservations. The root is selected from the host data
directory and a workspace hash, so a workspace's graphs, dispatch records,
recovery and audit all address the same file.

**Current format.** The storage format number is **9**, and the outcome-state
body version is **9**. `graph-store.identity` sits beside the database and binds
it to a random store id; it contains storage identity only, never graph state,
attempts, receipts, credentials or policy.

**First initialization and refusal.** Initialization claims the identity marker
exclusively and synchronously before the database is created, then creates the
schema and the format-version row in one transaction. Only a directory with
neither file, and no retired authority record, may be initialized. Two processes
racing to initialize the same root are resolved by that exclusive claim: the
loser must not re-bind or overwrite the marker, and a caller that arrives while an
initialization is still incomplete is refused until the complete store can be
opened. An interrupted initialization leaves its marker in place, and a record a
failed initialization left behind is never deleted or re-bound automatically.
Everything else is refused:

| Situation | Behaviour |
| --- | --- |
| Identity present, database missing | Storage error; recovery stops and the database is not recreated |
| Initialization interrupted after identity creation | Explicitly blocked; the interruption is never treated as a fresh workspace |
| Database zero bytes, damaged or structurally reshaped | Refused before any connection exists: opening it would turn "the authoritative file is damaged" into "the store was initialized" |
| Database present, identity missing or malformed | Re-binding is refused |
| Identity does not match the database | Reading and execution are refused |
| Format newer than this build writes | Refused as newer |
| Format older than this build writes | Refused as older: this build registers **no migration** |
| Retired authority records present, authoritative file absent | Refused and the records are named; they are neither read nor converted |

**Retired authority.** Older per-graph engine-state containers and earlier
authority files are left in place and reported. This build has no decoder for
them, does not overwrite them, and does not treat them as an empty store — the
execution bindings they carry are what keep recovery from creating a second
execution for one effect.

**Durable effects.** An effect has one of four statuses: `pending` and `started`
are unsettled, `done` and `failed` are terminal. An unsettled effect means the
engine has not confirmed what happened to that external task; it stays visible in
status, audit and control answers, and recovery lists it rather than assuming it
completed. A settled effect is never rewound.

**Execution fencing and recovery.** Execution creation is fenced by durable
ownership generations, so one effect cannot be launched twice. A timed-out create
or an unavailable platform query is `unknown`, never proof that no execution
exists: only a proven absence allows a credential to be reissued, and reissuing
under an unknown create outcome is refused because a blind retry could run the
attempt twice. Terminal observations are persisted, so recovery recognizes a
known end without the original in-memory callback; a missing observation is
**never** rounded into success, and such an execution stays visible and unsettled.

**Credentials are stored as digests.** The durable state keeps a credential only
as a digest: the record can verify what a submitter presents, while the bearer
value itself stays with the host's own credential store, so a read of the
accepted state cannot be replayed as another attempt's credential.

**How each host learns that an execution ended.** The pi platform binds a worker
to its native session identity and reads that child's terminal stream. The dsh
platform correlates a child by the dispatch label recorded with it and reads the
child's own one-shot terminal turn events, including through the host's read-only
session-persistence API, because a run's live result promise belongs to the
process that started it. In both hosts a new turn, an idle session or a missing
event is **not** proof of completion: only a terminal fact that can be attributed
to that child's own execution counts, and a host that cannot re-subscribe after a
restart reports the execution as explicitly unsettled instead of guessing.

The limit is the host process itself. A destroyed in-process dsh worker cannot
survive the destruction of its host process, and an interrupted pi child whose
terminal stream is unavailable may remain unknown in the same way. Such
executions stay visible and are never blindly recreated: resolving their external
effects needs a live owning host, durable terminal evidence, or a confirmed
cancellation.

**No automatic conversion.** There is no automatic migration, no legacy decoder
and no fallback to a per-graph state file. A destroyed database together with its
identity records loses local history: a newly created empty store contains no
graphs to recover and does not re-run historical work on its own, so the operator
restores a consistent backup (or confirms the host's execution facts) first. These
mechanisms prevent accidental re-creation and state re-binding; they are not an
operating-system boundary between a worker and the account that runs it, which is
the worker execution boundary's job.

## Worker execution boundary

A dispatched worker is not a second operator. Which graph tools it may call is an
allow-list decided per call: the granted name is `graph_submit_outcome`, and
every other graph tool refuses a session the host bound as a dispatched worker —
declaring or mutating a graph definition, reading the authoritative store and
controlling another attempt belong to the declaring principal.

What a worker actually gets depends on the host:

| Host | Worker-facing tools |
| --- | --- |
| pi | `graph_submit_outcome`, delivered through a loopback channel to its owning host process |
| dsh | `graph_submit_outcome` and `graph_worker_exec`, presented natively to the child |

A dsh graph worker receives its target role's prompt, functions and model. The
declaring session's active role is not applied to that child. Worker prompts omit
dispatch catalogs and direct resource reads through `graph_worker_exec`. The host
copies the target role's reference bundles and skills, including their supporting
files, into the attempt's input directory before starting it. The listed paths
point to these copies, which are readable but not writable inside the sandbox.
Missing resources or links escaping a resource bundle refuse the start; the host
does not grant access to the original role directory.

A dsh graph worker's prompt asks it to end its **final message** with exactly one
fenced `json` block, so an execution that ends without a submission can still
carry the outcome it reached:

```json
{
  "outcome_id": "<an outcome this node declares>",
  "data": "<optional payload>",
  "evidence_refs": ["<optional artifact path>"]
}
```

`outcome_id` is required and must name an outcome the node declares; `data` and
`evidence_refs` are optional, and when present they are the payload and the
artifact references the outcome's acceptance gates judge. The block is read only
from the worker's own final turn, and only when that turn completed: a failed or
aborted final turn belongs to the execution observation rather than being a
declaration source. No block, more than one block, an unknown key, or a missing or
empty `outcome_id` all mean the host derives nothing and the attempt stays open.
A declaration is not a submission — it settles nothing by itself — and it is the
input to the host-derived completion channel described under Natural completion
and approval.

The loopback channel's own envelope admits more names than a worker's grant, and
that is transport plumbing rather than a worker capability: which graph tool a
bound worker may call is decided by the per-call worker boundary against the
grant alone.

Each pi child also keeps its own read-only rendezvous file, naming the endpoint
of the host that serves it, so a surviving child finds a replacement host after
the original host process is gone; it is the pi loopback channel that keeps the
file, and it carries no credential.

The OS sandbox adapter supports **macOS Seatbelt**, applied through the platform's
sandbox wrapper to the worker and to every subprocess it starts. Where no adapter
is installed — any platform without the sandbox executable — graph worker
execution **fails closed**: it throws rather than running unsandboxed.

Inside the sandbox, an invocation of `graph_worker_exec` runs each command in its
own sandbox with a minimal environment (a path, a locale, disposable home/config/
cache directories, browser installation paths and the selected developer
toolchain), a bounded timeout and a bounded output size.
Writes stay confined to the workspace and that command scratch directory. The
worker may read the active developer toolchain selected by `xcode-select`,
including Xcode's adjacent frameworks, and the toolchain's cache is redirected
into the scratch directory so system tools can resolve their executables without
writing to the user's cache.

The command boundary itself is stated once, for engineers and for prompt
injection, in `src/platform/sandbox/boundary.md`. A worker session holds exactly
two tools — `graph_submit_outcome` and `graph_worker_exec`; the
Write/Edit/Bash/Read-style native tools are not presented, and every file read,
edit, check and command goes through `graph_worker_exec`. Writes are confined to
the session workspace, `/dev`, the per-command scratch directory and `/tmp`, whose
two spellings `/tmp` and `/private/tmp` are one vnode. Each command
gets its own `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `TMPDIR` — disposable
directories removed with the command, carrying no credentials and no host caches —
so work that needs real credentials or host state, such as a `git push`, `gh`,
`npm publish` or an authenticated API call, cannot succeed; network egress is
reachable but unauthenticated by construction. A command runs under a 60-second
default timeout that the caller may raise to at most 300 seconds, so a long build
is split across commands rather than run as one. The shell is `/bin/sh`, not bash:
process substitution `<(...)` is a syntax error, while brace expansion and arrays
work; `perl`, `sed`, `awk`, `grep`, `patch`, `diff`, `ed` and `git` are available,
and `git`, `bun` and `node` run inside the workspace with disposable caches. The
boundary is macOS-only: it requires an installed OS sandbox and refuses to start
elsewhere.

The read filter is built from `require-not` clauses over the allow-listed roots
rather than being a filesystem-wide read allow-list, so a path already outside
those roots is not forced through the deny rule. The allow-list exists to force
read access on those roots and to keep the private paths denied. A literal `/tmp`
path is an ordinary command input and works like any other command input: `/tmp`
and `/private/tmp` are the same vnode, and a write there is a write to a shared,
world-writable directory rather than to the per-command scratch root. A path that
answers `Operation not permitted` — a `/var/tmp` write, an attempt to read another
user's home, or the protected workspace private paths — is reporting a boundary
denial rather than a failed task.

Installed work software is readable from `/Applications` and `~/Applications`,
including app frameworks and helper executables. Playwright's
`~/Library/Caches/ms-playwright` and Puppeteer's `~/.cache/puppeteer` browser
installations are also readable. Host-configured `PLAYWRIGHT_BROWSERS_PATH`,
`PUPPETEER_CACHE_DIR` and `PUPPETEER_EXECUTABLE_PATH` are preserved, with relative
paths resolved against the session workspace; Playwright's `0` value continues
to select package-local browsers. These grants cover installation resources,
not write access to installations or access to the user's browser profiles.
Browser profiles, caches and Chromium's macOS socket directory use the command
scratch directory, which is removed when the command finishes. Persistent
automation output should be written to the workspace.

macOS does not support initializing Chromium's own sandbox inside the worker's
Seatbelt sandbox. Use Playwright's default `chromiumSandbox: false`, or pass
`args: ["--no-sandbox"]` to Puppeteer's `launch`. Chromium and its children remain
inside the worker's OS sandbox, including the protected file boundaries below.

A worker cannot read or modify the host state root, another worker's retained
handoff, or sibling session records in protected directories. Its own declared
input materialization is readable; the artifacts it was given are the revisions
the acceptance named, not mutable paths. Permissions are enforced on subprocesses
and verified against symlink and hardlink access rather than inferred from
directory modes.

Host session persistence therefore has to stay outside the writable workspace or
inside the workspace's protected `.dsh` and `.rolebox` directories; a host that
exposes a separate transcript directory as ordinary workspace files is outside
this supported isolation configuration.

Worker execution is scoped to the **invoking session's workspace**. Each dsh
session's graph application, store, artifact root and worker command directory are
selected from that session's absolute working directory, resolved canonically;
applications are shared only within the same workspace, and the host process's
launch directory is not a fallback. A tool call whose workspace is not absolute
is refused rather than defaulted.

## Notifications

A run that completes, stops, or needs attention notifies the declaring session.
The notification intent is durable: it is written into the effect ledger as part
of the same transaction as the graph mutation that produced it, so an event that
committed has a notification row and an event that did not commit has none.
Delivery happens after the commit, and notification work never drives graph
execution.

- **At least once.** Delivery runs with a renewable lease so competing hosts do
  not duplicate work, with bounded exponential backoff and a persisted
  acknowledgement. If the host accepts a message and the process exits before the
  acknowledgement is recorded, recovery may deliver it again.
- **Stable identity.** Each message carries a notification identifier derived
  from the graph, the run and the event key, so the same event is recognisable
  across attempts. Delivery is deduplicated per run and event, and a new run gets
  its own notification; an attention reminder whose condition has since been
  resolved is discarded rather than retried.
- **What a message contains.** The graph and run identities, the notification
  id, its kind (`complete`, `stopped` or `attention`), the node and attempt when
  they apply, an approval status when the attention is an approval, and a reason.
  It contains no credential and no business payload: it directs the parent to
  `graph_status` for the committed result.
- **A continuing run is not silent.** An attempt-scoped stop and a completed
  worker execution with no settled outcome each produce an `attention` notice
  naming the node, the attempt and the reason, so a run that continues with a
  stopped or stranded node is never silent. The first names the trusted command
  that stopped the attempt while the run continues and the node's dependents stay
  unreleased until a retry or a run-wide stop; the second names the host's own
  durable observation that the execution ended and reported completion while no
  outcome was settled, so the attempt stays open. Their event keys are
  `stopped:<attemptId>:<command>` and `unsettled-completion:<attemptId>`; both
  are reminders, and neither settles, releases or advances anything.
- **Delivery failure changes nothing.** A graph's own outcome is decided by
  acceptance, not by whether a message arrived. An unavailable target leaves
  delivery pending, and a failed notification never turns success into failure or
  prevents a terminal run from being retried. The pi platform delivers only into
  the matching active session, so switching sessions cannot redirect another
  graph's notification: it stays pending rather than arriving somewhere else.

## Query and verification

The read model is one shared view assembled from the store: the graph's declared
definition and compiled plan, its runs with phase and control facts, its nodes
with attempt state and accepted outcome, its loops with traversal counts and
progress, its approvals and control decisions, its unsettled effects, and its
budget report. `graph_status` reads it back; `run_id` selects one archived run
instead of the current one, and `scope: "all"` with `format: "json"` and
`include_history: true` returns the full retained history.

The command-line surface, the terminal interface and the web console present that
same read model. They map it to presentation only: no interface projection
participates in recovery, scheduling or acceptance, and an unreadable store is an
error rather than an empty inventory.

Two repeatable real-host checks ship with the engine: a pi smoke check and a dsh
smoke check. Each is one script command that runs its platform's real adapter
against the engine, driving actual SDK agent loops, registered tools, native child
sessions and deterministic local model responses. Between them they cover explicit
and authorized natural completion, concurrency, the control vocabulary end to end
(an unauthorized session's command refused, then cancel, a reported failure, a
run-scoped retry that completes as a new run, and an approval request decided only
by the session it named), agreement between `graph_status` and `graph_audit` and
the store's own view, extension reload with both explicit and natural workers,
downstream input delivery, the worker tool boundary and sandbox probes, and a
fresh process reopening completed or stopped runs without minting new attempts.
They do **not** call an external model provider, they do not exercise every
deployment profile, and they are not a substitute for the module-scoped test
slices that cover the engine's own rules.

`ROLEBOX_SMOKE_KEEP=1` retains the pi check's fixture instead of removing it when
the check finishes, for local diagnosis.

The pi checks need the optional pi agent package to create native child session
identities, and an installed pi command-line tool; the dsh checks need the host
service packages resolved from their agent-loop installation. The dsh graph
worker requires the host's execution guard and scoped tool presentation, and
refuses to run without them.

Development verification runs the module-scoped test slices, both type checks,
dependency scanning and the affected builds. The builds clear their generated
output before emitting the current modules, so a module that no longer exists
cannot survive a rebuild. The repository's full test suite remains CI's
responsibility.
