# Logging

> Part of the rolebox documentation. See [README](../README.md) for overview, and
> [cli.md](cli.md#logs) for the `rolebox logs` command reference.

rolebox writes every diagnostic through one pipeline (`src/log/**`). A diagnostic
is a **record**: what happened (level, channel, optional event code, message,
data fields), who it happened to (the ambient scope) and where it happened (pid
and process role). Two audiences read that pipeline:

| | Console | File |
| --- | --- | --- |
| Who reads it | the person running rolebox right now | an operator or a script, afterwards |
| Gate | `ROLEBOX_LOG_CONSOLE_LEVEL` (default `warn`) | `ROLEBOX_LOG_LEVEL` (default `info`) |
| Shape | one line: `[level] channel code scope k=v — message` | one JSON object per line |
| Kept where | the process's console | `<log dir>/<channel>.log` |

Both destinations are fed by the same record, so a line you watched live and the
line you read back from the file are the same diagnostic — the console line is
rendered by `src/log/sinks/console.ts`, and `rolebox logs` reuses that exact
renderer.

## The record

One JSON object per line, written by the file sink:

```json
{"time":1791453600000,"level":"warn","channel":"graph:host","code":"watch.settlement-threw","message":"settling the announced execution threw, so the attempt stays unsettled","scope":{"graphId":"g-42","attemptId":"impl#2"},"fields":{"executionId":"exec-7","failure":"Error"},"process":{"pid":4242,"role":"host"}}
```

| Key | Meaning |
| --- | --- |
| `time` | epoch milliseconds |
| `level` | `debug`, `info`, `warn`, `error` or `fatal` |
| `channel` | the emitting source, e.g. `graph:host`, `cli`, `dispatch` |
| `code` | the registered event code (present only on events) |
| `message` | one sentence stating the durable fact |
| `fields` | the caller's data: ids, states, reasons and counts |
| `scope` | the ambient identity: `sessionId`, `agent`, `graphId`, `runId`, `nodeId`, `attemptId`, `effectId`, `tool` |
| `process` | `pid` and the process `role` (`host`, a worker role, …) |

The same record on the console:

```
[warn] graph:host watch.settlement-threw graph=g-42 attempt="impl#2" executionId="exec-7" failure="Error" — settling the announced execution threw, so the attempt stays unsettled
```

Scope keys are shortened to the names those ids are known by (`graphId` → `graph`)
and rendered in a fixed order; fields follow in the caller's order; the message
comes last, after an em dash. `fatal` is the loudest level and goes to
`console.error` like `error`.

### Privacy

The record is designed so that nothing sensitive can be logged by accident:

* `fields` admits ids, states, reasons, counts and arrays of them — never a
  payload, an accepted result, a credential or a raw platform error body. The
  type (`src/log/types.ts`) is the first line of that rule and the redaction pass
  (`src/log/redact.ts`) is the last.
* Nothing in the pipeline logs the request/response bodies of a tool call, an
  accepted outcome's data, or a credential.
* `detail` and `error` fields, where an event carries them, describe a LOCAL
  failure (a file that could not be written, an error's name and one bounded
  line) — not a remote error body.

Treat a log file as you would any other diagnostic artifact: it names graph,
session and attempt ids, file paths and error names, and that is all it should
ever contain. If you find anything else in one, that is a bug in the call site,
not a feature of the pipeline.

## Where the files are

### The write chain

The log **directory** a writer uses is resolved in this order:

1. the directory of `ROLEBOX_LOG_FILE`, when that legacy variable names a file;
2. an explicit directory (`configureLogging({ logDir })`);
3. `ROLEBOX_LOG_DIR`;
4. the workspace's `.rolebox/logs` — the nearest ancestor of the working
   directory that holds a `.rolebox` directory;
5. `<config dir>/logs` (`ROLEBOX_CONFIG_DIR`, else `XDG_CONFIG_HOME/rolebox`, else
   `~/.config/rolebox`; `%APPDATA%` on Windows);
6. `<tmpdir>/rolebox-logs`.

`ROLEBOX_LOG_FILE` therefore beats a configured directory on the WRITE side: with
it set, every channel of that process appends into the one file — that is the
whole point of the legacy mode.

### The read chain: an explicit source beats the environment

`rolebox logs` (and the read API it uses) resolves the source it READS in this
order — an explicit file, then an explicit directory, then the writer's own
chain:

1. an explicit single file (`logFile` on the read API): that file and its
   rotated copies alone. The CLI has no flag for it, so only an embedder passes
   one;
2. `--log-dir <D>` (`logDir` on the read API): exactly `<D>` is read, listed and
   pruned. `ROLEBOX_LOG_FILE` is deliberately **not** consulted, so the location
   a command prints is the location it read and nothing outside `<D>` can be
   removed;
3. neither: the WRITE chain above decides, so a process logging to
   `ROLEBOX_LOG_FILE` is still readable without options.

The asymmetry is deliberate and is pinned by tests: a writer must keep sending
every channel to the one file it was configured with, while a reader that names a
directory must get that directory — never a file somewhere else.

The directory is created lazily on the first record written to a file; a process
that never logs opens nothing.

**One file per channel.** A channel writes `<log dir>/<channel>.log`, with every
character that is not a letter or a digit replaced by `-`: `graph:host` writes
`graph-host.log`. Two processes logging different channels therefore never race
over one rotation, a channel can be followed on its own, and the file names stay
stable enough to document.

> **This replaces the old mental model.** Before the platform pipeline there was
> one `rolebox.log` for everything. Historical files are **not** migrated: the
> writer's location chain never selects an old `rolebox.log` again, and nothing
> rewrites or deletes it. The path is not reserved, though, because the channel
> name IS the file name: a channel literally named `rolebox` — which is also the
> name an unnamed logger falls back to (`DEFAULT_LOG_CHANNEL`) — writes
> `<log dir>/rolebox.log`, so where a historical file still sits at that path, new
> records from such a channel are appended into it. Reading has the same
> ambiguity: `rolebox logs files` cannot tell that file from a channel literally
> named `rolebox` either — both are `<channel>.log` — so it lists it and
> `rolebox logs` scans it, reporting its pre-platform lines (valid JSON in the old
> tslog shape, not records) as skipped malformed lines instead of dropping them
> silently; pass that file to `jq` directly for them. To give new records one file
> again, set `ROLEBOX_LOG_FILE`.

**Legacy single-file mode.** With `ROLEBOX_LOG_FILE=/path/to/rolebox.log` set,
every channel appends into that one file instead of its own, and rotation applies
to it the same way. `rolebox logs` reads it too — unless `--log-dir` names a
directory — because with no explicit source the read side resolves the same
location the writer does.

**Rotation.** Before a line is appended the file's size is read **from disk** and
checked against `ROLEBOX_LOG_MAX_BYTES` (default 10 MB): at the limit the file
becomes `.1`, the old `.1` becomes `.2`, and only `ROLEBOX_LOG_RETAIN` rotated
copies (default 3) are kept — a retain of `0` removes the file instead of keeping
a copy. `rolebox logs prune` is what removes rotated copies an operator no longer
wants, including copies left behind after `ROLEBOX_LOG_RETAIN` was lowered.

Reading the size from the file, rather than counting the bytes *this* process
appended, is what makes the limit the size the file actually rotates at: the file
is shared, so three processes each waiting for their own share of a 1 KB limit
let it reach 2316 bytes — 2.3× — before anybody rotated. A writer that finds
another process rotating also **waits** for that rotation instead of appending
into the file about to be renamed, because those bytes travel with the inode into
the copy being made.

**The wait follows the holder's progress, not a stopwatch.** While it walks the
retention ladder, the process holding the rotation lock refreshes the lock file's
mtime at least every 5 ms, and a waiting writer keeps waiting while that mtime is
younger than 25 ms. After that window, the writer also checks the lock owner's
PID: a live process may have been paused by the scheduler, so the writer waits
until the lock disappears or reaches the 10 s stale-lock limit. A dead or
demonstrably dead owner releases the writer — one record per stalled lock instance,
not one per record. The give-up is
remembered per lock instance (inode + mtime), so a resumed heartbeat or a replaced
lock arms the wait again. An earlier version gave up **permanently** after 25 ms,
and that one flag turned a single slow rotation into a process that appended into
every later file mid-rename: rotated copies reached 39–50× the limit. The bound
now is **the limit plus one record per concurrent writer**, because the gate is a
check followed by an append — a record that passed the gate an instant before
another process rotated is *in* the copy. Measured on three real processes writing
one channel through the multi-process probe: 1.118–1.128× at its 4 KB default,
1.012–1.014× at a 32 KB limit with an 8-copy ladder, and 1.385× (1,418 B for a
1 KB limit, 394 B of it in-flight records) on the deep-ladder load — a 1 KB limit,
4096 copies, writers back to back, the same configuration in which the
permanent-give-up version measured 39–50×. Every one of those runs delivered all
of its records exactly once.

**Rotation is coordinated between processes, and it has to be.** More than one
process writes the same channel file — a host and the workers it started all
resolve the same `.rolebox/logs` — and an uncoordinated rename LOSES records:
`rename(path, path.1)` *replaces* an existing `.1`, so a process that decided to
rotate a moment before another one finished overwrites the copy the first just
made. Measured with three real processes writing one channel
(`bun scripts/log-multiprocess-probe.ts`, 3 × 400 records, a 4 KB limit and a
retention far above the volume so that retention could not be the cause): the
uncoordinated sink lost **70 of 1200** records, and a replay lost 143 — always
the first ~24 records of every writer, i.e. exactly what the first rotation had
moved aside. The sink now rotates under a per-file lock
(`<channel>.log.rotate.lock`, created `O_EXCL`) and re-reads the file's size once
it holds the lock: exactly one process renames, and the others append to whatever
file results. A lock left behind by a process that died is broken after 10
seconds. The lock is **not a log file** — `rolebox logs files`, a query and
`prune` never list it. After the change the same probe delivers every record
**exactly once**: 1200/1200, no torn or interleaved line, no duplicate, and the
merged view is ordered by `time`.

## Environment variables

| Variable | What it sets | Default |
| --- | --- | --- |
| `ROLEBOX_LOG_LEVEL` | the global (file) threshold: records below it are not written at all | `info` |
| `ROLEBOX_LOG_CONSOLE_LEVEL` | the console threshold | `warn` |
| `ROLEBOX_LOG_LEVEL_<CHANNEL>` | one channel's threshold, e.g. `ROLEBOX_LOG_LEVEL_GRAPH_HOST=debug` for `graph:host` | — |
| `ROLEBOX_LOG_DIR` | the log directory (step 3 above) | resolved chain |
| `ROLEBOX_LOG_MAX_BYTES` | the rotation size limit | `10485760` (10 MB) |
| `ROLEBOX_LOG_RETAIN` | how many rotated copies to keep | `3` |
| `ROLEBOX_LOG_FILE` | **legacy:** one file for every channel; beats the directory on the write side (and on a read that names nothing — `rolebox logs --log-dir` still wins) | — |

A channel override key is the channel upper-cased with every non-alphanumeric
character replaced by `_`, so `graph:host` → `ROLEBOX_LOG_LEVEL_GRAPH_HOST`. An
unset, blank or invalid value falls back to the default; a level is never
guessed.

```bash
# Watch the graph engine's detail without turning the whole process up.
ROLEBOX_LOG_LEVEL_GRAPH_HOST=debug ROLEBOX_LOG_CONSOLE_LEVEL=debug rolebox monitor
```

## Event codes

Every structured diagnostic is an **event**: a code registered in
`src/log/registry.ts`, where its level, its channel and its one-sentence message
live. A code that is not in that table does not compile, and a call site cannot
drift the wording of a stable diagnostic.

That table is the **authority**, and this page deliberately does not copy it — a
code list copied into documentation drifts within a release. To see the current
vocabulary:

```bash
grep -n '^  "' src/log/registry.ts          # every registered code, in table order
```

Records that are not events carry no `code`; they come from the level helpers
(`log.warn("…", { … })`) with a sentence that only exists at the call site.

### Throttling

A few events opt into a suppression window (`throttleMs` in the registry). A
window is keyed by **the channel, the code and — when the entry declares
`throttleBy` — a subject**: the value of that record field. The **first**
occurrence of each subject opens its own window and is emitted; the repeats of
that subject inside it are counted, and the count rides on the next emitted
record **about the same subject** as the `suppressed` field — the loss is
reported, never silent, and one subject's suppression can never swallow another
subject's report. Every other event, which is the default, is emitted every
time.

`throttleBy` names a field the entry's callers actually pass with a string
value:

* `log.event.unknown-code` throttles by `code` — every drifted code is its own
  subject, so three different unregistered codes inside one minute are **three**
  records, each naming its own code, and only a repeat of the *same* code is
  collapsed;
* `log.field.narrowed` throttles by `channel` — its records all report on the
  single registry channel `log:compat`, so without the subject one window would
  cover the whole process and the second call site's first report would be lost.
  With it, the window is per caller channel.

A field that is absent, or whose value is not a string, degrades to the empty
subject — the pre-subject behaviour, one window per `(channel, code)`. That is
why a misspelled `throttleBy` is not harmless, and why the name is checked
against the entry's own call sites by `tests/log/throttle-policy.test.ts`.

| code | window | subject (`throttleBy`) | why it opted in (counts from this workspace's own `.rolebox/logs`) |
| --- | --- | --- | --- |
| `sweep.summary` | 10 s | — | the densest code measured: 335 records, **74 inside one ten-second window**, 20 inside one second, 36 repeating their predecessor's fields |
| `dispatch.unclaimed-confirmation` | 60 s | — | 48 records carrying **two** distinct facts; 41 repeat their predecessor's fields, median gap 169 ms |
| `tool.control-continuation` | 60 s | — | 93 records, 16 inside one second, 28 consecutive identical |
| `tool.cancel-delivery` | 60 s | — | 66 records carrying seven attempt states, 21 consecutive identical, median gap 21 ms |
| `log.event.unknown-code` | 60 s | `code` | no record in the workspace sample (0 of 12 codes): the window is not earned by a measured burst but by the subject — it collapses an exact repeat of one drifted code and reports the repeat count, while every *different* code still gets its first report |
| `log.field.narrowed` | 60 s | `channel` | 0 records too (a `debug` record while the workspace runs at the default `info`): the window is per caller channel, so a call site that narrows on every record collapses into one line per minute without hiding another call site's first report |

**No first-failure event is throttled** unless a subject dimension makes every
different subject's first report unlosable. A store that could not be read, a
delivery with no proof that no execution exists, an unproven release, a
definition that never reached the store: each of those keeps every occurrence —
its subject is not a field the caller passes, so a window would hide a first
report about something else. The rule and the reason are stated at the top of
`src/log/registry.ts`, and the exact set, the rule and every `throttleBy` name
are pinned by `tests/log/throttle-policy.test.ts`.

Re-measure the evidence on any log directory:

```bash
bun scripts/log-event-density.ts                # the resolved source (.rolebox/logs here)
bun scripts/log-event-density.ts --dir /path/to/project/.rolebox/logs
# records, the largest 60 s/10 s/1 s burst, repeated fields, and — for a code that
# already has a window — how many records the window would let through.
```

## Reading the logs

`rolebox logs` is the read side of the files. It answers the newest records
first, one runtime-rendered line each, and reads the same location the writer
writes — unless `--log-dir <D>` names one, in which case it reads exactly `<D>`
(the read chain above).

```bash
rolebox logs                                   # the last 100 records, newest first
rolebox logs --level warn                      # warn, error and fatal (a threshold, like ROLEBOX_LOG_LEVEL)
rolebox logs --channel graph:host --since 1h   # one channel, last hour
rolebox logs --graph g-42 --text timeout       # one graph, records mentioning "timeout"
rolebox logs --code watch.settlement-threw --json  # one event code, JSON lines for jq
rolebox logs --follow                          # tail live, Ctrl-C to stop
```

`--since`/`--until` accept a relative duration (`30s`, `10m`, `2h`, `1d`, `1w`), an
ISO 8601 instant, or epoch milliseconds. A bare number is rejected rather than
guessed — write `10m` or a 13-digit timestamp. Exit codes: **0** for any answer,
including "no records matched" and "that directory does not exist"; **1** only
for an argument the command cannot honour, with the usage line. Notes about the
answer (an empty result, a truncation at `--limit`, malformed lines) go to
stderr, so `--json` stays parseable.

### With `jq`

`--json` writes one record per line in the READ layer's normalised key order —
`time`, `level`, `channel`, `message`, `fields`, `scope`, `process`, then `code`
when the record has one — so `jq` reads it directly. (The file sink writes `code`
before `message`, in the order of the record example above; `jq` does not depend
on either order.)

```bash
# One line per record: level, channel and message.
rolebox logs --json | jq -r '"\(.level)\t\(.channel)\t\(.message)"'

# Which events fired, and how often.
rolebox logs --json | jq -r '.code // empty' | sort | uniq -c | sort -rn

# Errors and worse, with the identity they belong to.
rolebox logs --json --level error |
  jq -r '[.level, .channel, (.code // "-"), (.scope.graphId // "-"), .message] | @tsv'

# One graph's story, oldest first.
rolebox logs --json --graph g-42 --order asc | jq -r '"\(.time) \(.channel) — \(.message)"'

# The fields of one event code, flattened.
rolebox logs --json --code watch.settlement-threw | jq -c '.fields'

# Counts per channel for the last hour.
rolebox logs --json --since 1h | jq -s 'group_by(.channel) | map({channel: .[0].channel, n: length})'

# Live tail through jq (--unbuffered keeps the output line-by-line).
rolebox logs --follow --json | jq --unbuffered -r '"\(.level) \(.channel) \(.message)"'
```

Because every process writes its own channel file and the reader sorts by `time`,
the merged view of several processes is one time-ordered stream.

### Files and pruning

```bash
rolebox logs files                    # channel, rotation, size and mtime of every log file
rolebox logs files --log-dir /path/to/project/.rolebox/logs
rolebox logs prune --dry-run          # what would go, and how much that frees
rolebox logs prune --days 7           # rotated copies older than a week, beyond the retained window
rolebox logs prune --keep 0 --days 30 # keep none: every rotated copy older than 30 days
```

`prune` removes **rotated copies only**. The active `<channel>.log` is the file a
running process appends to, and it is never a candidate — the report says so
every time. Three gates apply:

* **`--keep <n>`** — how many of a channel's newest rotated copies stay. Its
  default is the WRITER's own retention, read from `ROLEBOX_LOG_RETAIN` in the
  pruning process, else 3. Because the writer never rotates past that many
  copies, a *default* prune on a healthy directory finds nothing to do; it earns
  its place after the variable was **lowered** (the copies the writer rotated
  while it was higher stay on disk) or on a directory several processes wrote
  under different limits. Measured: the writer keeps **at most**
  `ROLEBOX_LOG_RETAIN` copies, so a channel written under
  `ROLEBOX_LOG_RETAIN=8` that rotated eight times holds `.1`–`.8`;
  `ROLEBOX_LOG_RETAIN=2 rolebox logs prune` then removes `.3`–`.8` and keeps
  `.1`, `.2`; an explicit `--keep 0` removes those two as well. The WRITE side
  under the same variable: `ROLEBOX_LOG_RETAIN=0` keeps no rotated copy at all
  (rotation *removes* the full file), `=1` keeps exactly `.1`, `=3` keeps
  `.1`–`.3`.
* **`--days <n>`** — an mtime age gate on top: a candidate must ALSO be at least
  that old. It has nothing to do with `ROLEBOX_LOG_MAX_BYTES`; the writer never
  reads it.
* **`--max-total-bytes <n>`** — a byte budget for the whole source, and the only
  gate that reaches INSIDE the retained window: while the total size of every log
  file left (active files included) exceeds the budget, the oldest surviving
  rotated copy goes — oldest by mtime first, and at equal mtimes the highest
  rotation number. `--days` outranks it: a copy the age gate protects is never
  removed to meet a budget, so the report can say the budget was **not met**. A
  budget smaller than the active files alone is never met either, because an
  active file is never removed; the report says exactly that instead of deleting
  the file a process is writing to.

```bash
rolebox logs prune --dry-run                    # what would go, and how much that frees
rolebox logs prune --keep 1                     # only the newest rotated copy survives
rolebox logs prune --days 7                     # ...and only copies older than a week
rolebox logs prune --max-total-bytes 50000000   # keep the whole log dir under ~50 MB
rolebox logs prune --keep 0 --days 30           # keep none: every copy older than 30 days
```

Measured boundaries for `--max-total-bytes` (a directory with an active file and
five rotated copies, `--keep 99` so the count gate keeps all of them): a budget
of *active + one copy* removes the four oldest copies and reports `met`; a budget
of `0` removes all five and reports `NOT met — 172 B left, and active files are
never removed`; a 30-day `--days` gate together with a budget of `0` removes
nothing and reports `NOT met`, because the age gate is the operator's freshness
promise and outranks the budget.

## The live view (dsh web UI)

The dsh web UI carries a **Logs** page in the right Sidebar — a sibling tab of
the Rolebox run console, listed in the Sidebar's guide as *Live log view: one row
per record, with level, channel and the source being read*. It is the browser
half of the same read side the CLI uses, over one JSON route.

### The route: `GET /rolebox/logs`

The route is a `prefix` route registered under `/rolebox/logs` (the existing
`/rolebox` run-console route is untouched: dsh's host webserver resolves by
longest prefix and refuses only duplicate `(kind, path)` pairs). It answers the
pollable view — exactly the five keys `readLogView` returns, with no envelope:

```json
{
  "records": [ { "time": 1791450000000, "level": "warn", "channel": "graph:host",
                 "code": "sweep.store-blocked", "message": "…",
                 "fields": { "reason": "lock" }, "scope": { "graphId": "g1" },
                 "process": { "pid": 123, "role": "host" } } ],
  "cursor": "001791450000000.000~1",
  "source": { "kind": "dir", "path": "/path/to/project/.rolebox/logs" },
  "truncated": false,
  "skippedLines": 0
}
```

The `cursor` is the pollable view's watermark, spelled
`"<epoch-millis, padded to 15 digits>.<millis, 3 digits>~<how many records share
that millisecond>"` — the example above names the record it sits beside
(`001791450000000.000~1`). It is **opaque**: take it from the previous answer and
hand it back unchanged (it needs no URL escaping), never compose one. What the
watermark does and does not promise — rotation and `prune` can drop a window that
was never delivered, and a record appended behind the watermark is not re-sent —
is the contract at the top of `src/log/view.ts`.

| parameter | meaning |
| --- | --- |
| `cursor` | Opaque watermark from a previous answer; absent means "the newest window". Never rejected: one this build cannot **read** (a truncated or foreign spelling) is treated as absent, so the recent window is repainted instead of the request failing. A *well-formed but old* watermark is a different case: it is honoured, and the walk continues forward from it (the contract is in `src/log/view.ts`). |
| `limit` | Whole number, `0` or more; default `1000`. The window can hold **more** than `limit` records when a burst shares its edge millisecond — that is what keeps a cursor exact; the real size is in `records`. |
| `level` | **Lowest** level to keep (`warn` keeps warn, error, fatal); case-insensitive. |
| `channel` | Channel name(s), exact match; comma-separated and/or repeated (`?channel=graph:host&channel=web-ui`). |
| `code` | Event code(s), exact match; comma-separated and/or repeated. A record without a code never matches. |
| `graph` | Records whose scope carries this `graphId`. |
| `session` | Records whose scope carries this `sessionId`. |
| `text` | Case-insensitive substring over message, channel, code and field values (never over scope ids). |

The filters are ANDed. A parameter that is present but illegible (`?limit=abc`,
`?level=verbose`, `?channel=`) is a **`400`** with a message that names the
parameter, its accepted form and the value it got — never a `500`, and never a
silently different filter. A missing or empty log directory is a **`200` with an
empty set**, the same philosophy as the CLI's exit codes: "nothing has been
logged here yet" is a reading, not a failure, and `source` still names the
directory that was looked in. Malformed lines are counted in `skippedLines`,
never fatal.

```bash
curl -s 'http://127.0.0.1:PORT/rolebox/logs?level=warn&limit=20' | jq .
# then walk FORWARD from the window that answer painted (oldest pending first),
curl -s 'http://127.0.0.1:PORT/rolebox/logs?cursor=001791450000000.000~1' | jq -r '.records[].message'
# handing the returned cursor back, poll after poll, never repeats a record
```

**The source is fixed at construction, never taken from the request.**
`DshRoleboxLogsWebRoute` accepts an explicit `logDir` or `logFile` (the plugin
passes them when it wants a specific location and omits both to let the writer's
own chain decide, exactly as `rolebox logs` does), so `?logDir=` in a query
string changes nothing: an HTTP caller cannot point the reader at a directory of
its choosing, and `source` is always the location that was actually read.
**Mounted by the dsh entry.** `src/entries/dsh.ts` constructs the route
immediately beside the composed `/rolebox` (role-switch + run console) route,
under the same optional-service guard: the route exists whenever the host
provides the `webServer` service (the web profile) and is skipped entirely on a
headless boot.

```ts
const logsRoute = new DshRoleboxLogsWebRoute();
routeDisposers.push(logsRoute.register(webServer));
```

> **Mounted — a running surface.** Whenever `ctx.get('webServer')` resolves, the
> entry registers TWO prefix routes: the composed `/rolebox` (role-switch
> `/roles*` plus run console `/status` and `/metrics`) and `/rolebox/logs`.
> They are different `(kind, path)` pairs, so the host's duplicate check does not
> fire, and the host resolves a request by **longest prefix**: `/rolebox/logs`
> and everything under it reach the log route, while every other `/rolebox/*`
> request still reaches the composed route exactly as before. The log
> registration has its OWN guard — a failure logs
> `Rolebox logs route registration failed — degrading` and the plugin keeps
> running, leaving the role-switch/run-console surface untouched (and a failure
> of that one never prevents the log route's attempt). Both disposers are
> collected on the fiber, so teardown unmounts the route, and the boot reports
> the outcome as `stats.logsRouteRegistered`. The behavior is exactly the
> contract above: read-only `GET` (`200` with the view JSON), `400` for an
> illegible query parameter, `404` for an unknown sub-path, `405` for a known
> path with another method, `500` for an unexpected failure, and `200` with an
> empty set when the log directory does not exist yet. The **Logs** tab (right
> Sidebar, type `rolebox-logs`) polls this route, so it paints records instead of
> its error state. `tests/dsh-plugin.test.ts` proves the registration against the
> registrar itself, and `tests/dsh-cordis-e2e.test.ts` pins the two-route table
> on a real cordis boot.

(As a delegate of the composed `/rolebox` registration the same handler works
unchanged, because a delegate receives the same `(req, res)` with the full URL.)

### What the panel does

* **Polls with a cursor.** The first poll paints the newest window; every later
  poll hands the cursor back and appends only what came after it, so a record is
  painted once and no record is skipped between two polls (the view layer's own
  cursor contract). Default window: 200 records.
* **Polls only while visible, and only while unpaused.** A hidden tab tears the
  interval down and says `Hidden`; showing it again polls immediately. **Pause**
  stops the stream and keeps the buffer; **Resume** continues from the *same*
  cursor, so a pause neither repeats nor loses a record. **Refresh** polls once,
  immediately, without waiting for the next tick.
* **Bounds its buffer.** At most **500** records stay (the newest); the pane
  reports how many the cap dropped, because a silently shortened history reads
  as "that is all there was".
* **Says where it read.** The `Source` line prints the `source` the server
  reported — a pane reading a temp directory never claims to read the workspace —
  next to the record count, the malformed-line count and the time of the last
  poll.
* **Filters restart the view.** The channel select (and the optional *This
  session* toggle, offered when the tab is docked beside a session) narrow the
  server-side query; changing one starts a new view, because the old cursor names
  a position in the old stream. This is the only operation that discards what is
  on screen, and it is the user's own.
* **Empty and error are different sentences.** "No records yet" names the source
  it looked in; a failed read names the HTTP status and offers Retry; a failure
  after data arrived keeps the buffer on screen and reports the failure above it.

### Why the panel speaks JSON and never touches the kernel

The panel ships inside the browser bundle (`scripts/build-dsh-web-client.ts`,
Bun `target: "browser"`), where a node builtin is **not** a build error: Bun
substitutes an empty module and the bundle dies at evaluation time. Stage 2
measured exactly that — `src/log/context.ts` imports `node:async_hooks`, whose
browser stub is `{}`, so `new AsyncLocalStorage` throws
`TypeError: undefined is not a constructor` before a single slot registers. A
memory sink subscribed in the host process would not help anyway: the browser is
a different process, and the records it must show were written by whichever
process logged them.

So the panel reads `GET /rolebox/logs` and holds one string between requests —
the cursor. `tests/platform/dsh-web-ui-logs-bundle.test.ts` is the guard: it
builds the real client entry with the build script's own options, scans the
bundle for node and kernel markers, evaluates it the way the dsh module loader
does (refusing any external other than react) and asserts both right-Sidebar tab
bodies register. The probe's report lands in
`.rolebox/tmp/webview/bundle-probe.json`.

## The live view (TUI)

The TUI sidebar carries the same view as a second tab. `ctrl+l` toggles between
**activity** (the default) and **logs**; the sidebar's own `view activity · logs`
line marks the active tab and, while Logs is showing, adds `live` or `paused` and
the level threshold in force.

| Key | What it does |
| --- | --- |
| `ctrl+l` | open the Logs tab, or go back to Activity |
| `ctrl+p` | pause the stream, and resume it |
| `ctrl+up` | raise the level threshold by one rank (towards `fatal`) |
| `ctrl+down` | lower it by one rank (towards `debug`) |
| `ctrl+n` | cycle the channel filter: each channel the buffer holds, then every channel again |
| `ctrl+g` | follow: clear the pane's free-text filter, unpause the stream, and read the newest records now — the level and channel filters stay in force |

Every Logs control is a `ctrl`-modified key, registered as one disposable keymap
layer by the plugin (`src/tui/index.tsx`), so the host's bare keys (`r` refresh,
`m` metrics, `f` filter, `?` help, the arrows) stay the host's. Outside the Logs
tab the controls act on the Logs view's own state — the pane is where you see
them — and the pause key is ignored entirely while Activity is showing.

The pane paints one row per record and renders it with the runtime's own line
format (`formatLogLine`, the console sink's renderer), so a row reads exactly
like the console line for the same record: `[level] channel code scope fields —
message`, shortened when it cannot fit the sidebar.

### What it reads

The pane reads the **same files the writer writes** — `<log dir>/<channel>.log`,
or the one file `ROLEBOX_LOG_FILE` names — through the same view layer as the dsh
web panel (`readLogView`, `src/log/view.ts`): with no explicit location it
follows the writer's own resolution chain, so a process logging into a workspace
`.rolebox/logs` is what the pane shows. The `src …` line prints the location the
last answer was actually read from, cut in the middle so the directory that
distinguishes it survives; before the first answer it reads `src resolving…`.

There is no second timer: the poll rides the sidebar's existing 1s refresh. The
first poll paints the newest window; every later poll hands the reader's cursor
back and appends only what came after it, so a record is painted once. One poll
asks the reader for 200 records (`POLL_LIMIT`) and the buffer keeps the newest
**500**, the same cap as the dsh web panel. The level and the channel filter are
sent to the reader, so a poll scans for what the pane is willing to show.

### The counters on the status line

`12/500 records · 3 dropped · 2 skipped · more waiting` — always led by the record
count, and each loss named only when there is one:

| Part | Meaning |
| --- | --- |
| `N/M records` | the buffer: N records match the pane's free-text filter out of the M it holds, and the pane paints the newest 200 rows of them |
| `dropped` | records the 500-record cap discarded from the front of the **current** view; `(N earlier)` is the half discarded by the views before it — the two are disjoint, so adding them is the lifetime total and never a doubled loss |
| `skipped` | malformed lines the reader counted in the last answer — a line that is not JSON, or JSON that is not a record. They are counted and skipped, never fatal |
| `more waiting` | the last answer came back truncated: more records existed than one poll delivers, and the next poll drains them from the cursor |

### Paused and failed are states, not silence

**Pause** freezes the cursor and stops the read: a frozen poll performs **no disk
read at all**, so a hidden tab costs no I/O. The pane prints
`PAUSED — ctrl+p resumes at this position`, and the position is the cursor the
stream stopped at: the first poll after Resume delivers the window the pause
withheld, so nothing is repeated and nothing is skipped.

The pane distinguishes the things that all look like an empty pane: `no records
yet — waiting for the first write` (nothing has been logged, with the source
named on the `src` line above), a read failure (`log read failed: …`, which keeps
the last good records on screen and is cleared by the next successful poll), and
the pause banner. When the Logs tab is not the active one the sidebar paints the
Activity view instead — one view at a time — with the tab line naming which one
is showing, and the Logs pane's own collapsed sentence (`hidden — press ctrl+l to
open`) is what the component paints if it is ever mounted without being live.

Changing the level or the channel filter starts a **new view**: the cursor names
a position in the old stream and the buffer holds records the new filter
excludes, so both are cleared together. That reset is the only operation that
discards what is on screen, and it is the reader's own.

## The compatibility layer, and the values it drops

Most modules still log through the compatibility shell
(`import { createSubLogger } from "../logger.ts"`), and their records travel this
same pipeline with the channel the sub-logger was built with. That shell's field
type is the kernel's — ids, states, reasons, counts — so a call site that hands it
an object, a nested array or a mixed array has that key dropped from the record.

The drop is no longer silent. The shell emits the registered
`log.field.narrowed` event — channel `log:compat`, level `debug`, throttled to one
report per minute **per caller channel** (`throttleBy: "channel"`), with the
suppressed occurrences counted on that channel's next report — naming the channel
the call site logged on and the dropped **key names**. It never carries the value,
which is exactly what could not be recorded. The subject is what keeps the window
honest: the record's own registry channel is the single `log:compat`, so a window
keyed by it alone would be one window for the whole process and the second call
site to narrow would lose its first report and its key names.

```sh
ROLEBOX_LOG_LEVEL_LOG_COMPAT=debug rolebox monitor   # the writer records them
rolebox logs --channel log:compat --level debug      # the reader lists them
```

```text
[debug] log:compat log.field.narrowed channel="probe:caller" keys="entity" — a field value the kernel's field type does not admit was dropped from the record
```

Each line names a source whose call sites still pass values a record may not
carry, and `keys` names the argument to fix in place. Why the shell exists at all,
and which direction new call sites should take, is
[logging-architecture.md](logging-architecture.md#the-compatibility-layer).

## Limits worth knowing

* `--follow` starts at the **current end** of every file, like `tail -f`: it does
  not replay history, and `--limit`/`--order` do not apply to a stream. A source
  with no files yet is also like `tail -f`: the command waits, says so on stderr
  and delivers the first record written — it does not exit just because the
  directory (or the file) is empty at the moment it starts.
* File writes are synchronous appends, **by measurement rather than omission**:
  the stage-5 write-path review put one representative record at 0.03 ms p99
  (13–16× under the 0.5 ms budget it was reviewed against), a record crossing
  the rotation limit at 0.2–0.3 ms, and the worst single call still inside a
  60 Hz frame — so the sink stays a synchronous `appendFileSync`, which is also
  what keeps a record readable the moment it is written. Re-measured after the
  rotation gate began reading the file's size on every record (one extra `stat`,
  ~1 µs): 0.022 ms mean, 0.042 ms p99 over 20,000 records, still about 12× under
  that budget. A record that arrives while *another process* is rotating waits
  for that rotation while the holder keeps refreshing its lock (a 5 ms heartbeat;
  25 ms without progress triggers a liveness check), which is the same rotation the
  process holding the lock is already performing. The numbers, the
  10,000-record burst and the revisit trigger are in
  [logging-architecture.md](logging-architecture.md#what-one-write-costs-measured).
  There is therefore **no write queue and nothing for the writer to drop**: the
  losses that are counted today are the throttled events' `suppressed` field
  (per subject), the unknown-code counter behind `log.event.unknown-code` — which
  the report carries as its `count`, per dropped code — the reader's
  `skippedLines`, and the live panes' own buffer-cap drop counts. Backpressure
  accounting arrives with the queue, if the trigger ever fires.
* **Concurrent rotation was a real, measured data-loss window, and it is closed.**
  See [Rotation](#where-the-files-are) above: before the per-file rotation lock,
  three processes rotating one channel lost 70–143 of 1200 records. The window is
  the rename itself — `rename(path, path.1)` replaces an existing `.1` — and it
  now takes a lock to enter. What this does NOT cover: an old rolebox binary (or
  any other writer) still rotating the same file WITHOUT the lock, and a file
  system whose renames are not atomic. Two writers that pass different
  `ROLEBOX_LOG_MAX_BYTES` values still serialize correctly — the gate reads the
  file, so whichever writer first sees the size reach *its* limit rotates and the
  others adopt the result — but the file then rotates at the smallest limit in
  play. A rotated copy holds everything that was in the file when the gate
  tripped plus what was appended while the shift ran — **the limit plus one
  record per concurrent writer**, because a record that passed the gate an
  instant before another process rotated is in the copy. The wait described
  under [Rotation](#where-the-files-are) is what keeps it to that, and the
  probe's `rotation-bound` check asserts that bound in bytes
  (`maxRotatedBytes ≤ ROLEBOX_LOG_MAX_BYTES + one record per writer`), with the
  overshoot and the factor reported beside it: 1.01–1.13× at the probe's 4 KB and
  32 KB configurations, 1.385× (394 B over) on the 1 KB deep-ladder load, and
  39–50× before the wait followed the holder's progress.
* **The live tail can fall behind a rotation, and it says so rather than
  pretending otherwise.** A follower polls: it lists the files, reads each from
  where it left off, and delivers the batch in `time` order. Between two polls a
  rotation renames every copy UP one name, so a file can move to a name the
  walk has already passed — the multi-process probe delivered a whole file one
  poll late that way, after records written into the fresh active file. The
  follower re-lists and reads again until a pass finds no unread byte (bounded at
  six passes per poll), which is what turns that from a 17% late block into 0
  late records in nine of ten stress runs and 2.5% in the tenth; a record is
  never lost and never delivered twice. The remaining inversion is EXACTLY a
  same-millisecond tie, and it is measured rather than waved at: on a 1 KB limit
  with writers back to back, 5 of 1200 records arrived with a `seq` below one
  already delivered for that writer, and all 5 shared the millisecond of the
  record that had set the high-water `seq` (none was older); the delivered
  stream stepped back in `time` 3 times, worst 37 ms, when a renamed file
  arrived a poll late. Nothing else about the view layer's contract changes:
  `rolebox logs` (the merged view) is ordered by `time`, and the live stream
  orders each poll by it.
* **The live `--follow` stream had the matching read-side race, and it is closed
  too.** One probe run delivered 157 of 1200 records twice: the follower rebuilt
  its offset ledger from each poll's listing, so a file a concurrent rotation had
  renamed between the listing and the read was forgotten and replayed. The ledger
  is now keyed by file identity, kept across polls, and the identity is taken
  from the OPEN descriptor. A record is still delivered at most once *per
  follower process* — two `--follow` processes each deliver the stream once, and
  a follower that starts later does not replay what was written before it
  started.
* **One field name trips the redaction rule.** `context-window.large-output`
  carries `estimatedTokens`, and the sensitive-term rule matches "token" inside
  it, so the count reaches the file as `"[redacted]"`. Nothing leaks — the
  redaction is in the safe direction — but the diagnostic loses its number. It is
  pinned (code, key, file) in `tests/log/redaction-scan.test.ts`, which fails if a
  NEW sensitive key appears at any call site and also fails once this one is
  renamed (the entry must then be deleted). The rename itself belongs to
  `src/recovery/builtin/context-window-monitor.ts`, outside the logging
  subsystem.
* The memory sink is per process. The live views do not depend on it: the dsh
  web UI's Logs panel reads the FILES through the view layer (the route above),
  so it shows records whichever process wrote them; the memory sink stays the
  in-process push channel for code that needs one.
