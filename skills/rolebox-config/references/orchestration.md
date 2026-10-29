# Orchestration

## Choose the available execution mechanism

Private subagents belong to a role and execute assigned work using their own
prompt/model/assets. Direct dispatch is useful for one task; declared graphs
express fixed dependencies, outcomes, joins and bounded revision cycles. DSH
role teams coordinate complementary top-level roles in persistent sessions.

Use the tools actually registered by the current host. Codex's rolebox MCP
server does not own native Codex subagent sessions; a tool name or a role
declaration cannot supply that execution capability.

## Direct dispatch settings

The effective role-level YAML settings are positive numbers in milliseconds:

```yaml
dispatch:
  backgroundStaleTimeoutMs: 900000
  syncPromptTimeoutMs: 600000
```

Supported global environment overrides include:

| Variable | Meaning and default |
| --- | --- |
| `ROLEBOX_DISPATCH_BG_STALE_MS` | Background stale timeout; 900000 |
| `ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS` | Result fetch timeout; 10000 |
| `ROLEBOX_DISPATCH_RESULT_RETENTION_MS` | Result retention; 3600000 |

Environment values take precedence over role settings and defaults. Do not put
`maxInputTokensPerRequest`, `maxCostPerRequest` or similar budget fields in the
`dispatch` block: the current YAML loader retains only the two timeout fields.
Do not assume an environment variable exists just because a manager type has a
similarly named field. Use graph budgets for declared graph execution limits.

Where available, `dispatch` accepts the resolved subagent ID and prompt;
background dispatch returns a task ID, `dispatch_output` retrieves its result
and `dispatch_cancel` cancels it. Reusing `session_id` continues a prior worker
session. Wait for completion notifications before collecting results. Read the
registered schema for background flags and per-task `timeout_ms` support.

## Graph engine v3

The effective interface declares a complete version-3 document through
`graph_declare`, starts/controls it through `graph_control`, and reads
`graph_status`/`graph_audit`. Workers submit a declared outcome through their
dedicated `graph_submit_outcome` entry point. Read actual tool schemas for the
transport wrapper around the declaration and control commands.

There are no incremental `graph_create` / `graph_add_node` / `graph_add_edge`
construction tools in this protocol. Signals do not settle graph-v3 nodes.
`graph: { orchestration: graph_v2 }` in `role.yaml` is recognized legacy metadata
with no runtime effect, and is not how to configure a runnable v3 workflow.

A minimal declaration (replace the agent ID with a resolved, visible role):

```json
{
  "version": 3,
  "name": "review-flow",
  "budget": { "max_executions": 4 },
  "nodes": [
    {
      "id": "review",
      "agent": "reviewer--researcher",
      "prompt": "Review the assigned change and submit the done outcome with findings.",
      "completion": { "mode": "explicit" },
      "budget": { "timeout_ms": 600000 },
      "outcomes": [{ "id": "done" }]
    }
  ],
  "edges": []
}
```

The graph's name is its ID. Nodes declare unique IDs, an `agent`, a `prompt` and
one or more outcomes. Edges use `{ "from": "work", "to": "review",
"outcome": "done" }`: the outcome must be declared by the source node.
An outcome may declare `data: { schema, version? }` and ordered
`acceptance: [{ validator, version? }]` requirements. Requested validators must
be installed by the host at that exact identity.

Consumers can declare `inputs: [{ from: "work", outcome: "done" }]` to receive
accepted upstream results. Fan-in uses `join: { strategy: "all" }`, `any`, or
`quorum` plus a positive `quorum` number. A loop group declares `id`, member
`nodes`, positive `max_traversals`, `continuation_outcome` and `exit_outcome`.
Continuation edges stay inside that group; the exit must reach a valid terminal
path. Use explicit outcomes and bounded groups for revision cycles.

Root `budget.max_executions` caps all authorized dispatches in a run, including
loop iterations and new manual retries. Omission declares no ceiling; zero
prevents the first dispatch. Node budgets accept `max_input_tokens`,
`max_output_tokens`, `max_cost_usd` and `timeout_ms` (zero disables that node's
staleness watchdog). `max_retries` is rejected, including zero. Recorded token
usage limits future dispatch and does not cancel work already running.

### Worker tool presentation

Workers inherit the parent's authorized task tools. `tools` on a node is legacy
metadata and does not restrict, grant or register tools. Graph control, team
orchestration and recursive dispatch remain unavailable to workers.

Optional `toolPresentation` selects `native` (default), `discover`, or `code`,
with up to 32 exact tool names under `preload`. This changes schema visibility,
not authorization. DSH supports discovery and code invocation. Pi and OpenCode 2
support native discovery but reject code invocation; OpenCode 1 rejects explicit
presentation configuration. Codex MCP cannot configure Codex's native workers.
Worker instructions should use available native tools and the dedicated outcome
submission instead of inventing shell or file wrapper APIs.

### Operator-installed graph policy

These are startup environment variables, not fields that a graph or worker may
install for itself:

| Variable | Trusted configuration |
| --- | --- |
| `ROLEBOX_GRAPH_APPROVAL_POLICY` | JSON `{ id, revision, rules }`; each rule binds `graphId`, `nodeId`, allowed `approverSessions` and optional `mode` |
| `ROLEBOX_GRAPH_COMPLETION_POLICIES` | JSON `{ declare, authorize }`; declaration bodies plus exact authorized `id@revision` identities |
| `ROLEBOX_GRAPH_COMMAND_CHECKS` | JSON array binding `graph`, `node`, `outcome`, `argv`, `cwd`, `timeout_ms`, `expect_exit_code` and non-empty `artifact_refs` |

Approval mode defaults to `independent-review`, which forbids self-approval.
`operator-confirmation` explicitly permits it but supplies no independent review.
Requests pin policy identity/content, target session and an expiry. No installed
policy means no approval authority. Natural completion requests an installed
policy with root `completion_policy: { id, revision }`; an offered body without
authorization is insufficient. Command-exit acceptance needs a trusted binding
for that exact graph/node/outcome. Do not synthesize any of these authorities to
make a failing declaration pass.

Read the audit and results before claiming success. A `stopped` run cannot be
fixed with node-scoped retry; inspect existing effects before an authorized
run-wide retry creates a successor run. Do not delete graph state to bypass a
storage error or reset a budget. A store backup must include its matching
`graph-store.identity`, and restoration requires stopping every holder first.

## Role teams (DSH)

Teams use exact top-level role IDs, not another role's children. The host needs
resumable agents, durable sessions, execution guards and prompt contributions;
team tools register only when these capabilities are present. No `open_roles`
allowlist is required.

Use `team_list_roles`, `team_create`, `team_add`, `team_send_event`, `team_status`,
`team_remove`, `team_delete` and `team_resume` according to their schemas. Adding
a member does not start its turn; an addressed event wakes it. A member must
successfully claim a task before editing shared work, then publish the result
through a team event. Final replies alone remain private. Events are shared
with all members, even when only one recipient is woken.

`team_create` accepts `max_turns` (1–100, default 40); a team has at most eight
members and two in-flight deliveries. Failure pauses the team; resume preserves
the consumed turn budget. The turn cap does not measure tokens or money. Team
execution on OpenCode, Pi and Codex is not implemented by this integration.

Removing a member or deleting a team releases its team session descriptor and
lease. Peers created or resumed by rolebox are disposed. When DSH has restored a
peer itself, the host keeps that session and pending user input; rolebox clears
queued team deliveries before releasing the team identity. Cleanup waits while
another running host holds the peer lease, and failed cleanup is retried.
