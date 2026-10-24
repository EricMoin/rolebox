# Role teams

A team connects complementary top-level roles in separate, persistent sessions. For example, an Android lead can invite a designer to produce a layout specification, implement that specification, and ask the designer to review the result. Each member keeps its own role prompt, model, skills, and tools.

Team execution is currently supported on DSH. OpenCode, Pi, and Codex execution support is deferred; role discovery and private-child boundaries apply across hosts.

DSH registers team tools only when its resumable agent registry and agent loop, durable session persistence and flush, execution guard, and role system-prompt contributions are available. A saved session record alone does not count as an executable member. Recovery starts after tool and prompt registration completes, so a resumed peer receives the full collaboration interface on its first turn.

## Discovery and boundaries

All successfully resolved top-level roles are discoverable through the system prompt and, on DSH, `team_list_roles`. The legacy `open`, `exports`, and `open_roles` configuration fields remain parseable but no longer control discovery or expose children.

A team accepts only exact top-level role IDs. Another role's private children are absent from the team catalog and cannot join. Role-aware asset discovery and graph target validation also preserve this boundary. A role can still use its own private children through the existing graph workflow.

Role assets are scoped to the caller's owning role tree, including root workflow skills whose bodies may name private children. DSH's global native skill catalog excludes roles with children because that provider API has no caller identity. Their root and child skills remain available through `load_role_skill`; graph workers receive only their own skill bundles and explicit paths to their private copies. Top-level role IDs and descriptions remain available through team discovery.

Host calls to `graph_status` and `graph_audit` expose only graphs owned by the calling session, including after that same session is restored. Filtering applies before graph decoding, rendering, and export, so another member's private nodes and unreadable-record diagnostics stay out of the results. Unattributed administrative queries retain the store-wide view.

DSH's `session_*` tools list, search, read, inspect, diff, and fork only the calling session. Creator, peer, and graph-child relationships do not grant transcript access. A role reads its internal graph results through its own `graph_status`; administrative session APIs retain their unrestricted view.

The creator's host session owns membership and lifecycle changes. Each peer is bound to a dedicated host session and a role ID; event senders are derived from that binding. Knowing a team or member ID does not authorize publishing. Managed peers contribute within their existing team and cannot create another team to reset the execution budget.

Graph workers cannot invoke team tools, including through a declared tool grant, a tool alias, or the discovery/code tool interface. A team member can use its role's authorized graph workflow for internal work, but graph workers do not acquire the peer's team identity.

## Tools

| Tool | Purpose |
| --- | --- |
| `team_list_roles` | Read top-level role IDs and descriptions. |
| `team_create(name, goal, max_turns?)` | Create a team with the current role/session as creator. |
| `team_add(team_id, role_id)` | Creator records a peer as a member. Adding does not start a turn: the peer starts when the first event addressed to it wakes it, and that delivery already carries the goal, roster and tasks. A role with no usable provider/model is refused (set `model` in its `role.yaml` or configure a host default model). |
| `team_send_event(team_id, kind, content, task_id?, recipient?)` | Publish a message, offer/claim/complete/release a task. |
| `team_status(team_id?, after_seq?, include_deleted?)` | Read your teams or one team's roster, tasks, errors, and ordered events. Closed teams are hidden from the list unless `include_deleted` is set; reading one by `team_id` always works. |
| `team_remove(team_id, member_id)` | Creator cancels a peer, broadcasts departure, and releases its claims. The remaining team stays paused until resumed. |
| `team_delete(team_id)` | Creator cancels managed work and closes the team; history remains inspectable. |
| `team_resume(team_id)` | Creator resumes a paused team after inspecting the error and existing work. The tool reports any member errors it cleared, so an unresolved failure stays visible. This does not replenish the turn budget. |

`recipient` may identify a member or its role. It chooses which peer wakes; it is not a private channel. All team events are readable by every member.

Example protocol, with IDs replaced by actual tool results:

```text
Android lead:
  team_create(name="Screen refresh", goal="Improve the screen's design and implementation")
  team_add(team_id="<team-id>", role_id="best-designer")
  team_send_event(team_id="<team-id>", kind="task_offer",
                  task_id="design", content="Specify layout, typography, spacing and interaction states")

Designer:
  team_send_event(team_id="<team-id>", kind="task_claim", task_id="design",
                  content="I will prepare the visual specification")
  ...read the current screen and write the specification...
  team_send_event(team_id="<team-id>", kind="task_complete", task_id="design",
                  content="Specification is available in the agreed project artifact")

Android lead:
  ...offer and claim an implementation task; implement and verify...
  team_send_event(team_id="<team-id>", kind="message", recipient="best-designer",
                  content="Implementation is ready for visual review")
```

A successful `task_claim` is required before acting on shared work. Claims are serialized by a database transaction, so concurrent claimers receive one winner. A claim lasts 30 minutes and can be renewed by its owner. Expired claims are offered again once their owner has no in-flight team delivery; removing a member also releases its unfinished claims. Only the current owner can complete or release a claim.

## Event delivery and continued work

The runtime is a durable local coordinator. It provides an ordered shared stream with a cursor per member, rather than relying on ephemeral callbacks or network-wide consensus. This fits small teams sharing one workspace.

Every membership change and completed turn enters the stream. A completed turn is identified by the host's terminal record and recorded once. Its notice contains completion status, not the member's private final transcript; members publish shared results explicitly through team events. Completion and membership notices are passive: they are included in the next delivery and remain available in `team_status`, but do not generate another turn by themselves. Messages and task offers/completions/releases are actionable and wake the relevant peers. An agent does not wake itself for its own event.

Busy members accumulate events. Once idle, a member receives one batch through a fixed sequence number. The reservation is committed before any host prompt. The cursor advances only after a confirmed successful final turn following that delivery's unique marker in the transcript. An unrelated user turn cannot acknowledge a pending delivery.

Each team allows at most eight members and two in-flight deliveries. Each host session also has a durable lease across teams, preventing two coordinators from prompting the same session concurrently. The default autonomous turn budget is 40, configurable to 1–100 when creating the team. A member turn has a 15 minute execution limit. A failed turn does not spend that budget: the team pauses with the host's actual error, the member's cursor is kept, and `team_resume` replays the pending events. User-published events and new invitations stop after 5,000 stream entries; lifecycle cleanup remains possible.

These limits bound automatic cooperation. They do not measure tokens or monetary cost, and claims coordinate work rather than provide a filesystem sandbox. Members should publish artifact references and review findings, and avoid overlapping edits until ownership is agreed.

## Persistence and recovery

```text
.rolebox/
  team/
    scheduler.sqlite             # cross-team session delivery leases
    <team-id>/team.sqlite         # versioned state, events, cursors, claims, reservations
  team-sessions/
    <session-id>.json             # DSH peer identity, role, workspace, and model options
    leases.sqlite                # exclusive ownership of live DSH peer sessions
```

Each physical workspace has its own team store. DSH resolves the caller's role and working directory from its host session, and restores stores for the current workspace and loaded sessions. Peer sessions retain their original role configuration across restarts; the role's model is re-resolved on every resume, so a repaired `role.yaml` reaches an existing member instead of being pinned to its creation-time options. An idle resident peer applies the updated model to its next turn while preserving its session and pending input. Removing or deleting a member releases its session record and lease, so the same role can join again as a fresh peer. When another host owns the peer, its record remains until that host releases it; cleanup is retried automatically, including after the owning host exits. If a live peer's role is changed manually, the next team delivery pauses instead of mixing that selection with its saved configuration. Plugin shutdown stops new calls and event delivery immediately, then waits for owned peer handles to close.

Team state is committed synchronously in SQLite transactions. A new team is built in a reserved staging directory and atomically published after commit. Every update rereads committed state under a write transaction; another process cannot overwrite it with an old in-memory snapshot. Unknown versions and corrupt records are reported rather than reset.

On restart the runtime reconstructs membership, task ownership, pending deliveries, and consumption positions. The DSH adapter reads durable session history before deciding whether to recreate a live agent for the same session. Reading history does not start a turn. A confirmed completed delivery is acknowledged without another execution. An interrupted or ambiguous delivery pauses the team and keeps its cursor, so work is not silently discarded.

After inspecting the session and existing artifacts, the creator uses `team_resume`. Where an old managed delivery might still be active, cancellation must be confirmed before it can be replayed. Removing, deleting, and resuming a team hold a persistent lifecycle lock; a concurrent operation cannot reopen work during cancellation.

Delivery is **at least once after explicit recovery**, not exactly once execution of external effects. A process can stop after an edit or tool call but before its final turn is persisted. Members must inspect task state and artifacts before repeating work. The team protocol does not treat free-form text as proof that a task completed: task completion is an explicit event from its current claimant.

## Verification

The focused test slices cover transaction rollback, two-process contention, atomic team publication, restart recovery, exclusive task claims, cross-team session leases, lifecycle races, marker-based acknowledgements, passive-notice loop prevention, role visibility, and the DSH lifecycle integration. Entry tests use host doubles to verify workspace routing, role configuration, startup ordering, worker rejection, and asynchronous shutdown. Adapter tests also exercise the installed DSH Session, AgentRegistry, and AgentLoop implementations for creation, resumed sessions, input delivery, and terminal records. These automated tests do not call a live model.

Run the separate live acceptance scenario with:

```sh
bun scripts/team-smoke/dsh.ts
```

The runner requires an installed DSH CLI, a configured default model using a supported API-key or pi-ai adapter, and installed `typescript-engineer` and `ai-designer` roles. It mounts the real DSH agent loop, model adapter, JSONL persistence, and workspace sandbox from the same host installation. It copies both role trees into a fresh local directory and changes only those copies' model routes to the configured host model. Installed role configuration is untouched.

The real models create a team, claim design and implementation tasks, produce a TypeScript status card, and review the result. After the designer's claim has committed and the session has flushed, the controller kills the host with `SIGKILL`, starts a new process, and requires the model to inspect and resume the same team. It verifies durable session identity, task ownership, event-triggered continuation, completed-delivery deduplication, role prompts, own-child graph execution, and peer isolation. The generated code must pass a fixed acceptance test whose original bytes are checked before and after execution. A final quiet interval checks for unwanted notification loops.

The runner prints the final `report.json` location. Session transcripts, role copies, and raw host diagnostics remain local in that directory and may contain private configuration or model output; do not publish them. Model requests and subprocess lifetimes are bounded. The scenario tests collaboration and recovery, rather than making a general claim about visual design quality or exactly-once external effects.

After a successful run has exited, optionally reopen its persisted sessions for an isolation audit without model calls:

```sh
bun scripts/team-smoke/audit.ts --root /path/to/completed-run
```

The audit restores both roles and invokes the registered graph and session tools. Positive controls require each member to read its own transcript and the creator to inspect its private graph; peer queries must conceal that graph and refuse foreign session reads, searches, inspection, diffs, and forks. It also checks that the shared team stream contains no private child role IDs and that probes leave team state and transcripts unchanged. Any attempted model request fails the audit. The shareable `isolation-report.json` contains only check names, counts, and pass/fail status; raw tool results stay in the local `audit-private.log`.
