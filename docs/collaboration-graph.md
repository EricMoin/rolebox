# Collaboration Graph

> Part of the rolebox documentation. See [README](../README.md) for overview.

By default, the parent role decides who to dispatch to and when. The collaboration graph adds structure: you define a workflow (who passes work to whom), and rolebox handles the routing automatically.

Think of it like a flowchart for your agents.

## Quick start

Add a `collaboration:` block to your role.yaml. The simplest way is to pick a built-in topology:

```yaml
name: Review Team Lead
description: Coordinates code review workflow
prompt: |
  You are a team lead coordinating a code review workflow.
  Follow the collaboration graph to dispatch work.
subagents:
  - name: Coder
    description: Implements code changes
    prompt: You are a senior developer. Write clean, testable code.
  - name: Reviewer
    description: Reviews code for quality
    prompt: You review code for correctness, style, and edge cases.
collaboration:
  topology: review-loop
  agents: [coder, reviewer]
  max_iterations: 3
```

That's it. The parent dispatches to Coder first, Coder's output goes to Reviewer, and Reviewer can either loop back to Coder for revisions or finish the workflow. After 3 loops max, the workflow ends automatically.

## Built-in topologies

Three ready-made patterns:

| Topology | Flow | Use case |
|---|---|---|
| `pipeline` | parent → A → B → C → parent | Sequential handoff. Each agent builds on the previous one's output. |
| `review-loop` | parent → A → B → A (loop) → parent | Revision cycles. The last agent can send work back for another pass. |
| `star` | parent → A, parent → B, parent → C (parallel) | Fan-out. Each agent works independently and reports back. |

```
# pipeline: A → B → C, done.
collaboration:
  topology: pipeline
  agents: [researcher, writer, editor]

# review-loop: writer ↔ editor, up to 5 rounds.
collaboration:
  topology: review-loop
  agents: [writer, editor]
  max_iterations: 5

# star: all agents work in parallel.
collaboration:
  topology: star
  agents: [frontend, backend, devops]
```

## Custom flow

Need more control? Define edges explicitly:

```yaml
collaboration:
  flow:
    - "parent -> researcher"
    - "researcher -> writer: research findings"
    - "writer -> editor: draft content"
    - from: editor
      to: writer
      label: revision requests
    - from: editor
      to: parent
      label: approved
      exit: true
  max_iterations: 2
```

Two edge syntaxes (mix freely):

- **String**: `"from -> to"` or `"from -> to: label"`
- **Object**: `{ from: ..., to: ..., label: ..., exit: true }`

Special rules:
- `parent` is a reserved name — it means the orchestrator (your main role)
- Edges pointing to `parent` or marked `exit: true` terminate the workflow
- `max_iterations` prevents infinite loops in cyclic graphs (defaults to 3 if a cycle is detected)

## Hybrid: topology + custom edges

Start from a template, then override or add edges:

```yaml
collaboration:
  topology: pipeline
  agents: [coder, reviewer]
  flow:
    - "reviewer -> coder: needs revision"   # adds a back-edge on top of the pipeline
  max_iterations: 3
```

Custom `flow` edges are merged with the template. If a custom edge has the same `from → to` as a template edge, the custom one wins.

## What happens at runtime

You don't need to manage the workflow manually. Rolebox handles it:

1. When a chat starts, the graph state initializes (step 0, status: active)
2. The orchestrator's system prompt gets a `<collaboration_graph>` block describing the workflow and a `<collaboration_state>` block showing current progress
3. Each subagent's prompt gets a `<collaboration_role>` block explaining its position (e.g., "You receive work from Coder. Your output goes to Editor.")
4. Every time `dispatch` dispatches to a subagent, the state advances to the next step
5. When an exit edge is reached or max iterations are exceeded, the workflow completes

The orchestrator LLM sees the state on every turn, so it knows which agent to call next without you hardcoding dispatch logic in the prompt.

## No graph? No problem

The `collaboration:` field is optional. Roles with subagents but no graph continue to work exactly as before — the parent decides dispatch order freely via `dispatch`.

## Loop termination

By default, loops stop when `max_iterations` is reached. The `termination:` block gives you finer control: stop when the reviewer approves, when output stops changing, when a timeout fires, or any combination.

```yaml
collaboration:
  topology: review-loop
  agents: [coder, reviewer]
  max_iterations: 5
  termination:
    any_of:
      - { max_iterations: 5 }
      - { converged: "reviewer confirms code quality is satisfactory" }
```

### Condition types

Five condition types are available:

```yaml
# Stop after N loop iterations
- { max_iterations: 5 }

# Stop after N milliseconds since the first loop iteration
- { timeout_ms: 120000 }

# LLM judge evaluates a natural-language convergence criterion
- { converged: "reviewer confirms code quality is satisfactory" }

# Stop when a specific agent's output matches a pattern
- result_matches:
    agent: reviewer
    contains: "APPROVED"      # substring match
    # regex: "LGTM|APPROVED"  # or regex match
    # score_gte: 8            # or numeric score threshold
    # no_changes: true        # or output hash unchanged from previous iteration

# Stop when the same agent produces identical output N times in a row
- { stuck: { repeats: 2 } }
```

### Composition

Conditions compose with `any_of` (first condition wins) or `all_of` (every condition must be satisfied):

```yaml
# Stop on whichever fires first
termination:
  any_of:
    - { max_iterations: 10 }
    - { stuck: { repeats: 2 } }

# Stop only when both are true
termination:
  all_of:
    - { max_iterations: 2 }
    - result_matches:
        agent: reviewer
        contains: "APPROVED"
```

You can use both `any_of` and `all_of` in the same config. Each group is evaluated independently, then the results are combined with AND logic.

### Termination reasons

When the workflow ends, the state includes a structured `terminationReason` so the orchestrator knows why it stopped:

| Reason | Trigger |
|---|---|
| `max_iterations` | Loop count reached the cap |
| `timeout` | Wall-clock time exceeded `timeout_ms` |
| `stuck` | Agent output repeated N times |
| `converged` | LLM judge confirmed convergence |
| `result_match` | Agent output matched `result_matches` criteria |
| `error` | Unrecoverable error during evaluation |

The orchestrator's system prompt shows the reason so it can synthesize an appropriate final response.

### Advisory enforcement

Termination is advisory, not a hard stop. When a condition fires, the orchestrator receives guidance to wrap up and synthesize results. It doesn't forcibly deny tool calls or kill sessions mid-turn.

### Precedence and caveats

**Per-loop vs global `max_iterations`:** The root-level `max_iterations` on the `collaboration:` block is a global safety cap. A `max_iterations` inside `termination.any_of` or `termination.all_of` is a per-loop-group cap. The per-loop cap fires its own termination reason; the global cap is the backstop that applies regardless of termination config.

**`timeout_ms` overshoot:** The timeout is checked between turns, not mid-turn. A long-running agent turn that starts before the deadline will finish. Expect overshoot of up to one full turn.

**Legacy compatibility:** Existing configs with just `max_iterations` (no `termination:` block) work exactly as before. No migration required.
