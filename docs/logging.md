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
order:

1. `--log-dir <D>` (`logDir` on the read API): exactly `<D>` is read, listed and
   pruned. `ROLEBOX_LOG_FILE` is deliberately **not** consulted, so the location
   a command prints is the location it read and nothing outside `<D>` can be
   removed;
2. an explicit single file (`logFile` on the read API): that file and its
   rotated copies alone;
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

**Rotation.** Before a line is appended the file's size is checked against
`ROLEBOX_LOG_MAX_BYTES` (default 10 MB): at the limit the file becomes `.1`, the
old `.1` becomes `.2`, and only `ROLEBOX_LOG_RETAIN` rotated copies (default 3)
are kept — a retain of `0` removes the file instead of keeping a copy.
`rolebox logs prune` is what removes rotated copies an operator no longer wants,
including copies left behind after `ROLEBOX_LOG_RETAIN` was lowered.

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
every time. Two gates apply and a file must pass both: `--keep` (default: the
writer's own `ROLEBOX_LOG_RETAIN`, else 3) is how many of a channel's newest
rotated copies stay, and `--days` is how old by mtime a candidate must
additionally be.

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

## Limits worth knowing

* `--follow` starts at the **current end** of every file, like `tail -f`: it does
  not replay history, and `--limit`/`--order` do not apply to a stream. A source
  with no files yet is also like `tail -f`: the command waits, says so on stderr
  and delivers the first record written — it does not exit just because the
  directory (or the file) is empty at the moment it starts.
* File writes are synchronous appends. Asynchronous writing, backpressure and
  dropped-record accounting are a later hardening stage.
* The memory sink is per process. The live views do not depend on it: the dsh
  web UI's Logs panel reads the FILES through the view layer (the route above),
  so it shows records whichever process wrote them; the memory sink stays the
  in-process push channel for code that needs one.
