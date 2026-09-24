# Graph engine v3

This document describes the current implementation. The acceptance record and remaining platform limits are in [the execution plan](graph-v3-execution-plan.md); operator configuration is in [the operations guide](graph-v3-operations.md). Earlier designs and implementation history remain in git.

## Architecture

`GraphApplication` assembles one trusted capability set, `OutcomeHost`, and the canonical tools. Pi and dsh supply dispatch, identity, observation, cancellation, and lifecycle ports. Neither host supplies a second scheduler or storage model.

| Responsibility | Owner |
| --- | --- |
| Strict declaration parsing, capability preflight, immutable plan | `graph/compiler/` |
| Public runtime requests, results and capability ports | `graph/outcome/runtime-contract.ts` |
| Pure state transitions, joins, loop progress | `graph/outcome/graph-state.ts`, `join-state.ts`, `progress.ts` |
| Current state shape and strict decoder | `graph/outcome/state-model.ts`, `state-codec.ts` |
| Acceptance and effect orchestration | `graph/outcome/runtime.ts` |
| Trusted controls and approvals | `graph/control/` |
| Host execution identity and recovery | `graph/host/outcome-host.ts` |
| Worker tool permissions and invocation attribution | `graph/host/tool-binding.ts` |
| Atomic business state | `graph/store/` |
| Shared read model | `graph/query/` |
| Registered host entry points | `entries/pi.ts`, `entries/dsh.ts` |

The flow is declaration → compiled plan → run → attempt → acceptance → effects. A worker proposes an outcome. The runtime validates it and commits the receipt, accepted result, state transition, and next effects in one SQLite transaction. External execution happens after commit. A failed acceptance writes no accepted result and cannot route a successor.

## Tools and declarations

The shipped tools are `graph_declare`, `graph_submit_outcome`, `graph_control`, `graph_status`, and `graph_audit`. dsh additionally exposes `graph_worker_exec` to confirmed graph workers.

`graph_declare` accepts a version-3 declaration. Its registered host entry waits for the initial start decision. `persisted` reports whether the immutable definition was saved; `start.kind` separately reports `started`, `resumed`, `blocked`, or `refused`. A saved declaration is not evidence that a worker started. Asynchronous platform failures remain visible through execution records and subsequent status queries.

```json
{
  "version": 3,
  "name": "review-flow",
  "budget": { "max_executions": 8 },
  "nodes": [
    {
      "id": "work",
      "agent": "team--worker",
      "prompt": "Implement the requested change.",
      "outcomes": [{ "id": "done" }]
    },
    {
      "id": "review",
      "agent": "team--reviewer",
      "prompt": "Review the accepted work.",
      "inputs": [{ "from": "work", "outcome": "done" }],
      "outcomes": [{ "id": "approved" }]
    }
  ],
  "edges": [{ "from": "work", "to": "review", "outcome": "done" }]
}
```

Agent names must exist in the host's role catalog. Every node declares its possible outcomes; every edge names the outcome that activates it. Findings, severity, reasons, and other business data do not route the graph. Changing a declaration under an existing graph name is refused; a run retry reuses its existing immutable plan.

A worker receives its attempt's handoff and submits `graph_id`, `node_id`, `outcome_id`, and `credential`, with optional business payload. The host derives attempt provenance and caller identity. Workers cannot choose a plan revision, impersonate another session, control a graph, or obtain another attempt's credential through a graph tool.

## Acceptance and results

The compiler resolves exact schema, validator, command-policy, completion-policy, and approval-policy identities. Missing required capabilities produce a refused or non-executable declaration before dispatch. Runtime acceptance verifies those identities again.

The installed validator vocabulary includes schema validation, retained artifact validation, authorized command exit checks, and `principal-approval`. A worker cannot turn a command string into trusted command authorization. An installed command policy maps a declared check identity to an operator-approved invocation.

Accepted business data preserves absence, `null`, and an empty object as distinct values. Rejected data is not published to consumers. Artifact bytes are retained by content identity; SQLite records the accepted revision. Downstream input assembly uses that revision and materializes only the consumer's declared inputs. A later change to the producer's original file cannot change an accepted input.

The accepted outcome and result belong to one attempt. Replaying an identical submission returns the committed receipt without a second event or successor. Conflicting submissions cannot both settle the attempt. Validators perform external work outside the commit transaction, and acceptance rechecks the durable state before committing.

## Runs, controls and limits

Runs and attempts have separate identities. Historical runs, every reserved attempt, execution bindings, control decisions, approvals, accepted results, and unsettled effects remain queryable.

`graph_control` accepts explicit commands: `failure`, `timeout`, `cancel`, `budget-stop`, `retry`, `approval-request`, `approve`, and `reject`. The authenticated declaring session controls the graph; approval decisions require the separately authorized approver. Worker output is never interpreted as a control command.

A node retry creates a new attempt and spends a new execution allowance. A run retry creates a new run after the previous run is terminal and its external effects are accounted for. A platform-confirmed failure atomically stops the run, marks its dispatch effect failed, and releases its outstanding budget reservation. It does not create an accepted business result. Cancellation is only confirmed when the platform substantiates termination; an issued request or timeout remains visible as unsettled work.

`budget.max_executions` is a run-wide, transactional ceiling. It counts entry nodes, successors, loop iterations, and new retry attempts. Re-delivery of the same attempt does not spend it twice; settling or cancelling an attempt does not refund it. `max_retries` is explicitly rejected until automatic retries have a defined implementation.

Token, duration, and cost accounting use host-reported usage and conservative dispatch reservations. An ended attempt without a usage report is reported as unknown usage, not a measured zero. The current shipped completion ports do not provide a complete token/cost billing feed. Execution-count enforcement does not depend on that feed. Node timeout declarations are separate from platform transport timeouts.

Join strategies, declared loop routes, hard traversal limits, and versioned progress evaluators are kernel responsibilities. Unknown or incomparable progress never counts as improvement or as stagnation. Only the declared comparison object contributes to progress.

## Natural completion and approval

Natural completion requires both a node declaration such as `completion: { "mode": "natural", "outcome": "done" }` and an exact host-authorized completion-policy mapping. The host's confirmed execution supplies the completion fact. Natural completion runs through the same acceptance requirements and transaction as an explicit submission; a failed or merely inactive worker cannot produce success.

`ROLEBOX_GRAPH_COMPLETION_POLICIES` declares trusted policy bodies and authorizes exact `id@revision` identities. `ROLEBOX_GRAPH_APPROVAL_POLICY` determines which sessions may approve each graph/node. Independent review is the default and forbids self-approval. Explicit `operator-confirmation` permits self-confirmation without claiming independent review. Session identity alone is not evidence of a human action.

## Storage and recovery

The current GraphStore format is **9** and the current outcome-state body is **9**. One workspace database, `graph-acceptance-ledger.sqlite`, owns business state, execution bindings, approval and budget records, terminal host observations, and worker-channel credential digests. The host data directory and workspace hash select its root. Monitor, tools, recovery, and audit use that same root.

`graph-store.identity` binds the database to a random store ID. It contains no graph state. A missing database with an existing identity, a missing identity with an existing database, an identity mismatch, a malformed schema, or an unsupported version blocks execution. There is no automatic conversion, reset, legacy decoder, or fallback to per-graph `engine-*.json` files. Retired authority files are left in place and reported.

Execution creation is fenced by durable ownership generations. A timed-out create or an unavailable platform query is `unknown`, not proof that no execution exists. Credentials are reissued only when absence is proven under the create fence. Persisted terminal observations allow recovery to recognize a known end without the original in-memory callback. Missing observation is never rounded into success.

Pi uses the actual native session identity for its worker binding. A graph child invokes its owning host through a loopback channel instead of opening the store or becoming another scheduler. Only a credential digest is stored. Its own read-only rendezvous file lets a surviving child find a replacement host. dsh correlates children by their persisted dispatch label and reads their own one-shot terminal turn events, including supported read-only persistence APIs. A new turn or an inactive session alone does not prove completion.

A destroyed in-process dsh worker cannot survive destruction of its host process. An interrupted Pi child whose terminal stream is unavailable may also remain unknown. Such executions stay visible and are not blindly recreated; a live owning host, durable terminal evidence, or confirmed cancellation is required to resolve their external effects.

## Worker execution boundary

The current OS sandbox adapter supports **macOS Seatbelt**. Pi runs the entire graph child under the sandbox. dsh restricts workers to outcome submission and a command tool that runs each command in a separate sandbox with a minimal environment. A host execution guard also blocks special transports such as `run_code`, and graph children use native tool presentation.

Workers cannot read or modify the host state root, another worker's retained handoff, or sibling session records in protected directories. Their own declared input materialization is readable and immutable. Workspace work files remain writable. Permissions are enforced on subprocesses and verified against symlink and hardlink access, not inferred from directory modes.

Other operating systems currently have no installed sandbox adapter and graph worker execution fails closed. dsh requires the host's execution-guard and scoped-presentation APIs. Host session persistence must remain outside the writable workspace or in its protected `.dsh` / `.rolebox` directories; exposing a separate transcript directory as ordinary workspace files is outside this supported isolation configuration.

## Query and verification

`graph_status` reads native run/attempt facts. Use `scope: "all"`, `format: "json"`, and `include_history: true` for full history, or `run_id` for a selected run. `graph_audit` includes the same `GraphView` alongside storage and recovery blockers. CLI/TUI/web map that read model to presentation only; no UI projection participates in recovery. An unreadable store is an error, never an empty successful inventory.

Repeatable real-host checks are `bun run scripts/graph-smoke/pi.ts` and `bun run scripts/graph-smoke/dsh.ts`. They use actual SDK agent loops, registered tools, native children, and deterministic local model responses. They cover explicit and authorized natural completion, controls, concurrency, authorization, query agreement, extension reload with both explicit and natural workers, and a fresh process reopening completed/stopped runs without new attempts. They do not call an external model provider or certify every deployment profile.

Pi integration requires the optional `@earendil-works/pi-coding-agent >=0.86.0` peer to create native child session identities. Pi verification also needs an installed Pi CLI; dsh verification needs the complete host service packages resolved from its agent-loop installation. `ROLEBOX_SMOKE_KEEP=1` retains a Pi fixture for local diagnosis.

Development verification runs module-scoped tests, both type checks, dependency scanning, and the affected builds. Builds clear generated output before emitting current modules. The repository's full test suite remains a CI responsibility.
