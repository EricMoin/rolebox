# Logging architecture

Every diagnostic rolebox produces — from the graph engine, a dispatch, a tool
hook or a plugin service — travels one pipeline: a **record** is built, gated,
redacted and handed to the configured **sinks**. This page is the contributor's
map of that pipeline: what a diagnostic is made of, when it deserves a
registered event code instead of a sentence written at the call site, what a
record may and may not carry, and how to add a destination or read the files
back.

The operator view — the environment variables, the `rolebox logs` command, the
`jq` recipes and the two live surfaces — is in [logging.md](logging.md). The
command reference is [cli.md](cli.md#logs).

## The parts

| Module | What it owns |
| --- | --- |
| `src/log/types.ts` | The shapes and the level table: `LogLevel`, `LogFieldValue`, `LogFields`, `LogScope`, `LogRecord`, `LogSink` |
| `src/log/registry.ts` | The **closed event vocabulary**: one table entry per code, holding its level, its channel and its one-sentence message |
| `src/log/logger.ts` | `createLogger(channel)` → five level helpers plus `event(code, fields)` |
| `src/log/runtime.ts` | The process-wide state and the dispatch order (gate → normalise → redact → throttle → sink) |
| `src/log/context.ts` | `withLogScope` / `currentLogScope` — ambient identity over `AsyncLocalStorage` |
| `src/log/redact.ts` | The last line of the privacy rule: a field whose **key** names a credential is withheld |
| `src/log/throttle.ts` | The opt-in window for an entry that declares `throttleMs` |
| `src/log/sinks/console.ts` | One line per record, gated by `ROLEBOX_LOG_CONSOLE_LEVEL` |
| `src/log/sinks/file.ts` | JSON lines, one file per channel, rotation and retention |
| `src/log/sinks/memory.ts` | A bounded ring buffer plus `subscribe`, for in-process viewers |
| `src/log/sinks/fanout.ts` | Fan-out to every destination with per-sink isolation |
| `src/log/index.ts` | The public API: `logEvent`, `createLogger`, `withLogScope`, `configureLogging`, `subscribeLogRecords`, `getLogDir`, `getLogFilePath`, `__resetLoggingForTest` |
| `src/log/read.ts` | The read side: `listLogFiles`, `readLogRecords`, `followLogRecords`, `pruneLogs`, `resolveLogSource` |
| `src/log/view.ts` | `readLogView` — the same records as a **pollable view** with a cursor |
| `src/logger.ts` | The compatibility shell the older call sites import (see the last section) |

A dispatch does five things, in this order (`src/log/runtime.ts`):

1. **the level gate** — the channel's effective level drops everything quieter:
   an explicit channel override, then `ROLEBOX_LOG_LEVEL_<CHANNEL>`, then the
   configured global level, then `ROLEBOX_LOG_LEVEL`, then `info`;
2. **normalisation** — `undefined` values are dropped, arrays are copied and
   frozen, and a value whose runtime shape the declared field type does not
   admit is dropped;
3. **redaction** — a field whose key names a credential is replaced with
   `[redacted]`;
4. **the throttle gate**, only for an event code whose registry entry declares
   `throttleMs`; the window is keyed by the channel, the code and the SUBJECT the
   entry's `throttleBy` names (read out of the record's fields);
5. **the record** — built from the ambient scope, the process identity
   (`pid` + `role`) and the clock, frozen, and handed to the sink **under a
   guard**.

Everything is wrapped, so a dispatch never throws: a JavaScript caller passing
nonsense gets a dropped record, never an exception in the code being observed.

## An event or a level helper?

A diagnostic is one of two things.

| | Registered event | Level helper |
| --- | --- | --- |
| How it is written | `logEvent("code", fields)` or `createLogger(ch).event("code", fields)` | `createLogger(ch).warn("…", fields)` |
| Who owns the wording | the table in `src/log/registry.ts` | the call site |
| What the record carries | `code`, plus the table's level, channel and message | no `code`; the caller's message |
| When it is the right shape | a durable fact about a named entity: a state, a decision, a degradation, a refusal | a one-off sentence that only makes sense where it is written |

Register an event when **any** of these is true:

* the diagnostic reports the state, decision or degradation of a named entity
  (a graph, an attempt, a service, a hook, a memory entry) and an operator would
  want to find it by code — `rolebox logs --code …`, a UI filter, a `jq` recipe;
* the same fact is emitted from more than one place, or is expected to recur
  across runs, so a rewording at one call site would silently fork it;
* the level or the channel should be a property of the diagnostic rather than of
  the module that happens to emit it;
* a loop or a hot path can emit it, and it should be countably throttled
  (`throttleMs` is a table property, not a call-site decision).

Keep a level helper when the sentence is genuinely local: a free-text message
about this call, with no stable code anyone would query, that is not a
recognisable state of a named entity. Both shapes are correct — the mistake is
promoting every `log.warn` into a code table entry, which is churn, or leaving a
recurring engine decision as free text, which is invisible to every filter.

The vocabulary is **append-only in practice**: a code that ships is part of the
operator's query surface, so renaming or deleting one is a breaking change for a
recipe someone wrote down.

## Channels

A channel names the **source** — the module or subsystem that emits the record —
never the prefix of an event code and never the severity.

* An event's channel comes from its registry entry, so one module may emit into
  the channel the event belongs to.
* A level helper's channel comes from `createLogger(channel)` (or, through the
  compatibility shell, from `createSubLogger(name)`), and the name is used
  verbatim in the record.

Conventions:

* `"<area>"` for a module that is one source: `plugin-core`, `handler-drain`,
  `dispatch-service`.
* `"<area><separator><part>"` when a subsystem has genuinely different sources
  with their own files and level overrides: `graph:host`, `graph:index`,
  `memory:store`, `hook:custom-registry`, `loop/coordinator`, `task:tools`. The
  separator (`:` or `/`) is a naming choice, not syntax — the whole name is used
  verbatim in the record, and only the file name is sanitised.
* The file name is the channel's name with every character that is not a letter
  or a digit replaced by `-`: `graph:host` writes `graph-host.log` (see
  `logChannelFileName` in `src/log/sinks/file.ts`).
* A channel's level override key is the channel upper-cased with the same
  substitution: `graph:host` → `ROLEBOX_LOG_LEVEL_GRAPH_HOST`, `log:compat` →
  `ROLEBOX_LOG_LEVEL_LOG_COMPAT`, `loop/coordinator` →
  `ROLEBOX_LOG_LEVEL_LOOP_COORDINATOR`.
* The root channel is `rolebox` (`DEFAULT_LOG_CHANNEL`), the fallback for a
  logger built without a usable name.

Pick the narrowest name that is still one source. Two modules that share a
channel share a file and a level override, so a channel is a decision about
blast radius: too broad and the override turns up noise from an unrelated
module; too narrow and an operator has to follow a dozen files for one story.

## Scope and fields

`scope` is **identity**: who and what the work belongs to. `fields` is **data**:
what happened to it. They are separate keys on the record so a query can filter
on the first and a reader can read the second.

| | `scope` | `fields` |
| --- | --- | --- |
| Keys | the closed set in `src/log/types.ts`: `sessionId`, `agent`, `graphId`, `runId`, `nodeId`, `attemptId`, `effectId`, `tool` | whatever the event's comment names: states, reasons, counts, and ids the scope has no key for (`executionId`, `service`, `hook`, `id`) |
| How it is filled | ambiently, by `withLogScope(scope, fn)` around the work | explicitly, at the call site |
| Filtered by | `rolebox logs --graph`, `--session`; the view API's `graph`/`session` | `--text`, and whatever a `jq` recipe reads |
| Rendered as | short labels in a fixed order (`graphId` → `graph`) | `k=v`, in the caller's order |

Use the scope for identity **that the vocabulary already has a key for**, and
only for the duration of the work it describes. Identity travels with the
callback:

```ts
await withLogScope({ graphId: "g-42", attemptId: "impl#2" }, async () => {
  await advance();                    // every record raised here carries both ids
});
```

`AsyncLocalStorage` propagates through continuations **created inside** the
callback. A callback created outside it — a boot-time `setInterval`, a
process-level listener — sees no scope at all, so a detached entry point must
re-enter explicitly with `withLogScope` before it reports. The full rule, with
correct and incorrect examples, is the module comment on `src/log/context.ts`.

## Privacy

The hard rule is the field type: `LogFieldValue` admits a string, a number, a
boolean or a uniform array of them. **Fields carry ids, states, reasons and
counts — never a payload, an accepted result, a credential, or a raw platform
error body.**

* A message states one durable fact in one sentence; it does not quote a
  request, a response or a file's contents.
* An error is reported by its name and one bounded line (`error`, and `detail`
  where an entry declares it). The raw body of a remote error is not a
  diagnostic — it is the thing that carries whatever the payload carried.
* `src/log/redact.ts` is the **last** line, not the first: it withholds the value
  of a field whose key *contains* a sensitive term (`credential`, `token`,
  `secret`, `password`/`passwd`, `apikey`, `authorization`, `cookie`, `bearer`),
  after
  folding case and stripping separators. It deliberately over-redacts
  (`tokenCount` is withheld) rather than under-redact, and it never looks at
  values, so an id like `executionId` survives.
* The value that made the field type say no does **not** get logged by whatever
  reports the refusal. `log.field.narrowed` (below) is the worked example: it
  carries the key names, never the values.

If you find a payload, a credential or an accepted result in a log record, that
is a call-site bug, not a pipeline feature: the type should have refused it, and
the redaction pass is not a substitute for not passing it.

## Adding an event

1. **Append the entry to its channel's section** in `LOG_EVENTS`
   (`src/log/registry.ts`), never to another channel's block. A new channel gets
   its own `// ── <channel> — <what it is> ──` section.
2. **The level is the call site's level.** A migration moves the sentence into
   the table; it does not change how loud the diagnostic is.
3. **Write the message as the durable fact**, in one sentence, third person, no
   ids and no formatting: the record carries the ids. A message is not a
   template — the fields are not interpolated into it.
4. **Document the fields in the entry's own comment**, with a `Scope:` line and
   a `Fields:` line, plus a `Caller:` line naming the file and function. A call
   site can then be checked against the entry instead of guessed at.
5. **Add `throttleMs` only when repeats are expected** — a hot path, a per-record
   diagnostic. The window is per `(record channel, code)`; the first occurrence
   opens it, later ones are counted, and the count rides on the next emitted
   record as its `suppressed` field. Entries without `throttleMs` are never
   suppressed. **A first-failure event never opts in** unless it also declares
   **`throttleBy`**, the FIELD whose string value is the subject the window is
   keyed by: with the subject in the key, each different subject keeps its own
   first report and only an exact repeat about the same subject is collapsed, so
   a suppression cannot hide the first report about something else. `throttleBy`
   must name a field the entry's callers pass (a misspelling degrades to the
   empty subject, i.e. one window per channel and code — the very cross-subject
   suppression the subject exists to prevent), which is why the name is checked
   against the entry's own call sites. The rule, the measured windows, the
   subject of each one and the count behind each one are in
   [logging.md](logging.md#throttling), and `tests/log/throttle-policy.test.ts`
   pins the set, the rule and every `throttleBy` name.
6. **Emit it** with `logEvent(code, fields)` from `src/log/index.ts`, or
   `createLogger(channel).event(code, fields)` when the module already holds a
   logger. `event()` ignores the logger's own channel on purpose: the registry
   entry owns the channel.

A code is typed: `LogEventCode` is derived from the table, so a code that is not
registered does not compile. A JavaScript caller that bypasses the types is
counted and reported by the `log.event.unknown-code` entry instead of being
silently ignored — on a record that NAMES the dropped code (the field its window
is keyed by) and carries the running total, so three different drifted codes in
one minute are three reports rather than one.

```sh
# The vocabulary, in table order — the table is the authority, so no page copies it.
grep -n '^  "' src/log/registry.ts
```

## Adding a sink

A sink is a function that receives a frozen `LogRecord` and returns `void`. From
a module under `src/`, the public face of the platform is one import:

```ts
import { configureLogging, type LogRecord, type LogSink } from "./log/index.ts";

const toJsonStdout: LogSink = (record: LogRecord): void => {
  // Never throw: the fan-out contains a throwing sink, but containment loses
  // the record for THIS destination and reports the failure once, which is a
  // worse answer than writing what can be written.
  try {
    process.stdout.write(JSON.stringify(record) + "\n");
  } catch {
    // A sink must not disturb the code it observes.
  }
};

configureLogging({ sinks: [toJsonStdout] });
```

* `configureLogging({ sinks })` **replaces** the destination list. The default is
  console + file + memory (`src/log/index.ts`), so a custom list that replaces it
  owns every destination: include the ones you still want, or accept that the
  record no longer reaches a file.
* Configuration **merges** field by field: a later `configureLogging({ level })`
  keeps the sink list, the log directory and the role.
* The pipeline wraps your list in the isolating fan-out
  (`src/log/sinks/fanout.ts`): each member is called inside its own guard, and a
  member that throws loses only its own copy. The first failure per destination
  is reported through the registered `log.sink.failed` event and **not** repeated
  per record; the file sink's own failures (`log.file.write-failed`,
  `log.file.rotate-failed`) are reported the same way.
* `configureLogging` never throws. An unusable value is ignored and the previous
  configuration stands; a failure while building sinks leaves the live pipeline
  in place.
* A subscriber is a lighter option than a sink: `subscribeLogRecords(listener)`
  delivers every record synchronously as it is produced and returns an
  unsubscribe function. It is served by the **memory sink** — the process's own
  by default, or the one in a custom sink list, so subscribe after configuring.
* Direct `console.*` calls are not a destination choice: the boundary guard
  (below) refuses them outside the console sink and the CLI.

## Files, rotation and retention

The file sink writes one JSON object per line to `<log dir>/<channel>.log`. The
directory is resolved in this order (`src/log/sinks/file.ts`):

1. the directory of the single file named by `ROLEBOX_LOG_FILE` (legacy mode: one
   file for every channel);
2. an explicit directory — `configureLogging({ logDir })`
   (`configureLogDirectory(workspace)` in the compatibility shell maps a
   workspace root to `<workspace>/.rolebox/logs`);
3. `ROLEBOX_LOG_DIR`;
4. the workspace's `.rolebox/logs` — the nearest ancestor of the working
   directory that holds a `.rolebox` directory;
5. `<config dir>/logs`;
6. `<tmpdir>/rolebox-logs`.

The directory is created lazily on the first write, so a process that never logs
opens nothing.

**Rotation** happens before a line is appended, and the size it compares is read
from the file itself, not counted per process: at `ROLEBOX_LOG_MAX_BYTES`
(default 10 MB) the file becomes `.1`, `.1` becomes `.2`, and only
`ROLEBOX_LOG_RETAIN` rotated copies (default 3) are kept — a retain of `0`
removes the file instead of keeping a copy. Both halves of that matter under
concurrency, and both were measured: a per-process byte count lets N writers run
one shared file to N × the limit before anybody rotates (three writers at a 1 KB
limit: a 2316-byte live file, 2.3×), and appending into the file while another
process renames it adds every record written during the shift to the copy being
made (three writers appending back to back at a 2 KB limit: an 8431-byte copy,
4.1×). The gate therefore stats the file before every record — about 1 µs against
an 18 µs append — and a writer that finds another process rotating waits for it
while it keeps making progress (below), before appending to whatever file the
path names afterwards. Writes are synchronous appends
(`appendFileSync`): no open stream, no flush on exit, no drain handling, and a
process that logs three lines does not hold a file descriptor. That is a
measured decision rather than a standing gap — [What one write costs,
measured](#what-one-write-costs-measured) — so there is no write queue today and
no write-side dropped-record counter to report; the losses this pipeline does
count are the throttle's `suppressed` field (per subject), the unknown-code
counter behind `log.event.unknown-code` (reported per dropped code as `count`),
and the reader's `skippedLines`. The retention and
rotation boundaries are the file sink's own tests.

**Rotation is serialized across processes by a per-file lock, because the
uncoordinated version loses records.** The shift is a chain of atomic renames,
but `rename(path, path + ".1")` REPLACES an existing `.1`: a second process that
decided to rotate a moment before the first one finished overwrites the copy the
first just made, and the records in that copy are gone. Three real processes
writing one channel through this sink
(`bun scripts/log-multiprocess-probe.ts`, 3 × 400 records, 4 KB limit, retention
far above the volume so retention cannot be the cause) lost **70 of 1200**
records that way, and a replay lost 143 — always a prefix of each writer, exactly
the records the first rotation had moved aside. The sink therefore creates
`<path>.rotate.lock` with `O_EXCL` before rotating, re-reads the file's size once
it holds the lock (the holder that just left may have rotated already), and never
queues a second rotation behind a live one. A lock older than
`ROTATE_LOCK_STALE_MS` (10 s) is broken rather than blocking rotation forever.
**The wait follows the holder's progress, not a stopwatch**, and that is what
keeps the copy bound when a rotation is slow: the holder refreshes its lock's
mtime at least every `ROTATE_HEARTBEAT_MS` (5 ms) while it scans slots and
shifts copies, and a writer keeps waiting while that mtime is younger than
`ROTATE_WAIT_MS` (25 ms) — five missed heartbeats. The waiter then checks the
lock owner's PID: a live owner may be descheduled, so it is waited out until
the lock disappears or reaches the 10 s stale-lock limit. A dead or
demonstrably dead owner releases the writer. The give-up is remembered per lock *stamp*
(inode + mtime), so the holder's next refresh, or a replaced lock file, arms the
wait again; it used to be a permanent per-process flag, and that one difference
let a single slow rotation turn a process into a writer that appended into every
later file mid-rename — rotated copies reached 40× the limit.
The shift itself starts at the copies that exist instead of at slot `retain`:
walking 4096 empty slots cost 8–13 ms per rotation on a 40-copy file (0.34 ms at
the default retain of 3), and those milliseconds are exactly the window in which
other writers would otherwise append into the copy being made.
The lock file is not a log file: the read side's name grammar is
`<channel>.log` plus `.N`, so `listLogFiles`, a query and `prune` never see it.
The probe above is now the regression test's engine
(`tests/log/multiprocess.test.ts`), and after the fix it delivers every record
exactly once with no torn line and no duplicate — with the worst rotated copy at
1.010–1.204× the limit across the configurations measured since: a 32 KB limit
with a 6-copy ladder on a 2 ms cadence, 1.010×; a 2 KB limit with `RETAIN` 4096
on a 2 ms cadence, 1.031×; the same with writers back to back, 1.204× (+418 B);
the probe's default 4 KB limit, 1.128× (+524 B).

**What that bound is, and what it is not.** The gate is a check followed by an
append, so a record that passes the gate an instant before another process
rotates still lands in the copy being made: the bound is the limit **plus one
record per concurrent writer**, which is why the numbers above carry the bytes
they overshoot by and not just a fraction (about +0.5× at a 1 KB limit with
~280-byte records). The other residual is a holder that has *stopped* progressing
for a whole `ROTATE_WAIT_MS` and whose owner is demonstrably dead: the
waiter appends — one stalled record per stalled lock instance, not one per record.
A live owner is waited out up to `ROTATE_LOCK_STALE_MS`, which breaks a stale lock
and resumes rotation. Measured
on the deep-ladder load that broke the stopwatch version (three real processes,
one channel, a 1 KB limit, `RETAIN` 4096, writers back to back): the worst
rotated copy fell from **27.6×** the limit (28,300 B) to **1.58–1.70×**
(1,617–1,737 B) with 1,800 of 1,800 records delivered exactly once. A factor
check on its own is therefore not load-independent: the probe's `rotation-bound`
now compares `maxRotatedBytes` against the limit plus one MEASURED record per
concurrent writer (never below 512 B each) and reports the overshoot and the
factor beside it, so a configuration whose records are a large fraction of the
limit (1 KB limit, ~280 B records, three writers) no longer sits above a factor
while losing nothing — the load-independent statement is the limit plus the
allowance, and `tests/log/multiprocess.test.ts` asserts the same byte bound
independently, so a regression has to defeat both numbers.

The operator view of all of this — where the files are, what to grep, how to
prune rotated copies — is [logging.md](logging.md#where-the-files-are).

## What one write costs, measured

The file sink is synchronous on purpose (above), and stage 5 measured it before
deciding whether that should change. The answer is that it should not: a scratch
harness (`.rolebox/tmp/bench-write-path*.ts`, throwaway) puts one representative
record — 267 to 295 bytes, 19,800 to 99,500 samples per case,
`performance.now()` around every call, every case in a temporary directory — at
**0.03 ms at p99**, of which the append itself is 93%. The per-record rows — the
sink alone and the runtime with its gate open — re-ran in the same range on the
tree as it stands (29,700–30,000 calls: p50 0.018–0.019 ms, p99 0.033–0.036
ms); the rotation row is that re-run's figure, because the cross-process
rotation lock (above) is charged to the crossing record.

| Case | n | p50 | p99 | p99.9 | max |
| --- | --- | --- | --- | --- | --- |
| one record straight into the file sink | 99,500 ×3 | 0.018–0.020 ms | 0.034–0.039 ms | 0.051–0.070 ms | 1.4–3.9 ms |
| one record through the runtime, file sink | 30,000 | 0.019 ms | 0.036 ms | 0.046 ms | 1.09 ms |
| one record through the runtime, memory sink | 30,000 | 0.0004 ms | 0.003 ms | 0.016 ms | 0.05 ms |
| the record that crosses the rotation limit | 300 | 0.32 ms | 0.47 ms | — | 0.55 ms |

* **Burst.** 10,000 records back to back cost 179–206 ms straight into the sink
  (19–20 µs each) and 192 ms through the runtime (re-measured on the repaired
  sink: 185.6 ms and 206.7 ms): the per-call cost times the count rather than an
  added stall, and because the append is synchronous that time is the calling
  thread's — a caller that emits 10,000 records in one loop spends those
  ~200 ms inside the sink before it continues. The same 10,000 through the
  memory sink cost 5 ms,
  so attaching the file sink costs about 0.017 ms per record more than memory
  alone.
* **Where the time goes.** `appendFileSync` 18.0 µs, the gate's `statSync` ~1.1 µs
  (it reads the file's real size on every record — see above), `JSON.stringify`
  0.9 µs, `Buffer.byteLength` 0.02 µs, the sink's own bookkeeping the rest.
* **Tail.** Per 100,000 records, 3–12 single calls exceeded 0.5 ms and 0–6
  exceeded 2 ms; the worst observed call was 3.9 ms, still inside a 60 Hz frame.
  Rotation is cheap: the record that crosses the limit pays 0.32 ms (0.47 ms at
  p99) and the two crossing records a 100,000-record file sees at the 10 MB
  default cost at most 0.29 ms.
* **What the rotation lock added.** The crossing record cost 0.20 ms before the
  lock and 0.32 ms after it (+0.12 ms mean): one `O_EXCL` create, one small write
  and one unlink, all on the rotation path only. The lock is still not consulted
  until the size check trips, and the size check itself is one `statSync` per
  record: re-measured after the gate began reading the file's size, an ordinary
  record costs 0.022 ms mean and 0.042 ms p99 over 20,000 calls (0.0195/0.033
  before it), about 12× under the 0.5 ms budget. The repair round that made the
  wait progress-driven re-ran the same harness on the repaired sink — 29,700
  calls, p50 0.0185, p99 0.0351 ms, worst 0.94 ms; the crossing record 0.316 ms
  mean / 0.466 ms p99; a 10,000-record burst 185.6 ms — so the heartbeat and the
  per-stamp give-up left the per-record cost where it was. A record that arrives while
  another process holds the lock waits for that rotation for as long as it is
  progressing (`ROTATE_WAIT_MS` is the no-progress window, not a deadline) — the
  one case where a record pays a rotation it did not cause, and it is the same
  rotation the lock holder is paying. What it pays is that rotation's own
  duration: ~0.3 ms at the default `RETAIN` 3, tens of milliseconds on the
  deliberately deep ladders the probe uses. One rotation
  per 10 MB file — roughly 39,000 records at this size — at 0.32 ms is not the
  kind of stall the revisit trigger below is about.

The 10,000-record burst is volume, not latency, and it only appears when an
operator turns a channel to `debug`. Asynchronous writing would buy that volume
back at the price of a bounded queue that drops exactly the records `debug` was
enabled to capture, a flush-on-exit contract (signal handlers the process does
not install today), and the read-after-write visibility that `rolebox logs`, the
TUI pane and the read side's tests are built on. At 0.03 ms p99 that trade is
not worth making, so the sink stays a synchronous append.

**When to revisit.** The trigger is the measurement, not taste: if p99 per
record crosses 0.5 ms, or single calls start stalling for tens of milliseconds
(a slow or networked file system), the next step is the bounded queue with a
batched flush, a registered `log.sink.backpressure-dropped` event carrying the
channel and the dropped count, and a flush on exit.

## Reading it back: sources and cursors

`src/log/read.ts` is the read side of the same files, and `src/log/view.ts` adds
the piece the live surfaces need.

**The source.** `resolveLogSource` decides where a read looks, and an explicit
argument wins over the environment: `logFile` (that one file and its rotated
copies — the CLI has no flag for it, so only an embedder passes one), then
`logDir` (exactly that directory — the legacy `ROLEBOX_LOG_FILE` is not
consulted), then the writer's own chain. This is why `rolebox logs --log-dir <D>` reads, lists and
prunes exactly `<D>`, and why the write side keeps the opposite precedence
(one process, one file).

**What a read tolerates.** The files are shared with other processes, other
versions and a human with an editor, so a line that is not JSON, or JSON that is
not a record, is counted (`skippedLines`) and skipped, never thrown. A record
missing a key is normalised to the writer's default for it, and unknown extra
keys are ignored. A missing directory answers an empty result.

**The follower's offset ledger is keyed by file IDENTITY, and the identity is
read from the open descriptor.** `followLogRecords` polls instead of watching,
which means every poll re-lists the files — and under a concurrent rotation the
listing and the read are two different moments. Both halves of that rule were
measured wrong first: the probe's live `rolebox logs --follow` process delivered
**157 of 1200 records twice** in one run, because the ledger was rebuilt from
each poll's listing and a file the rotation had renamed between the listing and
the read was forgotten (and then replayed from its beginning when it reappeared
under its new name). The ledger is now `(device, inode) → bytes delivered`, kept
across polls and capped at `MAX_FOLLOW_IDENTITIES`, and every file is opened
BEFORE it is asked who it is (`fstat` on the descriptor), so the offset and the
bytes always belong to the same inode. `tests/log/read.test.ts` pins the
one-poll disappearance directly, and the probe checks the live process end to
end.

**A poll is several passes, because one walk cannot see a moving ladder.** The
listing puts the oldest copy first, while a rotation renames every copy UP one
name: a file can move to a name the walk has already passed, so a single pass
misses it — and delivering the next poll then puts that file's records after ones
written into the fresh active file (the probe caught exactly that: seq 394-399
delivered, then 325-330 of the same writer). A poll therefore re-lists and reads
until a pass finds no unread byte, up to `MAX_FOLLOW_PASSES` (6); the carried
offsets make a repeated pass free of duplicates, since a file read to its end
answers no lines. Measured over ten stress runs (three writers back to back, a
2 KB limit, ~29 rotations per run): no record lost, none duplicated, and the
share of records that arrived out of `time` order fell from a 17% late block to
zero in nine runs and 2.5% in the tenth. The remaining case is a rotation that
lands inside the last pass's window — a tail that polls cannot snapshot a
directory that is being renamed under it, and this is where the honest bound
is.

**The cursor.** `readLogView(query)` answers a window of records plus a `cursor`:
`"<epoch-millis, padded>.<millis>~<how many records share that millisecond>"`.
It is a **watermark**, not a record id, and it is **opaque** — a caller stores
the string and hands it back unchanged; it is never composed by hand. The cursor
sits on the boundary of a timestamp group, which is what lets the next call
answer "strictly after this" without repeating or skipping a record.

What it promises, and what it does not (the full contract is the module comment
on `src/log/view.ts`):

* **on one append-only source, a drained walk is lossless and repeat-free** — a
  record delivered once is never delivered again, and a record appended after the
  watermark is delivered by the next poll;
* **rotation and `prune` can lose a window** that was written after a cursor and
  never delivered: once a rotated copy falls out of retention it is gone from
  every future scan, so a viewer shows a gap. A cursor cannot promise a gap-free
  stream through history that no longer exists, and the view does not pretend to;
* **a late record is behind the cursor**: records are ordered by `time`, so a
  writer with a skewed clock, a backfill, or a second record inside an
  already-read millisecond lands where a delivered record was and is not
  re-delivered. No repeats and late arrivals cannot both hold, and a live view
  needs the first one;
* **an absent cursor means "the newest stretch, as of now"** — the last `limit`
  records, with `truncated` saying whether older records exist behind them.

Both live surfaces — the TUI's Logs pane and the dsh web panel — hold exactly
one cursor string between polls and hand it back unchanged, which is why neither
has to re-read the files and neither repeats a row.

## The boundary guard

`scripts/check-logging-boundaries.ts` asks one question of every source file:
does it reach console bytes, or the retired logging package, without going
through the pipeline? Two rules:

1. **no `tslog` import** — in `src/**` and in `tests/**`. A comment that mentions
   tslog is fine; the guard reads import specifiers.
2. **no direct `console.*` call in `src/**`** — with two standing exceptions and a
   whitelist:
   * `src/log/sinks/console.ts`, the platform's own console destination — the one
     place a record becomes console bytes;
   * `src/cli/**`, whose output is a product interface rather than a diagnostic
     log;
   * `CONSOLE_WHITELIST` in the guard, one entry per file that cannot use the
     pipeline at all. The entry carries the **reason**, the guard's test fails an
     entry without one (or with a path that does not exist), and the reason is
     published in the guard's JSON report so an exemption can never be silent.
     Today there is exactly one: `src/platform/adapters/dsh/web-ui/client.ts`,
     the dsh web client bundle, where the kernel cannot load
     (`src/log/context.ts` pulls `node:async_hooks`, stubbed to an empty module
     under Bun's browser target).

`tests/**` is deliberately out of scope for rule 2 — a capture test replaces
console itself, which is scaffolding, not a diagnostic channel.

```sh
bun run scripts/check-logging-boundaries.ts               # this workspace
bun run scripts/check-logging-boundaries.ts --root <dir>  # a fixture tree
```

It prints its machine-readable report on stdout, lists the same violations on
stderr as `path:line  [rule] detail`, and exits 1 when there is one. A console
**assignment** (`console.warn = …`, the capture pattern) is not a call and is not
reported.

## The compatibility layer

`src/logger.ts` is what ~170 modules import — `createSubLogger("dispatch")`,
`formatError(err)`, `getRootLogger().attachTransport(fn)`. It is a thin,
permanent translation layer over `src/log/**`, and it exists because those call
sites did not have to change when tslog left the dependency table.

| Legacy surface | What it does now |
| --- | --- |
| `createSubLogger(name, minLevel?)` | a logger whose channel is `name`, over the kernel's `createLogger(name)`; `minLevel` adds a gate in front of the kernel's |
| `getRootLogger()` / `rootLogger` | the same logger on the root channel `rolebox` |
| `debug/info/warn/error/fatal` | the kernel's five levels |
| `silly` / `trace` | recorded as `debug` with an `alias` field |
| `attachTransport(fn)` | `subscribeLogRecords`, adapted to the tslog-shaped entry `{ "0": message, "1": fields, level, channel }` |
| `formatError(err)` | unchanged: `{ message, stack?, name? }` |
| `configureLogDirectory(workspace)` | `configureLogging({ logDir })` on `<workspace>/.rolebox/logs` |
| `getLogFilePath(channel?)` | the kernel's resolved file for that channel |
| `__resetForTest()` | `__resetLoggingForTest()` |

**Narrowing is reported, not silent.** The kernel's field type is narrower than
what a legacy call site may pass: a further argument is adapted into named
fields, and a value the type does not admit — an object, a nested array, a mixed
array, a function — has that **key** dropped from the record. The mapping is
unchanged (an Error-shaped value still becomes the reason, a scalar still lands
under `arg1`, `arg2`, …); what is new is that the drop is visible. The shell emits
the registered `log.field.narrowed` event, carrying:

* `channel` — the channel the call site logged on, so the file to grep is known;
* `keys` — the dropped key names, in call order, de-duplicated (an argument that
  cannot become a field is named by the positional key it would have had).

It never carries the value, which is precisely what could not be recorded. The
entry is registered on the channel `log:compat` (the source is the shell) at
`debug`, throttled over a window of 60 s keyed by the CALLER channel
(`throttleBy: "channel"`, the record's own `channel` field) — the registry
channel is the single `log:compat`, so a window keyed by it alone would be one
window for the whole process and the second call site to narrow would lose its
first report — with the suppressed count riding on that caller channel's next
report as `suppressed`.

That makes the call sites which still need migrating findable without reading 170
files: the writer has to record the event first (it is a debug record, and the
default global level is `info`), then the reader can list it.

```sh
ROLEBOX_LOG_LEVEL_LOG_COMPAT=debug rolebox monitor   # the writer records them
rolebox logs --channel log:compat --level debug      # the reader lists them
```

```text
[debug] log:compat log.field.narrowed channel="probe:caller" keys="entity" — a field value the kernel's field type does not admit was dropped from the record
```

**Migration direction.** New code imports `src/log/index.ts` and uses
`createLogger(channel)` plus `logEvent(code, fields)`; the compatibility shell
exists for the call sites that have not been touched, not as the target. When you
touch an old call site anyway, promote the diagnostics that report a named
entity's state, decision or degradation to a registered event (the entry in
`src/log/registry.ts` owns the level, the channel and the sentence), and leave
the genuinely local one-off sentences as level helpers. Do not widen the shell's
field type to make a call site compile, and do not rewrite 800 call sites for
their own sake: they already flow through this pipeline with a channel derived
from `createSubLogger(name)`.

## Checks to run after touching the pipeline

```sh
bun run typecheck                                  # the vocabulary is typed; a bad code fails here
bun run scripts/check-logging-boundaries.ts        # exit 0, or the violation names file:line
bun test --isolate tests/log/                      # the kernel's own suite (includes the probe)
bun test --isolate tests/logger.test.ts            # the compatibility shell's contract
bun test tests/tui/                                # the Logs pane (no --isolate: @opentui/core)
```

Two probes answer questions a unit test cannot, and both are re-runnable:

```sh
# Three real processes writing one channel, plus a live `rolebox logs --follow`:
# exactly-once, no torn line, rotation, merged order, follower order.
bun scripts/log-multiprocess-probe.ts --records 400 --max-bytes 4096 --retain 4096

# Which registered events flood a log directory, and what a throttle window would
# cost: the evidence behind every `throttleMs` in the registry.
bun scripts/log-event-density.ts --dir .rolebox/logs
```

The whole `bun test` suite is CI's job; see `AGENTS.md` for the module-scoped
slices.
