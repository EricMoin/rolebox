# dsh graph-worker command boundary

Single source of truth for what a `graph_worker_exec` command can and cannot do,
written for engineers and for prompt injection. Every claim below holds for
`src/platform/sandbox/graph-worker.ts`, `src/platform/sandbox/worker-exec.ts` and
the `graph_worker_exec` tool definition in `src/platform/adapters/dsh/`.

## Tools

- A worker session holds exactly two tools: `graph_submit_outcome` and `graph_worker_exec`.
- Write/Edit/Bash/Read-style native tools are not presented, and the host rejects every other tool name in a worker session.
- Every file read, edit, check, build, test and command goes through `graph_worker_exec`.

## Writes

- Writes are confined to the session workspace, `/dev`, the per-command scratch directory and `/tmp`.
- `/tmp` and `/private/tmp` are one vnode, so either spelling writes there.
- Any other write is denied, and the path answers `Operation not permitted`. `/tmp` is a shared, world-writable directory: it is an ordinary scratch path, not private to the attempt.

## Disposable environment

- `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `TMPDIR` are per-command directories under one scratch root, removed when the command ends.
- They carry no credentials and no host caches, so a command that needs real credentials or host state — `git push`, `gh`, `npm publish`, an authenticated API call — cannot succeed.
- Network egress is reachable but unauthenticated by construction: the command holds no credential the host did not create for it.

## Paths

- `/tmp` and `/private/tmp` are the same vnode, and a literal `/tmp` path is an ordinary command input.
- `Operation not permitted` on a path is a boundary denial, not a failed task: write inside the workspace or the per-command scratch directory instead.

## Limits

- The per-command timeout defaults to 60s and may be raised to at most 300s through `timeout_ms`, so a long build must be split across commands.
- Output is capped as well; a stopped command says it was stopped by cancellation, timeout or output limit.

## Shell

- The shell is `/bin/sh`, not bash: process substitution `<(...)` is a syntax error, while brace expansion and arrays work.
- `perl`, `sed`, `awk`, `grep`, `patch`, `diff`, `ed` and `git` are available under `/usr/bin` and `/bin`.

## Platform and toolchain

- The boundary is macOS-only: it requires an installed OS sandbox and refuses to start elsewhere.
- `git`, `bun` and `node` work inside the workspace, and their caches are disposable.
