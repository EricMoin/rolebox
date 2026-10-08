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
   `throttleMs`;
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
   suppressed.
6. **Emit it** with `logEvent(code, fields)` from `src/log/index.ts`, or
   `createLogger(channel).event(code, fields)` when the module already holds a
   logger. `event()` ignores the logger's own channel on purpose: the registry
   entry owns the channel.

A code is typed: `LogEventCode` is derived from the table, so a code that is not
registered does not compile. A JavaScript caller that bypasses the types is
counted and reported by the `log.event.unknown-code` entry instead of being
silently ignored.

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

**Rotation** happens before a line is appended: at `ROLEBOX_LOG_MAX_BYTES`
(default 10 MB) the file becomes `.1`, `.1` becomes `.2`, and only
`ROLEBOX_LOG_RETAIN` rotated copies (default 3) are kept — a retain of `0`
removes the file instead of keeping a copy. Writes are synchronous appends
(`appendFileSync`): no open stream, no flush on exit, no drain handling, and a
process that logs three lines does not hold a file descriptor. Asynchronous
writing and backpressure are a later hardening stage, and the
retention/rotation boundaries are the file sink's own tests.

The operator view of all of this — where the files are, what to grep, how to
prune rotated copies — is [logging.md](logging.md#where-the-files-are).

## Reading it back: sources and cursors

`src/log/read.ts` is the read side of the same files, and `src/log/view.ts` adds
the piece the live surfaces need.

**The source.** `resolveLogSource` decides where a read looks, and the explicit
argument wins: `logDir` (exactly that directory — the legacy `ROLEBOX_LOG_FILE`
is not consulted), then `logFile` (that file and its rotated copies), then the
writer's own chain. This is why `rolebox logs --log-dir <D>` reads, lists and
prunes exactly `<D>`, and why the write side keeps the opposite precedence
(one process, one file).

**What a read tolerates.** The files are shared with other processes, other
versions and a human with an editor, so a line that is not JSON, or JSON that is
not a record, is counted (`skippedLines`) and skipped, never thrown. A record
missing a key is normalised to the writer's default for it, and unknown extra
keys are ignored. A missing directory answers an empty result.

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
`debug`, throttled over a window of 60 s per `(record channel, code)` — here, the
single `log:compat` — with the suppressed count riding on the next report as
`suppressed`.

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
bun test --isolate tests/log/                      # the kernel's own suite
bun test --isolate tests/logger.test.ts            # the compatibility shell's contract
bun test tests/tui/                                # the Logs pane (no --isolate: @opentui/core)
```

The whole `bun test` suite is CI's job; see `AGENTS.md` for the module-scoped
slices.
