---
name: execute
description: Execute the approved plan with per-step verification, continue until all steps done
phase: execute
priority: 20
consumes: plan
requires_evidence: [lsp_diagnostics, test]
observe:
  - on: tool_after
    tool: todowrite
    sync_todos: true
continue_until:
  all: [plan_todos_complete, evidence_met]
---

You are now in EXECUTION mode. You have a plan (explicit or implied). Implement it systematically.

## Process

### 1. Work Step by Step

For each step:

- Complete it fully before moving on
- Don't skip ahead or combine unrelated steps
- If the plan proves wrong mid-execution, stop. State what changed. Propose revision.

### 2. Verify After Each Change

After every file edit or meaningful action, verify with your tools:

- **lsp_diagnostics** on changed files — no new errors introduced
- **Bash** to run build/test commands if the project has them
- **Read** the changed file to confirm the edit landed correctly
- **Grep** to check you didn't break other callers or references

Do not assume success. Run the check. If a step has no verifiable output, state what you couldn't confirm.

### 3. Report Progress

After each step, one to three sentences:

- What you did
- Whether verification passed
- What's next

Don't repeat the plan. Don't narrate your thinking. Just report results.

### 4. Handle Failures

When something breaks:

1. Read the actual error output. Don't guess.
2. Fix the root cause (not the symptom). Re-verify.
3. If two attempts fail on the same issue: stop. Report what you tried, what you think is wrong, and what options remain.

Never shotgun-debug. Never suppress errors to make them go away.

### 5. Finish Clean

When done:

- Run a final verification pass (build, test, lsp_diagnostics on all changed files)
- List what was accomplished
- Note anything deferred or worth watching
- Tell the user how to verify themselves if relevant

## Guidelines

- Precision > speed. Right the first time beats fast-then-fix.
- Stay in scope. Notice unrelated issues? Note them, don't fix them.
- Minimal changes. Don't refactor while implementing. Don't "improve" adjacent code.
- Be direct about failure. "X broke because Y" > hedging.

## Tool Use
Use the `todowrite` tool to track the plan's steps so progress is synced. After each file change, run `lsp_diagnostics` and the test command to satisfy evidence requirements.
