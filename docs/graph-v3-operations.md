# Graph engine v3 operations

This page is the operator's guide to the shipped Graph engine v3: the run-level execution ceiling, the per-node resource budgets, the host-installed configuration that authorizes approvals, completion and command checks, the identity of the on-disk store with the recovery rules that follow from it, and the repeatable checks that verify an installation. The declaration grammar, the join and completion semantics it produces and the run phases that follow from them are documented in [Graph outcome protocol (engine v3)](graph-outcome-protocol.md); the orientation and ownership map is in [Graph engine architecture](graph-engine-architecture.md). The capabilities this page configures are installed by an operator: a graph declaration may request a capability, never install or authorize one.

## Run-level execution limit

`budget.max_executions` is declared at the root of a version-3 declaration and must be a non-negative safe integer. It is the one ceiling that belongs to the run as a whole rather than to a single node:

```json
{
  "version": 3,
  "name": "bounded-work",
  "budget": { "max_executions": 8 },
  "nodes": [
    {
      "id": "work",
      "agent": "worker",
      "prompt": "Complete the assigned work.",
      "outcomes": [{ "id": "done" }]
    }
  ],
  "edges": []
}
```

The allowance covers every node of the run, every loop iteration and every newly minted manual retry attempt: each entry dispatch, each successor an acceptance arms, and each attempt the `retry` control mints spends one execution. A re-delivery or a recovery of the *same* attempt spends nothing — that attempt already holds its claim, and the store answers the replay from the committed reservation. The dispatch effect, the attempt and the reservation commit in one SQLite transaction, so a claim that cannot be recorded is a dispatch that was never authorized.

A reserved execution is never refunded. Settlement, cancellation and reconciliation all leave it counted; a released claim keeps its row and its place in the run's execution count. The ceiling therefore measures what the run was allowed to start, not what it finished. Re-executing a terminal run starts a new run with a fresh allowance: `retry` on a completed or stopped graph mints the successor run, and only that run's ceiling is read against it.

An absent `budget` field means no execution ceiling. `max_executions: 0` blocks the first dispatch.

When the allowance cannot cover a dispatch, the store refuses the claim and the operation answers `budget-exhausted`, naming the dimension, the committed amount and the declared ceiling; no attempt, credential, state change or dispatch effect is written for it. An acceptance that must arm a successor is refused whole when that successor cannot reserve: the transaction rolls back, so a graph never commits a state whose next node cannot be started. An attempt already in flight is never affected by such a refusal — its own claim stands and it runs to its settlement, which is why a terminal outcome that arms no successor is accepted even when it consumes the last execution.

The budget report carries both numbers an operator reads a ceiling against: `runLimits.max_executions` is the declared ceiling (absent when the declaration set none) and `totals.executions` counts every authorized dispatch of the run. Usage that was never reported remains its own fact (`unknownUsageAttempts`) and is never folded into the totals as a zero.

## Per-node budgets

A node's `budget` declares resource ceilings for that node's attempts. Four keys are authorized; any other key is refused by name rather than ignored or defaulted away.

| Key | Meaning |
| --- | --- |
| `max_input_tokens` | Ceiling on the input tokens recorded for this node. |
| `max_output_tokens` | Ceiling on the output tokens recorded for this node. |
| `max_cost_usd` | Ceiling on the cost recorded for this node, in US dollars. |
| `timeout_ms` | Wall-clock ceiling for this node's attempt. `0` is the documented opt-out that disables the per-node staleness watchdog. |

Every key is optional, and an absent key means the declaration declared no ceiling for that dimension — it does not mean zero, and it is not an unlimited default this build supplied. Recorded usage is compared against the declared ceiling, and an overrun is reported as the actual `used - limit`, never clamped and never rounded away; usage exactly at the ceiling is not an overrun. What the ceiling stops is the next dispatch: a claim is authorized only while recorded usage plus outstanding reservations stays below it. No overrun cancels work that already started — stopping a run for the budget's sake is the explicit `budget-stop` control, whose answer carries the run's budget report.

`max_retries` is reserved syntax this build does not implement: automatic retry has no semantics here, so the parser, the compiler and the runtime all reject the key, including the value `0`. It cannot be used as a substitute for the run-level execution limit.

## What an operator does with a stopped run

A run that stops records why. Two of the three reasons come from a declared
limit — `loop-exhausted` (a loop group's hard traversal cap) and
`progress-stalled` (a declared progress policy's stagnation threshold) — and the
third, `unreachable-pending-node`, means the run still holds nodes nothing can
dispatch: a pending node whose every feeder has settled without routing to it,
because an upstream settled an outcome that never reached it. The stop record
names each stranded node and the feeder of each that can never arrive, and the
notification says the same thing, so `graph_status` answers "what was abandoned"
directly rather than leaving it to be inferred from a phase.

`complete` is the one phase that claims every declared node settled. A run that
reached a declared terminal outcome while other nodes stood pending is NOT
complete: it stops and names the nodes the exit never reached.

**A stopped run takes no further step, and a node-scoped `retry` is refused on
one.** Naming a node is rejected with `run-stopped`: a successor attempt minted
in place could never settle, because a stopped run accepts no submission. The
way forward is a RUN-wide `retry` — the command that names no node — which
re-executes the graph as a successor run and dispatches its entry node again,
under the ordinary re-execution rule that the previous run is terminal and its
external effects are accounted for. Recovering the abandoned work therefore
means re-executing the run, not nudging one stranded node.

## Host-granted approval authority

Pi and dsh read a JSON policy from `ROLEBOX_GRAPH_APPROVAL_POLICY` at startup. It is operator-installed trusted configuration, never a declaration field or a tool argument:

```json
{
  "id": "review-policy",
  "revision": "1",
  "rules": [
    {
      "graphId": "review-flow",
      "nodeId": "review",
      "approverSessions": ["reviewer-session"],
      "mode": "independent-review"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | The policy identity a raised request pins. |
| `revision` | The exact revision a raised request pins; an opaque identifier, never a "latest" pointer. |
| `rules[].graphId` | The declared graph name the rule applies to. |
| `rules[].nodeId` | The node of that graph the rule applies to. |
| `rules[].approverSessions` | The non-empty list of sessions allowed to decide that node's request. |
| `rules[].mode` | `independent-review` (the default when omitted) or `operator-confirmation`. |

Two rules covering the same graph and node are ambiguous, so the whole policy is refused rather than resolved by order. A missing or invalid policy installs nothing, and every approval request is then refused — there is no fallback to "the declarer picks an approver".

`graph_control` with `approval-request` may only nominate a session the installed policy allows and must also carry `expires_at`. `independent-review` is the default mode and forbids self-approval even when the requester appears in `approverSessions`; only an explicitly configured `operator-confirmation` rule permits confirming a request one raised itself, and that mode claims no independent review. A deadline that has already passed is refused rather than stored.

A raised request pins the policy identity — its id, revision, content digest and mode. `approve` and `reject` must come from the session the request recorded, and only while the host still installs the same policy content: a revision republished under the same identity with different content cannot decide a pending request, and a decision arriving after the deadline is refused as an expiry, after which the request can never be approved.

An outcome that requires host approval declares the `principal-approval@1` acceptance primitive. The capability preflight refuses a declaration whose graph and node have no installed approval rule, before anything is dispatched. The former experimental `human-approval` primitive is gone: platform session attribution proves which principal called, never that a human did, so no configuration or acceptance path claims human provenance.

## Completion policies and command checks

`ROLEBOX_GRAPH_COMPLETION_POLICIES` installs the completion policies a host may resolve a natural-completion request against:

```json
{
  "declare": [
    {
      "id": "team.completion",
      "revision": "1",
      "body": {
        "version": 1,
        "default": "deny",
        "rules": [
          {
            "graphId": "review-flow",
            "nodeId": "work",
            "outcome": "done",
            "decision": "allow"
          }
        ]
      }
    }
  ],
  "authorize": ["team.completion@1"]
}
```

`declare` offers bodies the operator authored; `authorize` names the exact `id@revision` identities the host installs, and both halves are required — a body that does not hash to the identity it was authorized under is refused, and an offered declaration nobody authorized is not installed. Inside a body, `default` is `deny` (a mapping no rule lists is explicitly forbidden) or `ungranted` (silence: not authorized, and not forbidden either), and one mapping carries at most one rule. With no configuration the registry is empty, and a request for a policy that is not installed is refused. This repository ships declarations under the id `rolebox.graph.completion`, revisions `1` (default `ungranted`) and `2` (default `deny`), neither of which is installed until an operator authorizes it.

A declaration requests a revision with its root-level `completion_policy` field, which names an `id` and a `revision` and nothing else. The request is a request: the installed body decides the mapping, and a declaration cannot carry rules, a body or a digest.

`ROLEBOX_GRAPH_COMMAND_CHECKS` installs the trusted commands a `command-exit` acceptance requirement is judged by. The value is a JSON array of bindings:

```json
[
  {
    "graph": "review-flow",
    "node": "work",
    "outcome": "done",
    "argv": ["bun", "run", "typecheck"],
    "cwd": "/path/to/project",
    "timeout_ms": 120000,
    "expect_exit_code": 0,
    "artifact_refs": ["reports/typecheck.txt"]
  }
]
```

| Field | Meaning |
| --- | --- |
| `graph` | The declared graph the command is authorized for. |
| `node` | The node of that graph. |
| `outcome` | The one outcome of that node. |
| `argv` | The non-empty argument vector to run. |
| `cwd` | The working directory the command runs in. |
| `timeout_ms` | A positive safe integer: the command's time limit. |
| `expect_exit_code` | The safe integer exit code the command must return. |
| `artifact_refs` | At least one non-empty artifact the command is bound to. |

One mapping — the exact graph, node and outcome triple — has exactly one trusted command; two configured bindings for the same mapping are ambiguous, so neither installs. A mapping with no configured binding fails closed rather than passing. With an empty configuration no command is authorized, which is the honest shipped default.

None of these environment variables is reachable from a declaration, a worker payload or a tool argument, and a declaration can never install or authorize a capability: a graph may request an exact completion-policy revision, and the optional narrowing a caller states while declaring can only select from the capabilities the host already installed — an entry the host did not install refuses the declaration instead of adding anything to it.

## Store identity and recovery

The current store format is **9**. One workspace owns one authoritative SQLite database and an adjacent identity marker named `graph-store.identity`. The database's metadata row carries a `store_id` that must equal the id in that marker; the marker holds only its own marker-format version — `1`, which is not the store format — and a random store id, never a graph, attempt, receipt, credential or policy. Every business fact stays in the database.

First initialization requires a directory in which the database, the identity marker and any retired authority record are all absent. The opener claims the identity marker first, by exclusive creation synced to disk, and only then creates and verifies the schema and the format-version row in one transaction.

| Situation | Behaviour |
| --- | --- |
| Identity marker present, database missing | Refused as a storage error; recovery stops, and the database is never recreated. |
| Initialization interrupted after the identity marker was created | Explicitly blocked; the interruption is not treated as a fresh workspace to initialize. |
| Database empty, structurally corrupt, or bound to a different store id | Refused before a record is read: a zero-byte file is a damaged store, not an absent one. |
| Database present, identity marker missing or malformed | The store is refused; the binding is never re-created over it. |
| Consistent backup restore | Stop every process holding the store, restore the database together with its matching identity marker, then start the host and let the open gate verify the format version, the tables and the binding. |
| Any store format other than 9 | Refused: older formats have no registered migration, and newer ones are not read. |

A database whose header declares WAL journal mode is refused by the read-only load path: opening it would attach to and rewrite its shared-memory side file, so the readers refuse it rather than change the store they are reading.

An already-open connection re-checks its file: a database that disappeared, a file that was replaced (a different device and inode), or a changed identity binding is refused while handles are open, so restoring files under a running host cannot silently rebind a live store. Concurrent first initialization is decided by the exclusive creation of the identity marker — only its creator may write; every other caller is refused while initialization is incomplete and may reopen once it has completed. Records a failed initialization left behind are never deleted or rebound automatically.

If the database and every external identity record are lost together, local history cannot be recovered from that machine: the now-absent directory initializes a fresh, empty store, which contains no graph to recover and nothing that re-executes the historical work on its own. Restore a backup, or reconcile the host's execution facts by hand, before declaring new work there. These mechanisms prevent accidental re-creation and silent rebinding; they are not operating-system isolation from a worker on the same account.

## Verifying an installation

Two repeatable real-host checks drive actual SDK agent loops, the host's registered tools and deterministic local model responses, and each ends by starting a fresh process over the same workspace to verify recovery:

| Check | Command |
| --- | --- |
| Pi host | `bun run scripts/graph-smoke/pi` |
| dsh host | `bun run scripts/graph-smoke/dsh` |

Bun resolves each of those entry names without its extension; the two entries are the Pi and dsh smoke scripts in that directory. They call no external model provider, and they do not certify every deployment profile.

The engine's own module slice is the repeatable in-process check:

```sh
bun test --isolate tests/graph/
```

`bun run typecheck` checks types without running any test. The full test suite is CI's job, not a local step after a documentation or configuration change.

## See also

- [Graph outcome protocol (engine v3)](graph-outcome-protocol.md) — the declaration grammar, acceptance, controls and storage semantics this guide configures.
- [Graph engine architecture](graph-engine-architecture.md) — orientation, ownership and platform limits.
