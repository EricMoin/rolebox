# Changelog

## Unreleased

### Breaking Changes

- **The CLI and development infrastructure now require Node.js 26.4+ and npm.** Builds use esbuild, tests use Vitest with isolated Node workers, and CI installs from `package-lock.json`. The OpenTUI sidebar requires Node's `--experimental-ffi` flag. See [Node runtime and development](docs/node-runtime.md).

### Features

- **A 23-tool `browse_*` family operates web pages through element refs instead of screen coordinates** — `browse_status`, `browse_open`, `browse_snapshot`, `browse_read`, `browse_click`, `browse_drag`, `browse_type`, `browse_press`, `browse_select`, `browse_hover`, `browse_scroll`, `browse_wait`, `browse_eval`, `browse_screenshot`, `browse_upload`, `browse_downloads`, `browse_dialog`, `browse_tabs`, `browse_history`, `browse_console`, `browse_network`, `browse_cookies` and `browse_close` drive a local Playwright browser whose page is read as an ARIA-shaped tree and acted on through refs printed by the latest snapshot, with `browse_read` returning page content and `browse_screenshot`/`browse_downloads` writing under `.rolebox/browse`. The family is a separate surface from `computer_*`, which remains the coordinate tool for the native desktop. Playwright is an optional peer that must resolve from the rolebox install (`npm install playwright`, then `npx playwright install chromium`), so registration is its own fail-closed gate: `browseUse` resolves from a host plugin option, `~/.config/rolebox/config.yaml` or `.rolebox/config.json`; any explicit `false` or invalid/unreadable setting disables the family, an explicit `true` registers it even without the driver so `browse_status` reports the gap, and with no setting it is on exactly when `playwright` resolves. DSH, Pi and Codex register it when the gate is on (DSH additionally requires its tool-guard seam); neither OpenCode entry registers it and instead materializes explicit per-role denials. A role's `tools:` map can deny a tool or a prefix with exact-over-wildcard precedence, and a declared graph node grants them through its `tools` array. Refs are per page, replaced by each snapshot and dropped by navigation, and a stale ref fails before any driver call. Pointer gestures use the browser's real input pipeline: `browse_click` takes a point inside the element, a triple click, a hold delay and repeated clicks; `browse_drag` presses on one element and releases on another, with positions inside either and interpolated steps; `browse_hover` takes a point, modifiers and a hold time; and `browse_scroll` wheels at a chosen element or with modifiers, or jumps the document to an edge. The family's tests run against an in-memory driver; the real-browser smoke test is skipped unless `ROLEBOX_BROWSE_LIVE=1`, so no live-browser run is claimed here. Reference: [docs/browser-use.md](docs/browser-use.md).

- **A compacted dsh session keeps an agent-curated focus entry instead of the compaction summary** — dsh replaces older surface history with one model-written summary when a request approaches the window (the same engine behind `/compact`). That summary is conversation content: rolebox never stores it, and it never reaches the memory database or the prompt. Instead each session keeps ONE rolling memory entry the agent writes and updates — title `Session focus — <session short>`, tags `session-focus`, category `note`, relevance `high`, scope `role` when a role is active and `workspace` otherwise — whose content is the current goal, key facts and decisions, constraints and preferences, what needs attention now and open threads. A bounded `## Session focus` system-prompt block injects the entry's current content and names its id and the real `memory_update` tool; when a compaction is newer than the entry it asks the agent to refresh it before continuing, and with no entry yet it gives the exact `memory_write` recipe (urgent right after a compaction, a standing convention otherwise). The block is rendered by rolebox from the session log and the store, so it survives a restart and display needs no `memory_read`; create and update remain gated on an authorized and registered `memory_write` / `memory_update`, `memory.session_focus: false` opts a role out, DSH graph workers are skipped, every failure is fail-soft, and no memory is written automatically. Reference: [docs/memory.md](docs/memory.md#session-focus-across-compaction-dsh).

- **DSH retrieves project memory from the prompt being worked on, and Chinese search finds phrases it used to miss** — a session-start memory table goes stale as a session grows, so each DSH turn now assembles one bounded `## Relevant memory` block from the memories that match the **newest user-authored message**: the latest human prompt is taken from the step's admitted user message, with the session log as the fallback (injected runtime context, model selections, compaction checkpoints and rolebox notices are skipped), rewritten into a search query, and the matching entries are injected with their content, not just titles — title, id, scope, relevance and a bounded excerpt, plus an instruction to name an entry (title or id) whenever a retrieved memory changes the answer. The block is capped in entries (three) and code points (3000), cached per session, prompt message id and role, follows the same workspace/role visibility as the tools, names the real `memory_read`/`memory_recall` tool names when the session holds them, is skipped for DSH graph workers, never writes memory and never duplicates the session-focus entry; `memory.recall: false` opts a role out, and every failure renders no block. The memory index also stores the deduplicated two-character bigrams of every Han run beside the original title, content and tags, and a Han query is rewritten to the same bigrams joined with `OR`, because FTS5's `unicode61` tokenizer indexed `记忆机制需要保存关键点` as one token and made `记忆机制` or `压缩` unfindable; this fixes `memory_recall` as well, Latin/number queries are unchanged, and a pre-bigram `memory.db` is migrated in place without losing a row. Reference: [docs/memory.md](docs/memory.md#turn-recall-dsh).

- **A one-shot LLM query scout widens DSH turn recall when the user's own words miss** — the deterministic tier searches memory with the latest human prompt, which is cheap and private but lexical. A new scout can run ONE bounded `llm.stream` call on DSH's async `agent/pre-step` waterfall, asked in a short system instruction for a JSON object of three to six project concepts likely relevant to the prompt, on the step's own provider/model route. The offered queries are merged round-robin with the deterministic hits (deterministic first, then the scout hits, then the next deterministic hit), still bounded, still cached, and applied only to that exact user message. The model returns search terms only — it never sees a memory entry, no memory is written, and the step's messages are never mutated. The call is capped at 3 seconds with a 600-token output cap and fails open: timeout, abort, provider error, invalid JSON or an empty list leaves the deterministic block unchanged. `memory.recall_mode` selects the tier — `auto` (default) scouts only when workspace memory has at least 20 entries AND the deterministic search finds fewer than two, `always` scouts every new prompt, `deterministic` never scouts — and graph-worker and subagent sessions, `recall: false` and `deterministic` roles skip it entirely. Reference: [docs/memory.md](docs/memory.md#turn-recall-dsh).

### Bug Fixes

- **The DSH query scout's deadline now fits a real model call, and a live miss says why** — a real headless E2E across nine `recall_mode: always` turns found every scout returned no usable queries roughly 1.5 seconds after the step began: the 1500 ms hard deadline aborted the stream before the model could emit its JSON list, so `always` contributed nothing on a host whose own turn takes about 4 seconds. The deadline is now 3000 ms and the output cap 600 tokens. A scout that still produces nothing logs one closed, content-free reason — `timeout`, `aborted`, `stream-error`, `empty-stream`, `invalid-json` or `empty-queries` — with the session and prompt keys, never the prompt text, the model output or the queries, so the next live failure is diagnosable. The hard deadline race, fail-open behavior and every gate are unchanged. Reference: [docs/memory.md](docs/memory.md#turn-recall-dsh).

- **DSH turn recall searches the prompt's question instead of its instruction preamble, and the session-focus recipe names the real session** — a real headless E2E found that a long English instruction paragraph ending in a labelled question filled the fixed 24-term search budget with its first words (`this`, `is`, `a`, `controlled`, …), so the entities the question named were never searched: the `## Relevant memory` block could only match generic instruction words, and a Chinese sentinel named only in the question never surfaced at all. The query is now built from the prompt's own task — the text from the last labelled `Question:`/`Q:`/`Task:`/`Request:`/`问题:`/`任务:`/`请求:` line, else a long prompt's final question paragraph, else the whole message — with English function words dropped and Han-script bigrams placed first so a Latin preamble cannot starve a Chinese entity. The query scout grades its deterministic probe and prompts its model with that same extracted question, so the preamble neither makes the search look strong nor biases the proposed concepts. The `memory_recall` tool keeps its raw-FTS contract: a non-Han query is still passed through unchanged, and only a Han-containing query is rewritten — now with its bigrams first, so a mixed query cannot spend the budget on Latin words before the Chinese entity. Separately, the session-focus create recipe title used `sessionId.slice(0, 8)`, which is literally `session-` for every dsh session id, so every recipe asked for the same non-unique title; it now strips the `session-` prefix and uses the first eight characters of the id itself (for example `4b8851fa`), falling back to the raw prefix only when stripping leaves nothing. Reference: [docs/memory.md](docs/memory.md#turn-recall-dsh).

- **DSH turn recall reads the prompt being worked on instead of the previous turn's** — dsh's agent loop claims a step's user message out of the inbox before it appends it to the session log, so a recall that only read the log found no prompt on the first turn and the previous prompt on every later turn. An `agent/pre-step` listener now hands the step's admitted message — its stable message id and text — to the recall provider for the same step's context refresh, and the session log is only the fallback; the listener is registered even when the host exposes no stream-capable llm, because the handoff is independent of the query scout. The scout also resolves its route the way the host does — the step's model selection when the installed host provides one, otherwise the session's last routed request header, otherwise the agent's creation options — instead of requiring a pre-step `modelSelection` the installed host does not send; a host exposing none still gets the prompt handed to recall, with only the scout skipped. Reference: [docs/memory.md](docs/memory.md#turn-recall-dsh).

- **Graph recovery reads current dsh SDK execution descriptors** — Natural completion remains observable after plugin reload, including local continuable sessions. Real SDK acceptance now covers persisted process recovery, node retries and host sandbox enforcement.

- **Interactive prompts work again on Windows** — Upgraded to `@clack/prompts@^1.8.1` so prompt rendering avoids an unwritable stdin handle. Empty validation inputs remain invalid, and target selection, role selection and cancellation were verified in a real PTY.

- **A CLI whose reader disappears exits quietly instead of crashing with a stack trace** — `rolebox list | head`, a terminal window closed mid-command and a detached agent PTY can all take stdout away while the process is still writing. Node.js treats an unhandled `error` event on stdout/stderr, or an unhandled promise rejection, as fatal, so the next write died with `EPIPE: broken pipe, write` and a stack trace. The CLI entry now installs a guard (`src/cli/stdio-guard.ts`) on stdout, stderr and the two fatal process events: an EPIPE clears raw mode and exits with 141 (128 + SIGPIPE) without printing anything — the only remaining destination is the stream that just proved nobody is reading it. Every other failure keeps its diagnosis: uncaught exceptions are observed through `uncaughtExceptionMonitor`, so the runtime still prints its own report (original location included) and the guard only makes sure the process still exits 1; a non-EPIPE rejection is re-rejected after the guard steps aside, so the runtime reports it and exits 1 exactly as it would with no listener. Library entry points never install the guard, so embedding rolebox does not change the host process's own stdio or rejection behavior. Covered by unit tests for both fatal channels plus two cross-process regressions that spawn a real Node child — one closes its stdout reader, one rejects with EPIPE — and assert a clean exit with no crash report.

## 2.0.0

2.0.0 is the first stable release of the 2.x line. The breaking changes an upgrader from 1.x must act on are recorded under `## 2.0.0-alpha.1` and `## 2.0.0-alpha.2`, and are not repeated here.

### Features

- **The desktop computer-use family gains the observation and gesture tools it was missing** — the family shipped screenshot, windows, click, move, type, key and permissions; this completes the twelve-tool surface the documentation now describes with `computer_displays` (each display's screenshot id, absolute screen-coordinate bounds, `scale` and `primary`, which is what makes a capture's screen origin knowable before converting image pixels to input coordinates), `computer_focus` (bring one `computer_windows` id to the foreground and confirm the OS actually focused it, refusing when the id cannot be matched unambiguously), `computer_scroll` (one to a hundred wheel ticks in a named direction, optionally after moving the pointer first), `computer_drag` (a left-button drag between two absolute positions over a bounded duration, with a best-effort mouse-release cleanup when the gesture is interrupted) and `computer_status` (plan every operation and report the platform, helper availability, refusals, the input grant and the screen-capture grant without taking a screenshot or injecting input). On macOS every pointer, text, scroll and drag gesture is now a native Quartz event posted through JXA: `computer_click` sends real left, right and middle mouse events instead of driving System Events plus the external `cliclick` helper, `computer_type` sends Quartz Unicode keyboard events, and `computer_focus` matches the window server's identity to one unambiguous Accessibility window — so `cliclick` is no longer required and its install hint is gone. Every tool also accepts `timeout_ms` (up to two minutes) on top of a queue that serializes operations within the host process, and the live-desktop checks stay opt-in — the native macOS capture tests run only under `ROLEBOX_CUA_NATIVE_TESTS=1`, with a fixture-app smoke runner under `scripts/` — while the rewritten [docs/computer-use.md](docs/computer-use.md) documents the enablement gate, the arguments, the coordinate conversion and the per-platform limits.

- **The dsh Rolebox monitor draws an engine graph as a real node-and-edge figure** — the pane rendered every engine graph as a strip of one small cell per node, which read as a single bar and said nothing about how nodes route to each other. A graph whose `GET /rolebox/status` payload carries its version-3 declaration now renders an orthogonal layered figure: nodes are boxes in rank rows, edges are orthogonal polylines with per-edge ports so two runs can never overlap, rank-skipping edges take a right rail, back edges become a U hairpin below the rank row, declared loop groups are drawn as labelled bands, and an outcome chip appears only where the source declares two or more outcomes or the edge is a back edge. Ranks come from the strongly-connected-component condensation, so a cycle shares one rank and can neither inflate the layout nor make it recurse, and the whole layout is a pure browser-safe function (`layoutGraphTopology`, `src/platform/adapters/dsh/web-ui/graph-topology.ts`) with no DOM, clock or randomness. The figure is a single image with an accessible name and a per-node title, beside a screen-reader-only routing list that states every edge in words; a rank wider than the docked sidebar scrolls inside the canvas instead of being squeezed, and a payload with no declaration nodes keeps the strip as its fallback.

### Bug Fixes

- **A capture now checks the Screen Recording grant, and macOS input no longer breaks on the Accessibility prompt** — `computer_screenshot` captured regardless of permission, so a host without the Screen Recording grant returned a wallpaper-only PNG as if it were a screenshot; the tool now runs the `CGPreflightScreenCaptureAccess` probe first and refuses with the grant to enable, `computer_permissions` and `computer_status` report the same screen-capture verdict beside the input verdict, and a capture larger than the attachment limit is refused with the limit stated instead of being read whole. The macOS probe passed a bare `kAXTrustedCheckOptionPrompt` reference into `AXIsProcessTrustedWithOptions`, which could not present the system dialog; the value is now cast into an Objective-C reference. `computer_screenshot` also refuses a call that names more than one of `window_id`, `region` and `display` instead of silently choosing one, a capture now reports `metadata.origin` and `metadata.coordinate_space` beside `metadata.pixel_scale` (with an explicit warning when a window or display capture's origin is unknown) and the pixel-scale note says to add that origin after dividing, and a command terminated by a signal is reported as such rather than as an exit status. A role's exact `computer_<tool>: false` now overrides the `computer_*: true` wildcard, `computer_permissions` is no longer classified concurrency-safe when it may open an OS dialog, and on Pi a tool context with no `worktree` falls back to its `directory` instead of resolving a capture to a path relative to the process.

- **Rolebox reads dsh's model catalog from the layer that actually holds it** — dsh no longer keeps user settings in `<dsh home>/settings.yaml`: the settings package imports that file once into the active profile and renames it `settings.yaml.imported`, after which the active profile's Cordis patch carries the values. The dsh reader still looked only at the removed file, so it always answered with nothing and the dsh target silently fell back to the opencode seed catalog in the model picker and in the runtime model resolver alike. The reader now scans the home-level `cordis.patch.yml`, then every `profiles/<name>/cordis.patch.yml` in directory-name order, then the legacy `settings.yaml`, with the first occurrence of an id winning so a higher-precedence layer shadows a lower one. Extraction stays structural — a `providers.<route>.models[]` map yields `<route>/<model id>` from its dict key, while any other `models[]` takes its route from the same document's agent-default-model provider or stays a bare id — with no vendor-to-route table and no built-in model list. The `!!js` expressions dsh patch layers allow, which js-yaml's default schema rejects outright (discarding the whole layer and every model in it), are now registered as an opaque value that is parsed but never evaluated, and a model that resolves no provider no longer renders a dangling `Name ()` in the picker. Reference: [docs/model-aliases.md](docs/model-aliases.md#how-resolution-works).

- **The dsh monitor and Logs panes scroll inside the host's tab body** — the host's right Sidebar wraps every tab body in a pane-height clipping box (`height: 100%; overflow: hidden`), so a tab body root must be bounded and scroll inside itself; both rolebox panes were static blocks of natural height (the console measured 5145px and the log view 9629px inside an 855px box), so everything past the first viewport was clipped away and unreachable at any scroll position, and the pane went blank when scrolled. Both roots are now `height: 100%; min-height: 0; overflow-y: auto` with `overscroll-behavior: contain` and `contain: paint`, which also stops a pane's scrollable overflow from propagating into the host's `.paneBody`, where it created a phantom scroll range whose scrollbar dragged the pane out of view. Reference: [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md).

- **Graph workers dispatch again on dsh 0.2.x, which removed the subagent start seam they used** — dsh replaced `SubagentRuntime.start(name, request)` with `startActivation(spec)` and narrowed `SubagentCapabilities` to `agentOptions` / `agentPreset` / `outputSchema` / `depthLimit`, dropping the start-request `toolFilter` and `persona` fields. rolebox still called the removed method, so dispatching a declared graph's node — or a loop round — threw before a worker existed. Every production call site now activates through `startActivation`, and the provider advertises the four booleans dsh actually declares. Because rolebox's provider declares `prepareContinuable`, dsh takes its LOCAL activation path and never calls the provider's own `start()`, so the role prompt, the per-session active-role override, the spawn context and the model override are composed at the call site by `DshAgentRegistrar.composeSpawnRequest` (wired into both the loop dispatch adapter and the graph outcome delivery) and a graph worker's complete prompt is prepended there. The activation's `label` still carries the stable idempotency key and `dispose()` is still the abort surface, and a graph worker's declared tool face is now enforced by rolebox's own execution guard plus the prompt rather than by a start-time filter.

- **rolebox declares the dsh line it needs, so an unsupported host is refused before it loads** — rolebox established every subagent through `startActivation` and advertised the four-boolean capability shape, but `package.json` declared no dsh requirement at all: dsh's pre-flight reads `engines.dsh` first and otherwise only `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` PEER ranges, and rolebox's dsh packages are devDependencies, so every line passed the check and an unsupported one failed later at the dispatch seam. `engines.dsh` now states `>=0.2.1-alpha.3`, the first release whose subagent contract rolebox implements. Verified against dsh's own `evaluatePluginCompatibility`: `0.2.1-alpha.4` and `0.2.1-alpha.3` satisfy it, while `0.2.1-alpha.2`, `0.2.1-alpha.1`, `0.2.0-rc.2` and `0.1.5-rc.2` are refused with dsh's incompatibility message and the `dsh plugin allow-version` exemption path.

### Documentation

- **The README leads with the captures that exist and states only what each one shows** — the README before the rewrite carried the banner and the two demo gifs (`assets/gifs/emperor-dispatch.gif`, `assets/gifs/loop-mode.gif`) and no screenshots; this commit rewrites the prose, deletes the two now-unreferenced gifs and leads with the eight committed screenshots under `assets/screenshots/` — the role picker over the loaded roles, a TypeScript Engineer declaring a graph, the parent reconciling accepted results against a recorded baseline, a one-shot worker settling its node, the monitor pane, the `rolebox monitor` TUI, the roles settings page and the channel-filtered logs — each with a caption stating only what that capture shows. Claims the captures or the source contradict were corrected: the computer-use family is twelve tools rather than seven, the language-server surface is exactly 32 `lsp_*` tools, the graph-declare section no longer asserts an execution budget no capture shows, the settings page is not described as reporting a role's origin, the TUI caption no longer claims a loops or dispatch view, the logs pane filters by channel and session rather than by code, and the upgrade note no longer says persisted legacy state is unreadable — a legacy state body stays readable and is simply never advanced. Reference: [README.md](README.md).

- **README images resolve against the branch the README is read on** — every repository-owned image pointed at `raw.githubusercontent.com/<owner>/<repo>/HEAD/...`, and `HEAD` there is the repository's default branch, so the eight screenshots that exist only on the development branch 404'd wherever the README was read on that branch, while the banner only appeared to work because that one file also exists on the default branch. All nine `src` values are now repository-relative, so each branch's copy of the README renders its own assets. Reference: [README.md](README.md).

- **The published npm README gets images that resolve, without a broken image ever being publishable** — npm stores the bytes of `README.md` as the registry readme and the npm site resolves relative URLs against its own domain, so the repository-relative paths that make GitHub render the branch being read left every screenshot broken on the package page; npm cannot be pointed at a second readme file (`@npmcli/package-json` globs `{README,README.*}` and reads those bytes, and `readmeFilename` is an output field, never an input). `npm publish` now rewrites the nine local image `src` values to commit-pinned raw URLs during `prepack` and restores them in `postpack` (`scripts/npm-readme.ts`); a path that is not present in the commit being packaged refuses the whole rewrite rather than emit a partially pinned README, and the inverse transform is deterministic so `postpack` needs no state from `prepack`. The README on disk stays repository-relative, which is what GitHub needs.

- **The package description and keywords name every supported harness, and the dsh install line can be copied for the web profile** — `package.json`'s description now presents the plugin as one for major harnesses (DeepSeek Harness, OpenCode, Pi and Codex) rather than an unnamed agent plugin, and it gains the discovery keywords `dsh-plugin`, `deepseek-harness`, `dsh-bundle`, `cordis`, `cordis-plugin` and `deepseek-harness-plugin` so the package is found by those searches; the dsh section of the README shows the copy-pasteable `dsh plugin --profile web add rolebox` command beside the generic profile-name example. Reference: [README.md](README.md#dsh).

- **Every harness minimum is stated once, and the README badge row names the binding one** — rolebox's four targets each carry a real version contract, but only dsh's is both hard and non-obvious: the subagent line moved twice inside `0.2.1-alpha`, so `startActivation` and `delivery` appear in `0.2.1-alpha.2` while the four-boolean capability shape rolebox advertises (`agentPreset` in, `toolFilter`/`persona` out) only appears in `0.2.1-alpha.3` — and `0.2.0-rc.x` has neither. `docs/compatibility.md` gains a **Harness versions** section carrying that release table together with the opencode 1.x / v2, Pi and Codex minimums and where each is declared, and the README badge row gains a `dsh 0.2.1-alpha.3+` badge that links to it beside a pointer from the Install section. Reference: [docs/compatibility.md](docs/compatibility.md#harness-versions).

### Tests

- **The live opencode integration tests run only against a v1 CLI** — the real-server tests use the v1 SDK's startup protocol and routes, but the shared helper treated any successful `opencode --version` as usable, so a v2 CLI satisfied the probe and then could not serve that contract. The probe is now version-aware (`isOpencodeV1Version`, [tests/helpers/opencode.ts](tests/helpers/opencode.ts)): a recognized v1 version runs the tests, a recognized incompatible version skips them, and an unrecognized version format — as well as a probe failure, a non-zero probe exit or a probe exceeding its five-second bound — fails explicitly instead of being read as available. Server startup cleanup also tolerates a server that never came up without hiding the original failure.

## 2.0.0-alpha.2

### Breaking Changes

- **Role sources are genuinely multi-source, and the `rolebox registry` command family is complete** — `config.yaml`'s `registries` list used to be the whole story: it was consulted verbatim, so a config that listed only custom sources had no built-in source at all, and an unprefixed `rolebox install <role>` resolved in the default source alone. The built-in source is now always available — an entry that names it keeps its own `url`/`ref`, a file without such an entry gets it prepended, and this effective list is what `search`, `install`, `update`, `uninstall`, `info`, the pickers, `status` and `registry list --json` all resolve through (`src/cli/sources.ts`). Sources are consulted default first and then in config order, an unprefixed `rolebox install <role>` takes the first source that publishes it and warns about any source it could not fetch instead of swallowing the reason, and `rolebox search` notes a role published by several sources together with the `source:role` spec that selects one. `rolebox registry` gains the missing pieces: `add --name` (defaulting to the repo basename), `add --ref` (a branch or tag pinned per source, for both the manifest and the tarball), `add --default` plus the `registry default <name>` subcommand that switches the default, and `list --json`; the built-in source can no longer be removed, and `registries: []` stays the explicit "no sources at all" opt-out. Reference: [docs/cli.md](docs/cli.md#registry-subcommand); source model and resolution order: [docs/registry.md](docs/registry.md#sources).

- **Role sources understand GitLab and plain HTTP file servers, and the kind is read from the URL alone** — a source used to be a GitHub repository, and nothing else could be configured. A source is now one of `github`, `gitlab` or `http`, detected from the URL (`github.com/owner/repo`; a GitLab project, including nested groups and a pasted `/-/tree/…` web URL, with the ref encoded as one path component; a URL that ends in `.yaml`/`.yml` is a manifest served by any static file server). The `--kind` option and the `kind:` config field are gone: a URL that does not identify its backend is refused with the forms that would work instead of being guessed at, and `rolebox registry add` names the same forms. `registry list` marks `(gitlab)`/`(http)` sources, `GITLAB_TOKEN` is sent as `PRIVATE-TOKEN` for GitLab projects, and a generic server publishes `<base>/roles/<role>@<version>.tar.gz` (with a per-role `archive:` override that must stay on the manifest's own origin). Reference: [docs/registry.md](docs/registry.md#source-kinds).

### Features

- **The computer-use family drives the real desktop, off by default behind a host gate and a per-role grant** — seven tools — `computer_screenshot`, `computer_windows`, `computer_click`, `computer_move`, `computer_type`, `computer_key` and `computer_permissions` — synthesize real mouse and keyboard input on the user's live desktop, and every driver is split in two: a pure per-OS plan builder (darwin, linux, win32, plus an unsupported driver that refuses by name) and one thin executor that checks the helper binaries, bounds the run and returns every failure as an `Error:` sentence instead of throwing. The family registers on dsh (only when the host exposes the guard seam that can refuse a `computer_*` call for a role that never granted it), on Pi and on Codex; neither opencode entry registers it, so on opencode a role's `computer_*` grant changes nothing. Registration needs two independent yeses: the global `computerUse` gate — enabled only by an explicit boolean `true` in the host plugin option, in `~/.config/rolebox/config.yaml` or in `{workspace}/.rolebox/config.json`, so a string `"true"` or `1` fails closed and a schema-defaulted host option can never override a user's config-file opt-in — and the per-role grant in `role.yaml`, `computer_screenshot: true` for one tool or `computer_*: true` for the family, where an absent map, a `false` value, an unrelated key and the generic `"*": true` wildcard are all no grant. The gate is applied independently of, and before, `enabledNamespaces`, so a profile declaring `["*"]` cannot turn screen control on even though `"*"` matches the namespace like any other prefix. Image transport follows the host: dsh commits the capture through the host attachment service and sends an image block, Pi converts a base64 data URI into an inline image block, and a surface with no image channel still receives the capture's own text result. `dry_run: true` rehearses the exact command a gesture would run and executes nothing. Reference: [docs/computer-use.md](docs/computer-use.md).

- **A declared graph node can grant its worker extra host tools** — a version-3 node's `tools?: string[]` lists exact host tool names or trailing-star prefixes such as `computer_*`, added beside the worker baseline (`graph_submit_outcome`, plus `graph_worker_exec` on dsh). An absent field keeps exactly the baseline; an empty array, a blank entry or a non-string entry is refused rather than narrowed silently, and a populated list is trimmed, de-duplicated and sorted so two spellings of one grant compare equal. The grant travels as plan provenance: it is compiled into the node's plan body, so the plan revision covers it, and it is resolved per attempt from the persisted, verified plan of the graph the attempt is bound to — never from a caller argument or a process-wide setting. The dispatch request carries it to the delivery, which states it in the worker's prompt and turns it into the per-request `restrict()` allow-list, each declared name matched with the same matcher the per-call boundary uses and intersected with the tools the host actually registered, so a name the host cannot resolve is neither promised to the worker nor allowed to abort the start. The declaration can only narrow: the whole `graph_` namespace stays reserved, so `graph_*` or an exact graph-tool name declared as a host tool admits nothing, and every lookup fails closed — an unbound principal, an unreadable store, an unknown node, a lookup that throws or answers a non-array all leave the worker with the baseline alone. Reference: [docs/computer-use.md](docs/computer-use.md#graph-nodes-the-tools-field).

- **A graph worker is told the workspace its commands run in** — the dispatched worker prompt now states the workspace ahead of the role instructions, and every `graph_worker_exec` result carries the `cwd` the command actually ran in, so a worker reads the directory instead of discovering it with a probe or prefixing each call with a `cd` into the directory it already started in — and can tell the directory it expects from the one the host used. The workspace is a required, validated non-blank absolute path: a blank or relative value is a caller defect, never a fallback to the host process's own working directory, which would silently misreport where the commands run.

### Bug Fixes

- **A role source can no longer reach past the role it was asked for** — a security review of the multi-source work found paths where a hostile or compromised source reached further than the user configured. A redirect off the source's origin no longer carries the GitLab token (redirects are followed by hand so a custom header is not replayed the way the runtime replays it); a manifest-declared `archive:` is confined to the manifest's own origin, so remote data cannot point the download at a loopback, private or link-local address; the manifest fetch has a 30-second timeout and byte caps (8 MiB manifest, 64 MiB archive, 256 MiB extracted) instead of hanging or exhausting memory, and cleanup removes a temporary tree even when the archive made it read-only; the extracted role directory must be a real directory inside the extraction tree, so a symlinked role cannot be installed, and hardlinks whose partner lies outside the tree are refused. Manifest text that reaches a directory name or the terminal is validated and escaped, a manifest can no longer publish a role under a prototype key, and the lock-file integrity digest is a real tree identity (symlinks hashed as links, unreadable entries an error) rather than a hash of whatever happened to be readable.

- **A role installed from one source is no longer mistaken for another source's copy** — the lock-file lookup ignored the source, so a `source:role` spec matched whichever entry happened to come first: `rolebox install other:role` reported "already installed" for a role that source had never provided, and `uninstall`/`info` acted on the wrong copy. Lookups now match role and source (`findInLock(role, registry)` plus `findAllInLock` for the whole set), `uninstall` and `info` refuse to guess when a role is installed from more than one source and name the `source:role` specs that disambiguate, `update` updates every copy and names the source in each success line, and the per-source registry caches are keyed by URL and resolved branch so two sources sharing a name can no longer read each other's cached manifest.

- **`rolebox uninstall` stops unsyncing every other role** — removing a role used to unlink every symlink it found in each sync target (opencode, pi, dsh, codex), so one uninstall silently dropped the deployed links of every other role, and on a target where two sources had installed the same role id, whichever link was there. It now removes exactly the links whose destination is the copy being removed: another role's links, another source's still-installed copy of the same role id, a hand-made link pointing elsewhere and a real directory at a target path are all left alone, while a dangling link that still belongs to the removed copy is cleaned up with it.

- **macOS capture pixels and input points are kept apart** — the macOS driver handed back `screencapture` device pixels as if they were the screen coordinates `computer_click` and `computer_move` accept, so on a 1512x982-point retina display captured as 3024x1964 px a position read off a screenshot landed at twice the intended offset: a silent, already delivered click in the wrong place, with nothing in the result saying the two spaces differ. A capture now reads the PNG's `pHYs` chunk and reports `metadata.pixel_scale`, with one sentence naming the pixel size, the same size in screen coordinates and the division to apply; a file that records no density, records a unit-0 aspect ratio, disagrees between its axes or is not within 1% of a whole scale from 1 to 8 reports nothing instead of a guess. Window captures always pass `-o`, so image pixel (0,0) is the window frame rather than a 3976x2236 px drop shadow around a 1920x1050-point window; `-R` together with `-D` is refused instead of silently dropping the display; Darwin display numbers are documented as 1-based where an X11 screen number and a Windows AllScreens index are 0-based; an untargeted capture covers the main display alone, never a stitched image of every screen; and the remediation sentence every input plan carries now names the Apple Event Automation grant beside Accessibility, because scripting System Events is a separate permission and the first failure on a fresh macOS install is the Apple Event authorization.

- **`computer_windows` reports the real macOS window ids** — the listing read `AXWindowNumber` through System Events, which macOS 26 does not expose at all, so the read failed with -1728 for every window and the fallback printed its `-1` placeholder for all of them; `-1` is not a positive window id, so the documented `computer_windows` → `computer_screenshot({ window_id })` path refused it and could not work at all. The listing is now a JXA script the same `osascript` runs against the window server's own list (`CGWindowListCopyWindowInfo` through the ObjC bridge), and the ids it prints are the real `CGWindowID`s `screencapture -l` accepts; only layer 0 is listed, so the desktop picture, the menu bar, the Dock, minimised windows and windows on other Spaces are not windows a caller can capture or click, the app filter travels as the trailing argument the script reads rather than as script text, and a filter that matches nothing errors naming the filter instead of returning an empty list. The listing no longer touches System Events, so it needs no Accessibility or Automation grant, and its titles are an empty column when macOS withholds them without Screen Recording; input still needs Accessibility and Automation, and captures still need Screen Recording.

- **A join whose feeder set includes a loop back-edge is armed** — a join node counted every in-edge as a feeder, including the continuation back-edge of its own declared loop group, so a node carrying that edge waited for an arrival from a node it had to run before: the join could never be satisfied, the node was never armed, nothing was dispatched for it, and the run still reported `complete` with "All activated graph work completed." The feeder set now excludes a declared group's continuation edge between two of its own members, so both readers of "upstream" agree and the edge stays what it is — a routing fact, not a feeder; `complete` now means every declared node has settled; a run left holding a pending node no advance can arm records the new stop `unreachable-pending-node`, naming each stranded node and the feeder of it that can never arrive, and reports the abandoned work even for a persisted state that already recorded `complete`; and an unsatisfiable declaration is refused at declare time with the named code `unsatisfiable-join` instead of compiling into a run that strands the node.

- **JSON-with-comments parsing no longer glues tokens together or truncates a document** — `parseJsonc` sanitized a document in two passes that deleted comments instead of blanking them, so a comment between two tokens glued them into one value (`{"a": 1/*c*/2}` parsed as `{"a": 12}` with no error at all), and a `//` comment ended only at `\n`, so a document using CR or U+2028 line endings silently lost everything after the comment. Comment stripping is now one length-preserving pass that copies string literals verbatim and blanks every comment one space per UTF-16 code unit, so two tokens can never merge and a reported error position still refers to the original document; a comment now ends at `\n`, `\r`, U+2028 or U+2029, and the trailing-comma lookahead skips a comment only where one really opens, so a comma before a `/`-leading string is no longer dropped. This is the reader behind the opencode configuration documents and the Pi model catalog.

- **A validator version must be a positive safe integer, and an unknown control command is refused** — an outcome acceptance requirement or a validator capability could pin a version such as `-1`, `0`, `1.5`, `2^53` or `NaN`, which compiled into an executable plan that acceptance then rejected: a version is an exact identity, never a range and never rounded. One predicate now reads a version at the declaration reader, the capability check and the plan inspector, so such a declaration is refused by name (`unpinned-validator-version`) instead of compiling, and a capability declaring a version that does not read is refused rather than copied into the plan. A `graph_control` answer is likewise read against the closed command vocabulary and corroborated with the graph the call named, so an out-of-vocabulary command is refused instead of being re-derived and delivered as a cancel intent.

- **A remote graph worker channel serves exactly the delivery tool** — the Pi worker channel advertised and served `graph_status` and `graph_audit` beside `graph_submit_outcome`, and the host authorized a forwarded call solely by that allow-list, so a remote worker holding a channel grant could read the authoritative store and inventory every graph in it while the same worker's in-process call was refused as `worker-tool-forbidden`. The face a worker is handed, the face the channel serves and the face the host enforces are now the single name `graph_submit_outcome`: a forwarded status or audit call takes the channel's existing 403 by name, with no tool body run and no store read, while both readers stay registered for the session that declared the graph.

- **`computer_permissions` reads the real macOS Accessibility trust, and can ask the OS for it** — the macOS probe ran `tell application "System Events" to return UI elements enabled`, which is a global System Events UI-scripting preference and not the calling process's TCC trust, so it answered `true` while the OS was already blocking input; and the verdict was a deny-list, so an empty or unrecognized probe answer was read as GRANTED and the tool reported input as permitted when it was not. The probe is now a JXA script that binds the real API (`ObjC.import('ApplicationServices')`, `AXIsProcessTrusted`) and prints exactly one machine token (`granted` / `not granted`), the verdict is fail-closed (only the exact token, case- and whitespace-insensitive, is a grant, and a probe that cannot be read never reports permission), and the darwin facts declare `readsProbeOutput: true` so a successful exit remains the grant on linux and win32 while darwin's token is validated. A new optional `request` argument makes `computer_permissions` ask the OS for the grant instead of only reporting it: on macOS it runs `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt`, which shows the system Accessibility dialog and registers the application in System Settings, and the result says that the prompt appears once per application and that the host must be restarted before calling `computer_permissions` again. A dry run reports the chosen variant's exact command and never shows a dialog. Reference: [docs/computer-use.md](docs/computer-use.md#macos).

## 2.0.0-alpha.1

### Breaking Changes

- **Declared outcome graphs replace the legacy graph executor** — graph declarations now use the version-3 outcome protocol and its `graph_declare`, `graph_submit_outcome`, `graph_status`, `graph_audit` and `graph_control` tool face. Legacy graph declarations, persisted v2 execution state, the incremental node and edge construction tools, and signal-driven settlement are no longer read or run. Existing graph authors must rewrite declarations for the version-3 grammar and start new runs; the old state has no automatic migration. See [docs/graph-outcome-protocol.md](docs/graph-outcome-protocol.md) and [docs/graph-v3-operations.md](docs/graph-v3-operations.md).

- **Diagnostics moved to a typed logging platform, and the log files changed shape** — every diagnostic rolebox produces now travels one pipeline (`src/log/**`): a record carries its level, its channel, an optional registered event code, the ambient scope (session / agent / graph / run / node / attempt / effect / tool), the caller's id-state-reason-count fields and the process identity, and the sinks behind it are the console, one JSON-lines file per channel and an in-memory ring buffer. Three things an operator can see change. **File records are flat**: `{"time":…,"level":"warn","channel":"graph:host","code":"watch.settlement-threw","message":…,"scope":{…},"fields":{…},"process":{"pid":…,"role":"host"}}`, where the retired logger nested the message under `"0"` and the fields under `"1"`, so a `jq '.["1"].x'` recipe becomes `jq '.fields.x'`. **`warn` and above now reach the console by default**, where the previous file-only logger printed nothing at all; `ROLEBOX_LOG_CONSOLE_LEVEL=error` (or `fatal`) restores a quiet console. And there is **one file per channel** — `graph:host` writes `graph-host.log` — instead of a single `rolebox.log`, which is what keeps two processes from racing over one rotation; historical `rolebox.log` files are left exactly as they are, neither migrated nor read back as records nor deleted. `ROLEBOX_LOG_FILE=/path/to/rolebox.log` restores the single-file layout for every channel at once, rotation included. The variables are `ROLEBOX_LOG_LEVEL` (file threshold, default `info`), `ROLEBOX_LOG_CONSOLE_LEVEL` (console threshold, default `warn`), `ROLEBOX_LOG_LEVEL_<CHANNEL>` (one channel's threshold, e.g. `ROLEBOX_LOG_LEVEL_GRAPH_HOST=debug`), `ROLEBOX_LOG_DIR`, `ROLEBOX_LOG_MAX_BYTES` (rotation size, default 10 MB), `ROLEBOX_LOG_RETAIN` (rotated copies kept, default 3) and `ROLEBOX_LOG_FILE`. Details: [docs/logging.md](docs/logging.md).

### Features

- **Live log views react to source changes** — the log reader now watches the resolved file or directory and emits a debounced change signal. The dsh web panel and TUI Logs view refresh on that signal while retaining a fallback poll for platforms that do not report every append.

- **Logs are queryable, prunable and watchable — `rolebox logs`, a dsh web panel and a TUI view** — the same records are now readable back without `jq` archaeology. `rolebox logs` answers the newest 100 records and takes `--level`, `--channel`, `--code`, `--graph`, `--session`, `--text`, `--since`/`--until`, `--limit`, `--order` and `--json`, while `--follow` tails live; `rolebox logs files` lists every file's channel, rotation, size and modification time, and `rolebox logs prune` removes rotated copies under `--keep`/`--days`/`--max-total-bytes` gates without ever touching the file being written. The dsh web UI gains a right-Sidebar **Logs** tab that polls the read-only `GET /rolebox/logs` route (registered only when the host provides a web server), and the TUI sidebar gains a **Logs** view — `ctrl+l` opens it, `ctrl+p` pauses and resumes, `ctrl+up`/`ctrl+down` move the level threshold, `ctrl+n` cycles the channel filter and `ctrl+g` follows. Structured diagnostics also moved into a closed, typed event vocabulary (`src/log/registry.ts`): a registered code owns its level, its channel and its one-sentence message, so it is filterable by `--code` and re-worded in exactly one place, and the compatibility shell the older call sites still import reports a field value its type cannot admit — by key name, never by value — as the throttled `log.field.narrowed` event instead of dropping it silently. Command reference: [docs/cli.md](docs/cli.md#logs); pipeline map: [docs/logging-architecture.md](docs/logging-architecture.md).

- **The dsh `enabledNamespaces` tool filter composes allows with `!` exclusions** — a profile that had to narrow the tool list could only enumerate the namespaces it wanted, which silently dropped every rolebox tool it did not name. Entries may now be exclusions (`!name` or `!namespace-prefix`), matched exactly as allows are, and an exclusion always beats an allow, `"*"` included, while a negatives-only list subtracts from a baseline of everything instead of registering nothing. That makes `enabledNamespaces: ["*", "!web"]` the documented mitigation for dsh's global `web_search` / `web_fetch` collision: every other rolebox namespace stays registered — `interactive_terminal` and any later tool included — without enumerating namespaces, and the boot log now reports which compiled tool names the filter dropped so a narrowed profile is visible instead of silent. Absent/empty and positive-only lists keep their previous behavior.

- **The dsh plugin never fails a boot on a tool name the host already registered** — rolebox now probes the host registry's own lookup (`ctx.tools.get(name, scope?)`, optional: a host without it keeps the direct registration path) before registering each assembled tool, so a name a composition already owns — dsh's global `web_search` / `web_fetch` among them — is registered by rolebox as `rb_<name>` with a single warning naming both, instead of throwing `tool "<name>" is already registered` and taking the whole row down. The copy carries only the new name: execute and the native-presentation callbacks are keyed by the canonical name at compile time, so the renamed tool behaves exactly like the canonical one. When the prefixed name is taken too the tool is skipped with a warning (a probe that throws counts as free, and a skip is never reported as a namespace-filter drop), and the two graph-worker tool names (`graph_worker_exec`, `graph_submit_outcome`) are never renamed — the worker guard and the dispatch filter match them by literal, so an occupied one is warned about and skipped rather than silently broken.

- **opencode v2 is a supported host** — opencode v2 (`@opencode/cli@2.0.18`) is a separate product from the 1.x line and does not load 1.x plugins, so rolebox now ships the plugin entrypoint v2 resolves — `rolebox/server` (`dist/entries/opencode2.js`, from `src/entries/opencode2.ts`) — default-exporting `{ id, setup }`. On setup it runs the same initialization and builds the same rolebox service graph as the 1.x entry, then projects that graph onto the v2 plugin domains: one registration per canonical tool, the tool `execute.before`/`execute.after` hooks (the latter rebuilding the 1.x `{ title, output, metadata }` output object from the v2 `result`/`error` event, so the recovery guards still read the tool text), the session `prompt`/`context`/`compaction` hooks, roles and sub-agents through the in-process agent transform, role skills, `/stop-loop`, and the event stream normalized into rolebox's canonical events, with a returned cleanup that disposes every registration and flushes loop, function and signal state. The package root keeps the 1.x `{ id, server }` shape, so an opencode 1.x install keeps working untouched; both opencode entries also register the declared-graph tool face described in the next bullet. Where the v2 plugin surface is smaller than the 1.x host the loss is explicit rather than silent: the plugin session domain has no session list, child listing, todos, diff, fork, status polling or compact (those calls and their tools degrade to empty results instead of throwing), agents register in process with no agent file sync and no in-session role switch, a created session cannot be given a parent (`SessionCreateInput` has no `parentID`), so every dispatched session starts without the parent conversation's history, the compaction hook's context travels on the compaction request because v2's compaction event has no `context` field (a compaction another plugin has already resolved keeps its summary verbatim and carries the context in `result.metadata["rolebox.context"]`), the prompt hook carries no agent id so rolebox resolves the acting agent before the hook runs, asking the session first and falling back to the mapping a previous turn recorded (per turn and never cached, so a `switchAgent` between turns is observed on the next one, and an unknown session degrades to no agent), system parts rolebox rewrites lose v2 cache hints (untouched parts keep theirs), tool `ask` resolves without prompting, and the canonical `message.updated` progress heartbeat has no v2 counterpart. A registration the host rejects is logged and skipped, so no single surface can take the host down. Details: [docs/compatibility.md](docs/compatibility.md#opencode-v2).

- **Both opencode entries register the declared-graph tool face** — opencode 1.x and opencode v2 now assemble the shared host capability layer (`src/platform/adapters/opencode/graph-host.ts`, opened for v2 by `src/platform/adapters/opencode2/graph-host.ts`) and register its five bound tools — `graph_declare`, `graph_submit_outcome`, `graph_status`, `graph_audit`, `graph_control` — through `ctx.outcomeGraphTools`, the composition seam that carries a host-assembled face into `buildCanonicalTools`. The graph store root is host-owned and deliberately outside the workspace (`graphStoreRoot(getDataDir(), directory)` resolves to `<data-dir>/host/<workspace-hash>`), because a dispatched worker runs with the workspace as its root. opencode registers no `graph_worker_exec` and needs none: every canonical tool is registered globally, so a dispatched worker keeps the canonical face while its graph face is exactly `graph_submit_outcome` — a bound worker's call to any other graph tool is refused with the stable code `worker-tool-forbidden`. Completion is watched through the platform's own signals (v2 arms `ctx.session.wait` per dispatched session, both entries feed `session.idle` / `session.error` ends and the typed `session.status` state to the host): a recorded end is reported `completed` for a normal end and `failed` for an errored end or a failing terminal outcome, while an idle state answers `unknown`, and neither the end nor a `completed` reading settles an attempt — only the plan's own acceptance of a submission does. Run notifications are installed rather than degraded: each entry hands the host a wake-up channel (`notifyClient`) and the host installs the shipped sender (`src/platform/graph-notifications.ts`), which prompts the session that declared the graph with the shipped `<system-reminder>[GRAPH COMPLETE] / [GRAPH BLOCKED]` render and resumes its loop, while a platform that rejects the prompt leaves the notice pending and retried instead of reporting it delivered. The degradations are explicit: no execution query port and no last-turn reader, and — unlike dsh and Pi — no boot recovery, because an opencode plugin loads for every CLI invocation of a shared configuration and an automatic re-dispatch would fire from unrelated commands (a stranded run stays visible in `graph_status` and is re-armed with `graph_control {command:"retry"}`); the execution reading itself is real on both platforms, from whatever each one exposes: v2 has no `session.status` call (the client's argument-less `active` reports only running sessions and is not plugin-exposed), so its activity state comes from the typed `session.status` event (busy/retry answer running; idle answers unknown) and its session's terminal `outcome` from `ctx.session.get({ sessionID })` (succeeded completes; failed/interrupted are reported on the attempt as a failed execution in the platform's own word), while the 1.x SDK's `Session` carries no outcome field at all, so there the reading stays state-only and no outcome is invented from it; an idle state still answers `unknown` — the turn is over, not that the attempt reached a declared outcome — where a recorded end is reported `completed` for a normal end and `failed` for an errored end or a failing terminal outcome, and only the plan's own acceptance of a submission settles an attempt; an execution whose reads are missing or failed answers `unknown` naming the read that could not answer, and a cancel is answered `requested` or `unsupported`, never `confirmed`.

### Bug Fixes

- **Graph worker task headings are separated from preceding instructions** — the dispatched `## Assigned task` section now starts after a blank line when a host combines it with the worker's role context.

- **Log watching and rotation withstand filesystem errors and competing processes** — watcher errors no longer crash the host, throttle windows are scoped to the affected subject, and a writer waits for a live rotation holder instead of appending into a file still being renamed.

- **Graph store opening tolerates competing writers** — the SQLite busy timeout now allows a loaded host more time to finish its write before another host opens the same workspace store.

- **A session rolebox creates for a role agent runs that role's model on opencode v2** — v2 does not inherit an agent's model into a session it creates (`SessionCreateInput.model` is what the created session runs), so a v2 dispatch fell back to the host's default model and failed on its first model request whenever that default was unusable. The v2 entry now derives the resolved model of every registered role and sub-agent from the same registration assembly the agent transform writes (`collectOpencode2AgentModels`, `src/platform/adapters/opencode2/agents.ts`) and passes it to the session adapter, which forwards it — role variant included — on `session.create`; a role that resolves no model stays out of the map and keeps the host default. The prompt paths also switch an agent only when `ctx.session.get` reports the session is not already running it, so a graph notification or a copilot continuation no longer appends a redundant `agent-switched` message, and they never switch the session's model, which on those paths belongs to the user's own session; a session read that is missing or fails falls back to the previous unconditional switch.

## 1.10.0

### Features

- **Codex is a supported harness** — rolebox now targets Codex through a generated local plugin marketplace plus a rolebox MCP server: `rolebox sync codex` writes `<codexHome>/rolebox-marketplace` (the marketplace manifest plus `plugins/rolebox` carrying `.codex-plugin/plugin.json`, `.mcp.json` and a `skills` symlink to `<codexHome>/skills`), deploys installed roles to `<codexHome>/rolebox`, and registers one managed block in `<codexHome>/config.toml`, with the Codex home resolved from `$CODEX_HOME` when set and non-blank and `~/.codex` otherwise. The plugin starts the rolebox MCP server (`rolebox mcp`, also exported as `rolebox/codex`), a newline-delimited JSON-RPC 2.0 stdio server exposing 15 canonical tools — hashline_read/hashline_edit, memory_write/memory_recall/memory_list, web_search/web_read/web_fetch, asset_search/asset_inspect/asset_validate, reference_search, load_role_skill, signal and interactive_terminal — with no `session_*`, `dispatch_*`, `loop_*`, `task_*` or `graph_*` tools, no role switching, TUI, hot reload, extension loader or hooks-driven activation; the generated layout, the MCP protocol surface and those non-goals are documented in [docs/codex.md](docs/codex.md).

- **dsh roles reload in-process, without a restart** (ce96f44) — `POST /rolebox/reload` (served by the dsh role-switch route, with the monitor panel's "Reload roles" control as its entry point) performs an in-process, non-destructive role reload: roles are re-discovered and re-resolved into the live containers in place and the agent catalog is re-synced, so installing or editing a role no longer needs a host restart. Because consumers capture the resolved-role snapshot by reference, the four role-snapshot tools (`asset_search`, `asset_inspect`, `asset_validate`, `reference_search`) are rebuilt as one disposable generation and the lazy skill catalog is invalidated, while discovery and resolution run against local containers and every post-swap mutation is guarded by an in-memory rollback — a failed reload leaves the previous roles, role functions and open-role registry in place, so no partially swapped state is observable.

### Bug Fixes

- **Dispatch teardown always releases its resources** — `DispatchManager.dispose()` now runs its release tail in a `finally`, so a throwing state flush can no longer leave the watchdog timers running or the state lock held. Pending debounced progress writes are flushed and their timers cleared on teardown, so no write can fire after a manager is disposed.

- **Dispatch health is config-aware** — a stopped budget sampler now reads as a stopped pipeline only when a budget limit is actually configured, so a manager with no configured limits no longer reports unhealthy merely because its sampler was never armed, and a manager with configured limits no longer reports healthy while its sampler is dead.

- **Process-fatal events are recorded without changing host behaviour** — a new observation-only reporter flushes rolebox state and writes one structured log entry on `uncaughtException` / `unhandledRejection`. It never exits, re-throws, or alters the host's exit code, installs and removes exactly its own process listeners, and reports at most one event per process.

- **Graph Engine v2 correctness fixes** (7a7c67e) — Persistence DTOs are derived from the runtime types and validated per node, so a partial node state can no longer load as valid and silently disable the `max_total_*` budget gates after recovery; join quorum is a discriminated union that carries its count instead of a quantity-free member each consumer read differently; a dispatch kickoff that contends for the advancing lock is deferred and replayed instead of dropped, so a graph cannot sit in `executing` with no work in flight; `on_condition` loop-backs consume a traversal, which makes `max_traversals` enforceable for that shape; and the approval payload is serialized before the node is marked complete, so an unserializable payload can no longer complete a node and strand its downstream join. The same pass stops escalate propagation from walking revise back-edges, validates `partialApprove` member lists, scopes the terminal-notification dedupe key to the engine epoch, returns approval reports instead of `void`, and routes `graph_cancel` through the authority `CancelScopeReport` rather than matching `errorReason` text.

- **Session tool output hardened** (62298b1) — `formatDate` no longer throws on a non-finite or out-of-range timestamp, so one malformed session record can no longer abort a whole tool call; durations no longer render as `NaNh NaNm`; markdown table cells are escaped so a title containing `|` or a newline cannot break the table; number grouping is locale-independent; and `formatDiff` is a real LCS unified diff with hunk headers, context lines and a missing-newline marker instead of an index comparison that marked every line of a file as changed when a single line was inserted at the top.

- **The CLI checkpoint list tolerates malformed rows** (8855f9c) — `rolebox checkpoint list` coerces and validates each row as it reads the checkpoint file, tolerates a missing or unparseable `created_at` through the shared timestamp helper, and keeps nulls out of the sort comparator, so a single bad entry (a missing phase or a numeric task id) no longer throws `TypeError` outside every try and reduces the command to a bare header with no rows.

- **Truncation budgets display columns** (9615bfb) — `truncate()` sliced UTF-16 code units, so a wide or CJK title could overrun its column budget and a cut could split a surrogate pair into `U+FFFD`; it now budgets display columns, which also composes with the padding helpers. Behavior change: a non-ASCII string truncates at roughly half the previous character count, because each wide character costs two columns.

- **Model-alias advisories are de-duplicated per cache generation** (45344c1) — Each unresolvable model is reported once per cache generation instead of once per role, so a config with N such roles no longer emits N identical four-line advisory logs on every discovery and hot reload; `initModelResolver` re-arms the reports so the next load after a config edit still warns, and a non-mapping `model_aliases` value is rejected instead of registering bogus numeric aliases.

### Refactors

- **Harness entries consolidated under `src/entries`** (85b2423, 9655230, 45406e4) — The three harness entries now live in `src/entries` (`opencode.ts`, `pi.ts`, `dsh.ts`) and publish at `dist/entries/*`; `dist/index.js`, `dist/pi-extension.js` and `dist/dsh-plugin.js` are still generated as re-export aliases, so existing out-of-package harness configs keep working, and the alias build unlinks stale legacy declarations so a previously built outDir cannot publish them. The opencode entry's `roleFunctionsMap` re-export is restored.

- **One shared text-format module** (1c98377, 13db0d1) — The duplicated duration, truncation, padding, bar and byte formatters now delegate to a single pure `src/utils/text-format.ts`, with documented invalid-input sentinels, surrogate-safe truncation, ANSI- and East-Asian-width-aware measurement, markdown cell escaping and locale-independent number grouping.

## 1.9.0

### Features

- **Redesign the role dock and monitor in the dsh web UI** — The role dock now leads with the active role's display name and an explicit Active/Base state instead of an unlabelled dot, and the monitor panel opens with an attention verdict plus a plain-language state word beside every phase, so a failed graph no longer looks identical to a healthy one. Collapsed content no longer lays out, animations follow the host's single easing curve, and a graph with a pending approval gate is still reported as live for the human.

### Bug Fixes

- **dsh web UI dropped from the boot graph** — The bundle patch named the cordis host half with the package subpath `rolebox/dsh`. dsh-client-modules only scans loader rows whose specifier is a package root or a path-like module (`exactPackageSpecifier` / `locatePkgJson`), so the row was cached as a permanent "not a client package" verdict and the role dock plus monitor panel never reached `window.__DSH_BOOT__`. The shipped patch now uses the package-relative `../dist/dsh-plugin.js` (resolved against the patch file's own directory), which makes the scan derive the browser module id `rolebox` from the package manifest; the client bundle envelope id changes from `rolebox/dsh` to `rolebox` to match that row.

- **Record the terminating signal on settle on dsh** — The dsh adapter now reads the completion ledger when it settles a task, so completed nodes record their terminating signal and recovery no longer logs a missing `terminatingSignal`; a broken ledger falls back to the synthetic answer instead of breaking the fire-and-forget settle path.

- **Handle nested graph gates and failures on dsh** — A node whose agent launches a nested graph via the non-blocking `graph_run` is now held running until that graph terminates, a nested failure propagates as an escalation, and a nested approval gate walks the session parent chain to reach the outermost live session together with the exact `graph_approve` call. Silent reminders now honor `noReply` with the same waking/silent split as opencode and Pi.

### Documentation

- **Refocus the README and move detail to docs** — The README now leads with what rolebox is and how to install it, and the graph-engine internals, dsh route contracts, and model-alias resolution move into `docs/`. A `graph_add_loop` termination example that described a non-existent parameter was replaced with the real `max_traversals` cap behavior.

- **Add output privacy and leakage hygiene guidance to AGENTS.md** — Contributor guidance now requires checking everything that leaves the session — git history, changelogs, release notes, workflow files, package contents, and CI logs — for private infrastructure, secrets, and personal data.

## 1.8.1

### Bug Fixes

- Corrected documentation and inline-comment examples. No functional change.

## 1.8.0

### Breaking Changes

- **Declarative collaboration / termination subsystem removed** — The legacy declarative multi-agent workflow vocabulary is fully removed. The `collaboration:` block (`topology` / `flow` / `agents` / `max_iterations` / `termination` with `any_of` / `all_of` conditions) is dropped from the `role.yaml` schema; the `TerminationDecl` / `TerminationCondition` / `LoopCondition` / `TerminationConfig` type vocabulary, the `termination_conditions` extension point, and the `graph_add_loop` `termination` argument are deleted. The ported `collaboration-*` graph modules (advance / state / store / bridge / validator) and the remaining v1 residue (`prompt-builder`, `termination*`, `edge-parser`, `loop-detector`, `result-capture`, `graph-utils`, the `migrate` command) are removed, along with the v1 graph-session runtime-state reader and its compaction and `monitor` surfaces. `rolebox init` now offers three templates (`minimal`, `standard`, `subagents`), the four inert collaboration example roles are deleted, and the corresponding documentation is retired. Multi-agent workflows run exclusively on the imperative `graph_*` engine.

### Features

- **Engine-v2 `<graph_state>` system-prompt block** — Every turn now injects a compact orientation block rendering the live in-memory graph registry — graph name and phase, active / pending / blocked node ids, loop-group traversal counts, and blocked nodes with their approval reason — via a new pure `buildEngineGraphStateBlock` renderer (`src/graph/engine/graph-state-block.ts`) sourced from `GraphToolSet.liveEngineStates()`. It replaces the v1 collaboration-state block, escapes all user-supplied graph names, and returns `""` when no graph is live so every injection site no-ops with no stray tags.
- **`graph:` role-config key recognized by the loader** — `role.yaml` accepts a role-level `graph:` block with an `orchestration` selector (`graph_v2`). The loader parses it onto `RoleConfig.graph` and emits an explicit warning that the key is recognized but not yet wired into graph resolution (no runtime effect), so it is never dropped silently; malformed or unknown declarations are warned about and omitted.
- **Role skills surfaced under dsh through a lazy skill provider** (f69c266) — Rolebox registers a lazy `SkillProvider` on the dsh skill registry: `list()` advertises the active roles' skill metadata (workspace-wide union, subagents walked recursively, kebab-case names pre-filtered and deduped first-wins) and `get()` loads the body on invocation, so advertised `<available_skills>` names are resolvable by the skill tool without an eager boot-time read of every role's skills. An `onActiveRoleChanged` hook refreshes the catalog on role switch/clear/restore; headless profiles without the registry degrade to a no-op.
- **Platform parity for `rolebox config` and `rolebox sync`** (56eec91) — `config` gains a registry-driven `--target/-t` (default `opencode`) plus an interactive target menu, so dsh/pi-synced roles can be configured; an explicit `--target` skips the prompt and non-interactive runs keep the opencode default. `sync` now reports role directories that are real dirs rather than symlinks into the shared source (which silently diverge) and repairs them with an opt-in `--relink` that backs up to `<role>.backup-<ISO>` before swapping.

### Bug Fixes

- **dsh adapter contract drift corrected** (f1174b7) — Fixes mismatches between the duck-typed dsh adapter layer and the installed harness dist, most severely an argument-order bug in the session/event listener that read the `Session` (first arg) as the event and killed the sub-type stream and every chat-message hook on real traffic. Also fixes capability-gated spawns, the fork boundary shape, the required parent agent, the malformed/non-waking inject seam, and the remaining session, tool, and system-prompt shape mismatches; active-role durability moves off the session event log to a workspace-scoped `.rolebox/state` sidecar.
- **dsh graph dispatch spawn delegation repaired** (1c3f7cc) — Registered providers delegate real spawning to an already-registered host provider (`spawnProviderName`, default `"spawn"`) instead of always rejecting `DshSpawnNotWiredError`; a name colliding with a rolebox agent id is refused with `DshSpawnRecursionError` so delegation cannot re-enter the same `start()`. Graph dispatch resolves the live parent `Agent` from the graph's real parent session while keeping the graph-scoped budget key as the registrar key, and the execute wrapper wraps a JSON-object string result as `{ output, ...parsed }` so `run_code` callers can read fields while model-visible text stays byte-identical.
- **dsh tool args validated against their schemas** (52ea61b) — The dsh adapter passed raw args to `tool.execute`, so required properties, defaults, and enums were never enforced on that platform — the root cause of the `loop_start` crash. Args are now parsed with a non-strict `z.object(schema).safeParse()`, the parsed data applied, and a host-style correction string returned on failure.
- **dsh spawn sets provider and model** (342b0eb) — The adapter set only `AgentOptions.model`, so a canonical `provider/model-id` role value left `provider` unset and the spawn inherited dsh's configured default provider. The canonical value is now split into provider + model via the shared helper; an unregistered provider route degrades to a model-only override with one warning instead of a hard `NO_ADAPTER` failure.
- **Cordis waterfall listeners chained to `next()`** (85aa551) — The tools/pre-execute and tools/post-execute listeners now return the waterfall chain result; previously a bare `undefined` clobbered the chain and dsh-tools' `decision.kind` read threw on every tool call. The trailing `next` is stripped before payload normalization and always chained, awaiting async observers first and keeping the chain alive on handler errors.
- **Synthetic injections ignored in the session-agent registry** (282d45e) — The session→agent mapping is now registered only on genuine user turns: a synthetic `<system-reminder>` re-entering after a graph/dispatch/loop notification was overwriting the mapping and causing `system.transform` to later resolve the wrong role. Reuses the existing `isSyntheticInjection` classifier.
- **Orchestrator role resumed across platform reminders** (03e14d2) — The orchestrator's acting agent is threaded into graph-notify reminders so a `<system-reminder>` continuation resumes the caller as its real role instead of falling back to `default_agent`, on opencode, Pi, and dsh; absent an agent or a live-agent registry, reminders degrade to the existing engine marker instead of failing.
- **`graph_approve` is a true no-op on an unblocked node** (221b269) — Approving an already-resolved node no longer dispatches the ready frontier or checks termination; dispatch is gated on an actual approval and `applied=false` is surfaced for no-op decisions.
- **Tool registration emits raw JSON Schema** (fe0426e) — `ctx.tools.register()` stores the definition as-is and does not run `defineTool()`'s parameter compiler, so emitting the author DSL leaked a per-property `required` onto the wire that DeepSeek rejected with HTTP 400. The adapter now compiles the author DSL to register-ready raw JSON Schema.
- **`loop_start` validates its args** (da4b202) — A missing prompt reached `computePromptFingerprint` and threw a raw `TypeError` instead of returning a validation error; the prompt is now validated before registration and the schema defaults (`iterations=5`, `mode=inherit`) are applied explicitly.
- **`session_fork` reports refusal honestly** (31628ba) — The refusal message no longer blames a message id when none was supplied and no longer claims the session may not exist after it was already loaded; the swallowed dsh adapter error is raised from debug to warn with its underlying message so the real cause is observable.
- **Session tools stop truncating ids** (6466d68) — `shortId()` truncated session and message ids to 12 characters in the only ID column, so the values could not be fed back into `session_info` / `session_read` / `session_fork`; full ids are now emitted in the session and search tables.
- **`hashline_read` / `hashline_edit` resolve relative paths against the workspace** (95a8da5) — Both tools resolved relative paths against the host process cwd instead of the session workspace, so a relative path failed with a "File not found" normal string and read/edit could target different files; paths now resolve against the tool context directory via a shared helper.

### Refactors

- **Shared model-ref helper extracted** (6601a0e) — Pi's local `splitModel` moves to a platform-neutral helper so the dsh adapter reuses the same canonical provider/model-id parsing. No behavior change.

### Documentation

- **Rolebox documented as harness-agnostic** (52dd975) — opencode-specific wording across the README, docs, and the package description is replaced with harness-neutral language, and the global skills/functions directories are documented as following the active harness's config dir (rolebox targets opencode, Pi, and dsh).
- **dsh session-log write discipline documented** (94c0031) — Adds the rolebox boundary rule that rolebox never appends its own event types to the dsh session log, documents active-role durability in the workspace sidecar, and refreshes stale contract citations to match the installed harness surface.
- **AGENTS.md contributor guidance added** (a1a4102) — Codifies the module-to-test path mapping and the testing policy that forbids running the full 411-file suite locally in favour of module-scoped slices.

## 1.7.0

### Bug Fixes

- **Graph validation now rejects unknown `on_condition` condition names and blocks uncontained revise-free cycles** — `validator-v2.ts` check 11 rejects any `on_condition` edge whose `condition` is missing or names a condition outside the registered vocabulary (`KNOWN_CONDITIONS`, the same source `asset_validate` uses), so a never-satisfiable edge can no longer silently deadlock the graph at run; and uncovered-cycle severity is now mode-split: `"construct"` (the default) keeps the WARNING so incremental building (add the cycle-closing edge, then declare the loop group) works in either ordering, while `"execution"` promotes an uncovered cycle with no revise back-edge to an ERROR, since no edge in it can ever be excluded from root discovery and the graph deadlocks at runtime. The execution-mode gate is wired into all three run-adjacent paths — `graph_run` `dry_run`, fresh-engine `graph_run` (both `src/graph/tools/graph-tools.ts`, the latter throwing the validation errors), and `importGraphFromFile` (`src/graph/parser-v2.ts`, returning null) — so a construction-valid-but-unrunnable graph is refused before dispatch instead of deadlock-escalating at run. (821d367)
- **`hashline_edit` duplicate-alias folding, transactional staging, and failure diagnostics hardened** — Duplicate paths in a batch are now folded by filesystem identity (dev+inode) rather than raw spelling, so symlink aliases, hardlink aliases, case aliases on case-insensitive filesystems (darwin/win32), and trailing-slash spellings of the same file are all caught with zero side effects. Hardlinked (in-place) members are now written in the COMMIT phase after every temp file is staged, so a staging failure leaves zero writes instead of a partial batch; a commit-phase (rename) failure can still leave earlier files updated and later files untouched, and in-place writes remain non-atomic. Write-failure messages name the failed file together with which files were and were not written, all `hashline_edit` failure results begin with `Error:` and identify the affected file (including pre-write re-check I/O errors such as `EISDIR`), and an ambiguous fuzzy anchor correction — multiple hash-equal candidate lines with differing content (a width-2 hash collision) — is rejected with an explicit re-read error instead of silently nearest-matching (same-position collisions stay accepted by the position+hash anchor contract). (0fe11c6)
- **State saves use atomic rename-over** — `task-store`, `collaboration-store`, and `metrics-persister` save paths dropped their unlink-then-rename sequences in favor of a single POSIX-atomic rename, so readers never observe an ENOENT window and a crash mid-write never leaves the target file missing. (57a8069)
- **Startup hardened against corrupt persisted state** — A crash mid-run could leave stale artifacts under `.rolebox/state/` that blocked opencode/Pi startup via uncontained throws. `state-lock` `pidAlive` no longer rethrows (EPERM from recycled PIDs falls through to the staleness check) and lock writes use `atomicWriteSync`; `startup-check` gained `engine-`/`collaboration-`/`budget-`/`recovery-` patterns, orphan tmp cleanup, `breakStaleLocks`, and a never-throwing quarantine; `StartupChecker` callsites degrade to empty health instead of aborting init; and `pi-extension`/`composition` continue with empty/no-op state on `recover()` failure. (adde6c6)
- **Graph approval-gate notification loop closed** — A `needs_approval` gate now stays observable instead of going silent: pending gates are enumerable via `graph_status(pending_approvals=true)` (registry + persisted store, with a paste-ready `graph_approve` per row), `graph_approve` survives a plugin restart by falling back to the persisted engine store, recovered quiescent-blocked graphs re-fire `[GRAPH BLOCKED]` once, startup injects an `[PENDING APPROVALS]` reminder (auto-continue-safe marker), and a new `approval_pending` OS notification channel (toast/sound/webhook) honors quiet hours and throttling. (192efee)
- **Graph escalate-retry budget enforced and `backoff_ms` honored** — The escalate-retry gate previously consulted only outbound edge retry policies and ignored per-node `budget.max_retries`, and `backoff_ms` was parsed but never enforced. It now resolves an effective per-node budget (max of the node budget, outbound edge, and inbound edge) and withholds a `Ready` node from dispatch until its backoff deadline via a single unref'd wake-up timer (cleared on reschedule/dispose/terminal), with the deadline surviving serialize/adopt; a drain-replay race that could re-escalate a re-dispatched retry is also fixed. (9698bca)
- **Graph quorum, timeout, and retry-budget validation tightened** — Structurally-broken graphs that passed validation and then hung or misbehaved at run are now rejected: `quorum <= 0` no longer satisfies a fan-in join with zero answers, `quorum > in-degree` is refused, a negative `timeout_ms` no longer silently disables the staleness watchdog, and negative/fractional `max_retries` are rejected — enforced via the zod primary guard, structural validator rules 9-10, and engine clamps. `timeout_ms: 0` remains the documented disable-staleness-watchdog sentinel. (9dd395b)
- **`hashline_edit` trailing-newline, CRLF, anchor, and link semantics fixed** — Trailing-newline state is now a boolean instead of a replayed count (no phantom blank lines on append or last-line replace), a segment-trailing CR is stripped before appending a CRLF terminator, anchor-prefix stripping is scoped to the target file's line range so literal hash-like content is not deleted, and symlink/hardlink aliases are realpath-folded so edits write through links and every name observes the change. (4fc0b11)
- **`hashline_edit` version round-trip, anchor widths, and edit semantics fixed** — The edit-returned version now matches a fresh read (chained edits need no re-read), hash anchors of width 5-8 are accepted, same-batch insert-inside-range and same-line ordering work, empty replace content deletes the target line, reanchoring uses old-line content and post-edit hash width, windowed read clamps `endLine >= startLine`, and per-line EOL is preserved through edits on mixed CRLF+LF files. (358a04f)

### Refactors

- **Multibyte-safe result char-slicing in dispatch** — Dispatch result extraction now slices on character (code-point) boundaries instead of raw UTF-16 units, so multibyte payloads are no longer split mid-character when truncating result text. (53e8f81)

### Tests

- **`hashline_edit` adversarial robustness suites** — Seven suites probe the edit tool beyond its documented contract (cross-process races in real separate OS processes, the recheck→rename window, batch partial-write and hardlink ordering, width-2 hash-collision fuzzy misanchoring, mid-flight filesystem changes, and a version round-trip matrix), classifying each scenario as a confirmed defect or documented behavior. (51c012f)
- **`hashline_edit` adversarial edge-case suites** — 30 regression cases over trailing-newline semantics, replacement-content fidelity (CRLF, NUL, unicode, anchor-prefix stripping), and path aliases (symlink, hardlink, dot-relative spellings) serve as acceptance against the D12–D16 fixes. (0a4fa89)

---

## 1.6.1

### Bug Fixes

- **Postinstall patch script shipped in the npm package** — `postinstall` runs `scripts/patch-opentui-native-entry.mjs` after install, but `scripts/` was absent from the npm `files` whitelist, so every user install would fail with ENOENT on that step; the exact script path is now whitelisted. Adds the tag-triggered publish workflow (`.github/workflows/publish.yml`) with a package-content verification gate that pins this class of bug (missing postinstall/exports files) from shipping again. (7568a9b)

---

## 1.6.0

### Features

- **Unified turn-end decision pipeline** — Unifies the incumbent function auto-continue as an always-on builtin policy source inside a single `session.idle` pipeline, alongside an opt-in user-heuristic rules source and an opt-in LLM copilot-role verdict source. The builtin source is a byte-identical extraction of the previous continuation phase (`decideContinuation` and `src/function/continuation.ts` untouched, same 25/5 caps, cooldowns, rollback, and `[auto-continue` marker); sources evaluate in strict precedence builtin → rules → LLM with at most one injection per idle, and a rule action `skip` consumes the turn without LLM fallthrough. The LLM verdict runs on a fresh child session with a hard timeout and skips on any failure. Copilot injections carry a `[copilot-auto:` marker registered as synthetic so they never reset continuation counters or cancel loops. No injection budgets or code-level guardrails by design: destructive and HITL caution is advisory prompt guidance, overridable via `llm.guidance`, with the role author's judgment as the control surface. (a626cd6)

### Bug Fixes

- **Graph budgets enforced, crash orphans cancelled, loop caps retired** — Enforces the declared graph- and per-node budget ceilings: a graph-level breach escalates the ready node and cancels stranded pending nodes so the graph reaches complete instead of hanging, and per-termination usage accumulates into `state.budget` totals at `captureNodeUsage` to feed the ceiling check. Crash-window orphaned dispatch sessions are cancelled on recover/adopt (reconcile sweeps the dispatch parent session for a live task and recovery tears it down fire-and-forget), and loop-cap re-entry retirement now surfaces through the completion seam (escalate-signal with a post-`markDone` Done status, no duplicate on replay). (4218ec4)
- **`hashline_edit` lost-update prevention** — Concurrent edits to the same file could silently overwrite each other: each call ran an optimistic version guard against the file at read time, then renamed over whatever was on disk afterwards, so the last rename won and earlier edits were lost with no error; a batch containing the same `filePath` twice had the same silent-overwrite failure. Edits are now serialized within the process by a per-path async mutex held across the whole read → validate → compute → recheck → write cycle (acquired in globally sorted key order to keep overlapping batches deadlock-free, released in reverse order on every path), duplicate paths in one batch are rejected up front with zero side effects, and a best-effort pre-write re-check re-reads every file (canonicalize + recompute version) immediately before writing — any drift from the read-phase version, or a to-be-created file that has appeared, fails the whole batch with zero writes and points back to `hashline_read`. The re-check is explicitly best-effort: it does not lock against other processes, so a change between re-check and rename is not caught, and a batch remains a non-transactional sequence of per-file atomic renames. New `src/hashline/path-lock.ts` + `tests/hashline/path-lock.test.ts` + `tests/hashline/concurrency.test.ts`. (e82d674)
- **Graph control paths and persistence hardened** — Closes the graph-engine audit findings (R1/R2, Y1/Y3/Y4/Y5/Y6/Y7/Y9/Y11/Y12, B1-B3). Approve/reject/partialApprove/retry now acquire the advancing lock before the critical section via `_runControlOperation`; under contention the whole operation defers (bounded macrotask retry) instead of running unlocked and releasing an owner-less lock. `loadEngineStateFromJson` validates node status/joinStrategy and file phase against the vocabularies — out-of-vocabulary values return null (clean start) instead of hydrating and crashing later in `canTransitionNode`. The materialized sidecar is read once at completion time (`_stashResultText`) and stashed on `node.resultText`, carried through DTO/serialize/deserialize/recovery; `_edgeResultText` no longer does disk I/O inside the critical section. The triplicated retire+cancel+refund pattern is consolidated into a shared `retireCancelledNode` helper (the cascade site keeps refund off, preserving current accounting); `recover()` rethrows non-ENOENT load failures (EISDIR) instead of silently re-provisioning completed work; the dead `DispatchBridge` surface (`executeSync`/`getResult`/`getTasksByParent`/`getBudgetTracker` + `DispatchResultPayload`) is dropped; canonicalize is depth-bounded (32) with a stable truncation marker so deeply nested payloads fingerprint without RangeError; and direct `isDirty` writes are routed through `markDirty` with stale doc anchors fixed. (9c8b7f9)
- **Graph-engine review findings resolved** — Addresses the engine code-quality review across P0-P3. `_advance` signal branches are guarded against double-counted traversals and post-terminal re-dispatch, completion is gated on drained `pendingCompletions`, and containment escalates propagate downstream so fan-in joins fail fast instead of hanging. Recovery contracts are closed (live re-check on error tasks, subscription ledger for dispose, checkpoint compensation, markDirty choke-point, `hasRequiredShape` completeness, ENOENT-only clean start) and `EnginePersistence.dispose()` plus a public `clearTerminationSubscriptions()` drop the private-field cast. HITL notifications are exactly-once and observable; session slots are refunded on direct cancel; running-node retries are guarded; escalate budget uses real token/cost; done and cancelled nodes get their own tally buckets. Dead seams are removed (`state.edges`, `mergeFanInContext`, `pendingWrite`, duplicate severity order), the signal vocabulary is single-sourced, empty edge payloads fall back to node result text, and condition-resolver `signal_observed` args are normalized. (3c70950)

### Refactors

- **Graph internals deduplicated and cancels hardened** — `getRootNodeIds` reuses `computeInDegrees` (drift-proofing), `getJoinStrategy` prefers the cached runtime `joinStrategy` field, and the shared `enqueueWithRetry` is extracted behind the three notifier factories. Per-node checkpoint history is capped at 50 entries, `resetConvergenceTracker` throws a descriptive error on unknown group, fire-and-forget `cancelTask` rejections are contained (no unhandled rejection), and the dead `isLoopExhausted` import is dropped from engine-advance. (3b2fb24)

### Documentation

- **Unified turn-end pipeline documented** — Adds `docs/copilot.md` covering the role.yaml copilot block schema, builtin → rules → LLM precedence, LLM-role authoring with the strict JSON verdict contract, the advisory-only guidance design decision, and the synthetic marker contract; the worked example parses cleanly through `parseCopilotConfig`. (b6bb402)
- **Graph architecture anchors refreshed** — Re-verifies all file:line anchors against the post-fix tree and updates the CONFIRMED-GAPS table: gaps c/d/f/g are marked resolved with current evidence, the re-verification date is refreshed, and module-map references are aligned with the engine fixes. (1edf2af)

### Tests

- **Copilot suites added** — Six copilot unit/e2e suites (`tests/copilot-{config,llm,pipeline,prompt,rules,transcript}.test.ts`) plus extended chat-message and pi-chat-activation coverage for the synthetic `COPILOT_MARKER` classification (no continuation-counter reset, no loop cancellation). (ade8978)
- **Review-fix regressions covered** — Regression tests for the engine review fixes: duplicated-signal traversal counting, quiesce-before-drain completion, containment escalate propagation, exactly-once HITL notifications, session-slot refund on cancel, running-node retry guard, escalate budget carry, done/cancelled tally buckets, dispose-cancels-debounce, persistence shape gates, budget stub contract, signal single-source schema, condition-resolver normalization, and JSON-structured status assertions. Includes the new `engine-termination-s5` suite for termination counting and deadlock-guard ordering. (7b94bc3)

---

## 1.5.0

### Breaking Changes

- **Legacy concurrency manager and session budget removed** — The `ConcurrencyManager`/`IConcurrencyManager` subsystem and the `concurrency_policies` extension point are deleted, along with per-request session budget tracking and the graph `max_total_sessions` cap; graph-node concurrency is now engine-managed (frontier, loop `max_traversals`, per-node budgets) instead of slot-based. Removes the `DispatchManagerConfig` fields `maxConcurrent`, `maxQueueDepth`, `syncReservedSlots`, `maxActivePerParent`, `maxTotalSessionsPerRequest`, `retryAfterMs`, `backpressureMaxRetries`, `backpressureMaxDelayMs`, `syncAcquireTimeoutMs` and the `concurrency_policy` factory, drops the `graph_status include_concurrency` argument, and removes the node/graph budget fields `max_sessions` / `max_total_sessions`. (edb764e)

### Features

- **Rolebox monitor panel with status/metrics routes in the dsh web app** — Adds a settings.section monitoring panel backed by two read-only `/rolebox` endpoints: `GET /rolebox/status` composes the live loop census, in-memory engine graph snapshot, session count and per-session active role, and `GET /rolebox/metrics` returns the in-process dispatch metrics snapshot. The role-switch and monitor surfaces now share ONE `/rolebox` prefix registration (the real host webserver rejects duplicate prefix routes), with the monitor route owning `/status` + `/metrics` and delegating `/roles*` to the role-switch handler; `DshPluginStats` gains `monitorRouteRegistered`. (bcf8b20)
- **Role-switch dock filter and auto-collapse** — Adds a keystroke filter row (name + description, case-insensitive) with a clear button and an explicit no-match row; the query survives collapse/expand and resets on session change. The dock now starts collapsed and re-collapses on session change and after a successful switch/clear, keeping the 36px posture above the composer while the status seat and a new current-role dot report the active role. Failed mutations keep the list open with the Retry row, and the name seat becomes `flex:none` so a role's identity never truncates. Covered by a new stateful in-process harness (`tests/platform/dsh-web-ui-dock.test.ts`, 18 tests). (0f552a4)

### Bug Fixes

- **Pi child session sidecars retained and dispatch state relocated** — Pi subagents spawn as `--no-session` children whose transcript sidecars were unlinked on exit, so `session_read` and escalate-recovery could not inspect completed or failed children; sidecars are now retained with a bounded mtime-based cap and the effective system prompt is persisted beside each transcript, with `PiSessionAdapter` falling back to the retained sidecar when no pi-native session exists. Dispatch state (results, checkpoints, progress) was written to the pi home because the dispatch manager used `dirs.configDir` as its store directory; it now points at the workspace so `.rolebox/state` lands in the project like opencode and dsh. Adds `tests/pi-sidecar-retention.test.ts`. (11a8477)
- **Pi gate dispatch skill echo repaired** — Pi gate subagents spawn as `pi --mode json -p --no-session` children whose first step is loading the gate skill via the skill tool, but pi 0.84.2 ships no `skill` tool and the child re-runs chat-activation + system-transform on top of the `--append-system-prompt`, so the model echoed skill/prompt fragments as its final answer and the gate never ran. Adds a pi-only `load_role_skill` tool returning the full SKILL.md payload with references, a child-process mode guard that skips the double context injection while keeping nested dispatch, a deterministic per-agent tool allowlist, per-pid child dispatch state, and a `<location>` path in the skill block for read-based fallback. (17ea619)
- **Final assistant answer extracted in the dispatch materializer** — `buildAssistantText` previously concatenated every assistant-role text part from the boundary index, so tool-result content misattributed as assistant text (e.g. a skill tool echoing its own SKILL.md prompt) polluted node output; `extractFinalAssistantText` now picks the last assistant message carrying non-empty text, preserving result-fence extraction and falling back to full concat only when no assistant text exists. (6277c8c)
- **Pi session completion guarded and role classification tightened** — `agent_end`/`agent_settled` completed the turn unconditionally, bypassing the `_isFinalTurn` guard that protects the `turn_end` path, so completion fired mid-tool-round-trip; the same guard now applies to both paths, and only an exact `assistant` role is classified as assistant so tool-result messages are never misattributed as assistant text, with `MessageInfo.role` widened to preserve adapter-specific roles. (8c8d4ad)
- **Tool-bearing last messages marked incomplete in detectCompletion** — `detectCompletion` only guarded pending/running tool parts and matched `finish === 'tool-calls'` exactly, while the pi adapter records `finish = 'tool_use'` for a settled tool round-trip; any tool part in the last assistant message now yields `not_ready` and any finish matching `/tool/i` is treated as incomplete, while text-only `end_turn` turns still complete. (6498537)
- **Parent reminders suppressed for graph-scoped dispatch tasks** — Graph nodes dispatch through the background-task path, which notified the parent unconditionally, doubling the graph engine's own reminders and surfacing a different id namespace (`bg_*` vs node id); a graph-scope marker is now threaded through `DispatchInput`/`DispatchTask` and `notifyCompletion`/`notifyParent` are skipped for graph-scoped tasks, with graph completion reported exclusively by the graph notifier. (a52a8c5)
- **terminalNotified persisted across engine rebuilds** — `snapshotEngineState` dropped `state.terminalNotified`, so `adoptPriorNodeStates` received undefined and the persisted-layer exact-once terminal guard was lost on the adopt/rebuild path; the flags object is now shallow-copied so the terminal-claim survives snapshots. (0da1fbf)
- **Answer replay skipped on node retry** — `graph_run(node_id, retry=true)` called `adoptPrior(replayAnswers:true)` before `retryNode`, and the answer replay re-emitted the adopted Completed node's answer through `_checkTermination` while the target was still Completed, firing a premature `[GRAPH COMPLETE]` before the retry opened; retry now adopts with `replayAnswers:false`, making `retryNode` the sole dispatch + termination authority on the retry path. (4141429)
- **False staleness kills stopped and sessions refunded** — Fixes the cascade-failure chain seen in live runs: a false-positive wall-clock staleness kill of a working-but-quiet subagent at 15 min, the opaque deadlock escalation that followed, and per-request session slots never refunded for cancelled/timed-out tasks, which blocked in-place retry after a cascade (`re_dispatched: 0`, session budget exhausted). `NodeStalenessWatcher` now consults dispatch-task liveness via an `isDispatchAlive` probe and skips the wall-clock kill while the task is verifiably live (probe-absent behavior stays byte-identical); timeout and deadlock escalation reasons carry liveness facts and upstream causes (`nodeId` + `errorReason`) instead of generic text; cancelled/timed-out dispatch tasks refund their per-request session slot (idempotent, floored at zero) while completed/escalate/blocked tasks keep counting; and the graph-declared `max_total_sessions` is enforced at the graph pre-dispatch check with a clear per-graph reason, pinned end to end by graph-staleness-cascade-chain tests. (b64b447)
- **Live in-memory engine graphs surfaced in the monitor TUI** — On the opencode platform the engine runs fully in-memory and never writes `engine-*.json`, so the monitor's disk scan showed an empty engine list while graphs were executing; the process `GraphToolSet` is now registered as a live registry source, its runtimes are projected through the same snapshot surface and merged live-wins-by-graphId over the disk scan, stale terminal persisted graphs are gated, and per-node statuses from the 250ms event poll are folded in so node glyphs update between 1s snapshot ticks. (8559208)
- **Running state persisted before the dispatch await** — A node's running transition was only persisted in the section-end finally, after the async dispatch awaited — loop re-entry during the await left disk at completed (false-completed on Pi/dsh); the running transition is now persisted synchronously before dispatch. Also: engine-persistence renames over the destination atomically (no ENOENT read window), fs-util uses unique per-write temp paths so concurrent writers never share a temp file, and recovery-state async writes are generation-guarded so superseded writes abort before their rename. (34d9259)
- **asset_search type normalized to all** — Some models emit the literal string "undefined" for an omitted optional enum, bypassing zod's `default("all")` and filtering against the bogus type — silently returning zero matches; `.catch("all")` and an execute-level guard now make missing/invalid type values always resolve to "all". (1f7b6dd)
- **Gate sentinel skipped in transition condition validation** — `t.when === "gate"` is a sentinel resolved by `phase-machine.ts` to the function's own `gateSatisfied` state, not a named condition, and the validator was reporting unknown-condition errors for legitimate gate transitions; it now skips the sentinel. (da03675)

### Documentation

- **Hot-reload reference-search index documented** — Documents that `reference_search` keeps no module-level cache: its index is a per-tool-instance closure snapshot rebuilt by the dispatch-service restart cascade, so no `invalidateReferenceIndex()` hook is needed, and that the restart is awaited so the reload tool only reports completion once dispatch is fresh — no "Agent not found" race after reload. (8699f5d)

### Tests

- **Adversarial graph construction covered** — Models build graphs incrementally through the graph tools at runtime; these tests pin how the tool layer and engine reject, warn, or degrade on adversarial shapes a model can construct: construction rejection + atomicity, warning pass-through (`dry_run` only), degenerate topologies (empty graph, pure cycle, self-loop, orphan), loop-group pathologies, fan-in/out scale, duplicate edges, and retry-cap semantics, plus a reusable scripted-dispatch test harness. (a252de2)
- **Real multi-round loop execution proven** — Previous loop tests were mock-heavy: coordinator tests cranked `onWorkerCompleted` directly, fakes returned constant results, and the service mock always created session `test-child` — so the suite could pass without the loop actually iterating across fresh sessions. A stateful `IDispatchAdapter` fake (distinct task-N/session-N per dispatch, fire-once terminated listeners, `completeTask`/`failTask` drivers) now drives the suites: real-execution (locks N rounds for N iterations with pairwise-distinct worker sessions and per-round result identity, inherit/fresh seeding), termination-precedence (cap beats `/stop-loop` at the final boundary, mid-loop cancel, `cancelNow`, worker-error phase), execution-timing (async/double/stale listener fires advance exactly once; completions racing the `_advancing` critical section defer), and service-execution (hook-path E2E where `|loop:2|` creates two distinct worker sessions and injects the completion note, locking `timeoutMs` forwarding). Mutation checks (temporary, restored byte-identical) confirmed the new suite fails when listener registration, session freshness, or cap precedence regress — the legacy suite masked all three. (a57da1f)
- **Sidecar full re-read diagnostic test** — RC-C measurement: verifies whether `messages()`/`status()` on dead or recovered Pi sessions re-read and re-parse the entire sidecar JSONL on every call, with an instrumented `readSession` counter and latency breakdown by event count. (e3acf19)

---

## 1.4.0

### Features

- **Interactive role selection for role-targeting commands** — `rolebox install`, `uninstall`, `info`, and `config` now accept an optional role argument: run them without a role (e.g. `rolebox install`) to enter an interactive picker and choose the role from a searchable list instead of remembering the exact role id. `install` lets you pick the registry (when several are configured) and the role from the registry manifest, then asks for confirmation; `uninstall` asks for confirmation before removing; `info --json` requires an explicit role so the JSON output stays machine-readable; non-TTY invocations fail with a friendly hint naming the explicit form. (043314e)
- **Interactive terminal tool with stable pi session ids** — Adds a single multiplexed `interactive_terminal` tool that drives persistent terminal sessions (REPLs, interactive prompts, and full-screen TUIs when a real PTY is available); sessions stay alive across tool calls via a hybrid backend (node-pty when it can be built, otherwise node:child_process pipes), with a `context.ask()`-gated open plus write/read/resize/close/list actions and documented `\uXXXX` keystroke decoding so control keys can reach TUIs. Also fixes pi session-id resolution in the tool factory: pi's tool-execute context exposes no direct sessionID field, so the per-invocation toolCallId fallback made every call look like a different session and broke owner-scoped state such as interactive terminal sessions; the context's sessionManager now supplies a stable session id. (3690bea)
- **Screen snapshot reads and TUI-hardened terminal sessions** — Adds a lightweight VT100/xterm screen emulator (`screen-buffer.ts`) so terminal reads can return the current rendered screen (like tmux capture-pane) instead of the raw repaint stream — the right view for full-screen TUIs; the emulator also auto-answers terminal queries (cursor position, device attributes, window size) that TUIs block on, and feeds a paint-op count used to auto-detect TUI sessions (`auto` read mode). Write now accepts named keys (`<enter>`, `<ctrl+c>`, `<alt+x>`, f1–f12) via the `keys` arg or `<...>` tokens in data with PTY-aware Enter (`\r` vs `\n`), and lifecycle handling is hardened: SIGTERM-then-SIGKILL after a grace period on close, per-owner session caps, caller-requested session ids, Ctrl-D emulated as EOF on the pipe backend, fast-fail on immediate spawn errors, and honest until-timeout reporting instead of silent empty reads. (0d94280)

---

## 1.3.0

### Features

- **All sync targets reported in status and info** — `status` and `info` now iterate the platform registry and report opencode, pi, and dsh as separate sync targets, each with its own sync target dir, synced role count, skill symlink integrity, and (where the host offers a detectable mechanism) integration/registration status; JSON output gains a `targets` array (status) and `syncTargets` array (info) while the legacy top-level `opencode` field is retained for backward compatibility, and hints are registry-driven so only targets actually in use nag. (2310dfd)
- **Pi and dsh as CLI sync targets** — `rolebox sync` previously rejected any target other than opencode, so roles could not be deployed to the other harnesses; it now resolves through the PlatformPaths registry (pi → `~/.pi/agent`, dsh → `$DSH_HOME` / `~/.dsh`) and `uninstall` sweeps symlinks across every sync target, since a role may have been deployed to any harness. (60dd5d3)
- **Pi extension routed through the pi home directory** — The pi extension hardcoded `platformId: "opencode"`, so it borrowed opencode's config tree (`~/.config/opencode`) and never scanned the pi home (`~/.pi/agent`); it now routes through `piPlatformPaths` and honors pi's documented `PI_CODING_AGENT_DIR` override (blank treated as unset, like `DSH_HOME`). (43ff888)

### Bug Fixes

- **Silent notifications delivered immediately on Pi** — `noReply: true` mapped to `deliverAs: "nextTurn"`, and pi 0.84.2 buffers "nextTurn" messages into `_pendingNextTurnMessages` (injected only with the next user prompt), so every silent system reminder (graph node completed, stall, loop progress) surfaced only on a following turn; these now map to `deliverAs: "followUp"` with `triggerTurn: false`, which appends silently and immediately when idle. (ea2e8fd)
- **Native-separator skill filePath on Windows** — `resolveSkills` stored the forward-slash glob pattern as the resolved skill's `filePath`, but consumers use it for real fs access and path joins (dirname, symlink targets, Pi's `resources_discover`) that must agree with join-built native paths on win32; the pattern is now converted back to native separators via a new `toNativePath` helper before being stored. (43149a4)
- **dsh-web-client bundle built before CI test steps** — `dist/` is gitignored, so the dsh-client-modules seam tests (`tests/dsh-plugin.test.ts`) asserted a missing `dist/dsh-web-client.js` on fresh runners; CI now builds the bundle before running tests. (1e49e23)

### Refactors

- **Platform path resolution centralized** — `src/platform/registry.ts` becomes the single source of truth for host platforms, and factory/utils path resolution routes through `resolvePlatformPaths()`, replacing duplicated switch statements; unknown or omitted platform ids still fall back to opencode. (4048be4)

### Documentation

- **All three harnesses documented** — Adds a harness overview table (opencode / pi / dsh config dirs, role dirs, global skills, env overrides), a full pi extension setup guide, per-harness roles + directory layout sections, and updates the CLI sync reference and model-alias locations. (ff257d7)

### Tests

- **Workspace-cleanup retry in the pi-skills test** — Retry transient Windows EBUSY/EPERM errors while releasing the test workspace, with a bounded retry budget. (a990861)
- **CRLF-tolerant frontmatter parsing in the loop orchestrator test** — `loop.md` frontmatter parsing tolerates a CRLF checkout so the test passes on Windows. (ad892ef)
- **Windows EBUSY cleanup retry in the pi-skills test** — recursive workspace removal now retries with `maxRetries`/`retryDelay` to tolerate transient Windows EBUSY/EPERM on just-closed files. (767e663)

---

## 1.2.0

### Features

- **Role-scoped dispatch concurrency** — Composite concurrency keys (`roleId::model`) now resolve per-key limits from the owning root role's merged dispatch config, so each role's `maxConcurrent` / `syncReservedSlots` apply independently instead of sharing one model-level slot; role-scoped configs are rebuilt on every init (hot-reload included) and propagated into lifecycle deps and the concurrency manager. (d446b85)
- **Open-role cross-role dispatch** — A role.yaml can declare itself open (`open: true`, optional exports) and consuming roles declare `open_roles`, which injects an `<available_public_agents>` block into the consumer prompt so its orchestrator can dispatch graph nodes to the open role (or its exposed subagents) via `graph_add_node`; `src/resolver/open-roles.ts` resolves exports to full subagent ids and unknown exports warn rather than fail, with the schema fully backward compatible. (3ea2482)
- **DeepSeek Harness plugin platform** — Ships a Cordis object plugin entry (rolebox/dsh) that boots the full rolebox runtime on dsh services — role discovery, tool registration, graph dispatch, and loop mode — delivered as a dsh profile bundle; adds `dshPlatformPaths` (`$DSH_HOME` or `~/.dsh`), the dsh adapter suite (agent registrar, dispatch, event bridge, hooks, session, tool factory), and a `NodeDispatchPort` dispatch seam so the dsh path dispatches through `DshDispatchAdapter` while the opencode path stays byte-identical. (2b634a8)
- **Web role-switch adapter (loopback HTTP UI + REST API)** — Adds `DshRoleSwitcher` (per-session active-role state) and `DshRoleSwitchWebServer` (node:http, no new dependencies): a self-contained HTML page plus `GET /api/roles`, `GET/DELETE /api/roles/active`, and `POST /api/roles/switch`, all with a stable `{ ok: false, error }` non-2xx contract; wired into the plugin with `webEnabled` / `webHost` / `webPort` config keys (defaults false / 127.0.0.1 / 8787), with bind failure degrading to a warning. (39925d6)
- **Role-switch dock hydration, clear, and retry** — The dsh role-switch dock hydrates the session's persisted active role on mount and on every sessionId change so the highlight and status seat survive reloads and session switches, adds a clear-to-base row that resets the session to the base agent, and a Retry row that re-runs the last failed switch or clear; failed mutations preserve the previous active state and surface the server error on the status seat. (93482a7)
- **Session-level system-prompt contributions** — The main session now sees the switched role's system prompt: dsh composes the model-facing prompt from its systemPrompt registry, and rolebox registers into it via a new `DshSystemPromptAdapter` (rolebox:role section at order 50, rolebox:context at order 0), resolved per-session through the shared `ActiveRoleRef`; the seam is probed structurally and headless profiles warn-degrade and keep booting. (b6e6bac)
- **Active role applied to spawned subagents** — Subagent spawn requests now carry the parent/origin session id, and `DshAgentRegistrar`'s provider consults the shared per-session active-role holder at spawn time, prepending the active role's system prompt and applying its model override (plus the rolebox context block); absent a sessionId or active role, spawns fall back to the definition's own behavior. (e9eb14c)
- **Event-driven node liveness detection** — Heartbeat-based, tiered anomaly detection replaces sole reliance on wall-clock staleness timeouts: session error/gone events escalate a running node immediately, a `NodeLivenessMonitor` raises a single deduped `[GRAPH NODE STALLED]` warning after `stallWarnMs` without heartbeats, nodes stalled past the grace window escalate through the retry path, and the original `NodeStalenessWatcher` is retained as fallback; heartbeats flow from the platform event bridge through a `NodeLivenessFeed` DI seam, `graph_status` gains `include_liveness`, and all additions are optional (no feed ⇒ byte-identical behavior). (fd77f6a)
- **Pi shared hook pipeline, functions, skills, and tool surface** — The Pi extension reaches feature parity with the opencode plugin by routing through the shared rolebox pipeline: `hook-pipeline.ts` assembles the full `HookDeps` and routes `PiEventBridge.emit` → `handleEvent`, chat-activation runs `handleChatMessage` for `|fn|` activation and auto_activate, system-transform injects function/gate/role-memory/graph state into the before_agent_start prompt, tool-interceptor wraps every compiled tool with zod validation and custom-hook phases, skills are registered per role, and the surface is pinned by `tests/pi-parity.test.ts` (69-tool surface). (bd3e687)
- **Filesystem-backed session fork on Pi** — Pi's `fork()` now copies the source session's JSONL to a new id in the same workspace directory, optionally truncating at a given messageID, and returns a fresh `SessionInfo` with `parentID` set; previously it always returned null on Pi. (c23399a)
- **Live graph runtime threaded into the Pi service stack** — The live dispatchManager, graph-notify session client, and engine-state stateDir are passed into `PiLightweightServiceStack` so `graph_*` tools register on the Pi surface and engines persist state under `.rolebox/state`; absent a manager, the legacy stub/override-only surface is unchanged. (700cbca)

### Bug Fixes

- **Config-bearing primary role preferred** — With multiple roles declaring `mode: primary`, the old alphabetical-first pick silently discarded the config-bearing role's dispatch limits (e.g. ai-designer winning over emperor and leaving manager-wide concurrency at defaults); the first config-bearing primary in resolvedRoles order now wins, with a warning when multiple primaries exist. (68cc91f)
- **Per-parent cap lifted for graph node dispatch** — `graphParentContext` now carries `maxActivePerParent: Infinity`, and the task-launcher derives the per-parent cap from the context: a graph's nodes all share `parentSessionId = graphId`, so the dispatch config's per-parent default (3) throttled them merely for sharing that parent, while node concurrency is actually engine-managed. (01c9efa)
- **False-positive node liveness stalls fixed** — The event-driven liveness monitor hard-stalled healthy nodes: dispatched subagent activity never refreshed `lastActivityAt`, so any node running past the 90s warn+grace deadline was escalated and timed out; child-process activity is now relayed as throttled heartbeats, a liveness feed is threaded into the opencode `GraphToolSet`, and a dispatch-liveness probe refreshes quiet-but-alive subagents while hung-but-alive nodes still fall to the wall-clock backstop. (31fe435)
- **Graph engine dispatch and recovery hardening** — A throwing `executeNode` now marks the node terminal (timeout/escalate) while the remaining frontier still dispatches; unhandled promise rejections are eliminated via contained critical sections and caught advancement sites; `graph_run` failure is atomic (no double dispatch, no ghost `[GRAPH COMPLETE]`); state-file hydration is total (invalid v2 files return null and surface in the startup sweep instead of poisoning recovery); and a dangling loop group is closed by clearing `loopGroupId` when the declaration dropped the group. (5a204c8)
- **Graph-engine stall paths eliminated** — Six fixes close windows where a graph could stay in `executing` without advancing: dispatch-layer HITL statuses are bridged into the pausing `need_approval` signal so `[GRAPH BLOCKED]` fires, the runtime deadlock guard is relaxed for never-activatable incoming edges, the stale-node watcher (15 min) and stale-lock sweeper (60 s) are enabled by default, and silent graph-notify no-ops become explicit degradation warnings with a durable `notification_degraded` event marker. (34045e9)
- **Observability overhaul to reflect real engine state** — Fixes the monitor gaps from the engine observability audit: recovery engines gain notification/event seams, checkpointHistory survives hydrate/adopt, `cancel()` is no longer silent, graph notifiers retry 3× instead of being single-shot, node-level `budget.timeout_ms` reaches dispatch tasks, an opt-in `NodeStalenessWatcher` guards zombie running nodes, engine rebuilds dispose orphaned listeners, snapshots deep-clone signal/loop state, json graph view honors `include_output` and pagination, and silent escalations now emit node-completion events. (55e7dfd)
- **Auto-continue counter stopped while graphs execute** — After a non-blocking graph_run, session.idle saw zero dispatches (graph nodes parent to graphId, not the emperor session) so auto-continue fired on every idle and the counter climbed; `GraphToolSet.hasInflightGraphsForSession()` now suppresses auto-continue while the session owns an executing graph, a shared `GraphToolSet` is threaded into `HookDeps` on both assembly paths, and `signal_observed` falls back to `sessionSignalLedger` when the per-function ledger misses. (5b026a5)
- **Portable LSP PATH lookup** — Added a PATH and PATHEXT walk for Node-hosted dsh/Pi integrations. (2acb049)

### Refactors

- **Loopback web server replaced with host route + browser client** — The self-contained loopback HTTP server (node:http) is replaced with a prefix route registered on dsh's own host webserver through the optional `webServer` seam, plus a browser `dsh.client` slot plugin that mounts a role-switch dock into `conversation.input.dock`; the REST surface is renamed `/api/*` → `/rolebox/*`, the client is bundled as a CJS ModuleLoader envelope (id `rolebox/dsh`), and the `webEnabled` / `webHost` / `webPort` config keys are removed — the web UI auto-mounts in the web profile, headless profiles register no routes. (f8c5482)

---

## 1.1.0

### Features

- **Narrow-sidebar layout module with truncation helpers** — Adds a pure `src/tui/layout.ts` module (no opentui/solid or solid-js imports) as the single source of truth for narrow-sidebar layout constants and helpers: `SIDEBAR_WIDTH=40`, `RULE_WIDTH_NARROW=28`, `INDENT`, `GLYPH_CELLS=1`, `VALUE_BUDGET=22`, plus `valueBudget()` and `labelValue()` that compose dimmed `label: value` rows and truncate long values to a `SIDEBAR_WIDTH`-derived budget. Ships `tests/tui/layout.test.ts` covering both helpers and edge cases (zero/negative budget, exact-fit, and overflowing values). (9c0468f)

### Bug Fixes

- **Graph `graph_run` idempotency for completed graphs** — A redundant `graph_run` (no `node_id`) on an already-complete graph now short-circuits (phase Complete, no Ready/Running/Blocked/Pending node), returning the current status instead of rebuilding a fresh engine and re-firing `[GRAPH COMPLETE]` on every re-run; targeted retry (`node_id` + `retry`/`modify_prompt`) stays exempt and still fires exactly one new COMPLETE. Also reuses the graph-create-captured sticky invoking-session id across mid-flight rebuilds so the graph-notify emperor-session resolver never degrades to a no-op seam. (60f19df)
- **Loop-convergence forwarding, self-loop re-entry, and non-loop cascade-cancel** — Answer forwarding now depends on loop outcome: `_forwardActivation` only runs when the loop step outcome is `converged`, so a downgraded answer (revising/stuck/max-traversals-exhausted) no longer wrongly forward-activates downstream nodes while the loop is still churning. `_forwardActivation` skips self-loop edges so a single-point always self-loop can never re-enter itself even when built bypassing validation. Non-loop fan-in now cascade-cancels still-pending sibling upstreams (mirroring the loop-group executor), guarded by a shared-upstream check so an upstream still needed by another unresolved downstream is never retired. (1213f1e)
- **Ready→escalate transition and frontier cleanup** — The budget pre-check in `_dispatchNode` calls `markEscalated` on a Ready node before `markRunning`, but `ready → escalate` was not a legal transition, so an over-budget graph threw `Invalid node transition: ready -> escalate` and stranded the node in Ready. `ready` now allows `[Running, Cancelled, Escalate]`, and an escalated budget-exceeded node is removed from the frontier so it does not linger as a stale ready entry. Adds a legal-transition assertion and a regression test. (1e3483e)
- **Runtime deadlock detection for rootless/unprotected graphs** — A graph where every node has in-degree ≥ 1 and no loop-group protection used to provision with an empty frontier, dispatch nothing, and sit in Executing forever because `checkGraphTermination` tallied Pending nodes as scheduler-active. It now separates Ready/Running from Pending and adds a deadlock terminal: an Executing graph with pending node(s), no Running/Ready/Blocked node, no escalated/timeout error, and an empty `pendingCompletions` queue escalates every pending node (`graph deadlock: no active upstream can satisfy pending node(s)`) and completes. Negative tests confirm no false trigger on normal or blocked graphs. (f2447da)
- **Validator loop-group root alignment with the engine + overlap rejection** — `checkLoopGroupRoots` now applies the same intra-loop-group always-edge exclusion as the engine's `computeInDegrees`/`getRootNodeIds` (inline helper, respecting the no-import-from-engine layering rule), so always-cycle loop groups are accepted instead of being misrejected as unreachable deadlocks. A new fatal `checkLoopGroupOverlap` rule rejects any node appearing in more than one loop group, surfacing the single-slot `loopGroupId` overwrite ambiguity. (7a5beef)
- **Dispatch liveness and in-flight-tool guards against false terminal/idle states** — The completion detector evaluates the tool-in-flight guard before idle/error/completed decisions so a transient error or stale status never latches a terminal result while a model tool is still running. The completion evaluator re-verifies session liveness (existence + status + recent message activity) before committing an error/deleted/fetch-failure transition and cancels the idle debounce when a tool is in flight. Engine recovery/advance skip a stale `error` escalate when the authoritative task read still shows the task live (running/pending/awaiting_approval) and re-subscribe so a genuine later termination still advances the node. Pi adapters return `busy` (not idle) while the last message has a pending/running tool part; monitor + TUI derive the effective engine phase as executing whenever any node is running, eliminating false idle/running flicker. (d491090)
- **LSP executable lookup** — Avoided Windows stderr noise while locating language-server binaries. (bff4377)
- **CI frozen-lockfile install** — Enforced the checked-in dependency resolution during CI installation. (03e8545)
- **Windows portability fixes** — Resolves 161 Windows-only test failures while keeping macOS/Linux green: skill-resolver joins no longer produce backslash patterns that never match fast-glob's forward-slash match set (skills now resolve on win32), `getDataDir`/`getConfigDir` honor `XDG_*` on the win32 branch, the document manager emits RFC-8089 file URIs (drive-letter colon no longer percent-encoded), frontmatter parsing normalizes CRLF bodies, quarantine derives dest filenames from backslash paths correctly, and directory symlinks are created with an explicit type to avoid EPERM on un-elevated win32. Adds shared helpers (`toPosixPath`, junction-aware `createDirSymlink`/`createFileSymlink`/`isSymlink`) and platform-neutral test hardening. (bbe8309)
- **Windows skill resolution and symlink portability** — `resolveSkills` normalizes candidate patterns via `toPosixPath` before passing them to fast-glob (which only officially supports forward-slash patterns), so skills no longer resolve to nothing on win32 and `<available_skills>` blocks plus subagent skill symlinks are preserved. Win32 junction/file symlink targets are normalized to native separators with `path.win32.resolve`, and win32-hardened test fixtures are added. (7bafd04)
- **Test-module isolation against shared-process mock leakage** — Used distinct module specifiers to protect real filesystem and registry-client tests from mocks registered by other files. (e3114f8)
- **TUI sidebar-state tsc fixes** — Resolves four pre-existing type errors in `src/tui/state.tsx` surfaced by the TUI typecheck gate while validating the narrow-sidebar redesign: `new Set<string>()` (TS2769), `LoopSnapshot.fnName` cast to `{ fnName?: string }` (TS2339), `dispatchSummary.errors` → `dispatchSummary.error` matching the `DispatchSummary` field (TS2551), and `createSidebarRenderer` ctx typed as `TuiSlotContext` with `tc()` casting `ctx.theme.current` to `ThemeColors` (TS2769). (9b52659)

### Refactors

- **Vertical-stack narrow-sidebar layout and 1-cell glyphs** — The TUI is restructured for opencode's sidebar slot so information stacks vertically (one primary fact per row; secondary facts move to dimmed, indented rows with lowercase `label: ` prefixes; long values truncated via the new layout module): `renderDispatchRow`/`renderFunctionLine` become primary glyph+agent rows with secondary duration/liveness, description, progress stage, and session rows; graph/engine renderers list one node per row with iteration, `terminationReason`, `liveSignal`, and budget on their own rows; the loop line splits into an agent row and an N/M + bar progress row; the header rule width narrows to `RULE_WIDTH_NARROW` (28); pulse concurrency active/limit and queue depth move off the health line onto a dim secondary row; TaskDetail splits status into glyph+agent/duration/liveness and `[← Back]` becomes `[Back]`; MetricsPanel/RecoveryStatus/FilterBar split into one-fact-per-row. All status glyphs shrink to a single display cell (no wide/emoji/arrow glyphs): `G_RUNNING ▸→•`, `G_PENDING ●→·`, `G_GATED ⏸→·`, `G_SUB └─→·`, `G_STALLED ⚠→!`, `G_FN` dropped (function lines convey state via color). (7e34e6d)

### Tests

- **Environment-dependent test gating** — LSP auto-detection tests are gated on `typescript-language-server` availability and real-server integration tests on the opencode binary (new `hasOpencode` helper mirroring `hasTar`), so the CI suite passes on runners without developer-machine binaries; the fetch-failure escalation test is de-flaked by replacing a never-resolving messages mock with an immediate `TimeoutError` rejection. (db060e1)
- **Test-file isolation** — Isolated the core suite, separated TUI tests and added ordered and randomized checks for module-mock leakage. (d93f7a4)
- **Drop cache-busted module imports** — Removed redundant imports and mock re-registration after enabling per-file module isolation. (c8bfb62)
- **CLI cache test fresh `Response` per fetch** — A `Response` body can only be consumed once; a single hoisted Response made the TTL cache test fail for the wrong reason if the cache ever missed on the second fetch. The test now builds a fresh `Response` per fetch call instead. (e40917c)
- **Order-independent signal-session-survival tests** — Gave each test its own session ID and assertions over only its own records. (e887b21)

---

## 1.0.0

### Breaking Changes

- **v1 graph subsystem decommission** — The v1 graph execution subsystem is removed. `src/graph/parser.ts` is deleted and the `advance` / `state` / `graph-store` / `converter` / `parser` / `validator` modules are ported into `collaboration-*` modules (`collaboration-advance` / `collaboration-state` / `collaboration-store` / `collaboration-bridge` / `collaboration-validator`), persisted to the new `collaboration-{hash}.json` state path. The orchestrator, migration, and termination-conditions consumers are re-pointed, the v1 barrel re-exports are removed, and 22 test files are migrated off v1 imports. See `docs/graph-legacy-v1-decommission.md`.
- **Graph-first orchestration / tool-surface consolidation** — Subagent collaboration now routes through the v2 graph engine (`graph_create` / `graph_add_node` / `graph_run`). The bare model-facing `dispatch_*` / `loop_*` tools and the checkpoint / budget / concurrency / query suites are retired in favor of a thin `task_*` compatibility layer (`task-tools.ts`), and the `function_state` tool is removed. Graph orchestration enforces budget accounting, approval gates, and loop caps on every dispatch.

### Features

- **Graph Execution Engine v2** — A new `src/graph/engine/*` subsystem implements node lifecycle, join evaluation (`any` / `quorum` / `all`), condition resolution, signal propagation, cascade cancellation, node retry, an approval handler, a loop-group executor, and engine persistence / recovery / startup. Added the v1→v2 converter, `parser-v2`, `serialize`, and `validator-v2`, plus the imperative `graph_*` toolset (`graph_create` / `graph_add_node` / `graph_add_edge` / `graph_add_loop` / `graph_run` / `graph_status` / `graph_cancel` / `graph_approve`) backed by `graph_status` flags and the `JoinStrategy` / `EnginePhase` / `NodeStatus` constants. See `docs/graph-engine-architecture.md`.
- **Graph monitoring (engine write-side event log)** — The graph execution engine now records an append-only, durable NDJSON event log (`graph-events-{hash}.ndjson`) for every write-side transition it performs — node dispatch, node terminal transition (`answer` / `revise_needed` / `escalate` / `timeout`), engine phase change, and cumulative budget update. `GraphEventRecorder` is a total (never-throws), no-op-safe seam: with no `stateDir` configured no recorder is constructed and the engine behaves exactly as before. The recorder's phase/budget sinks are registered on construction so the engine's pure transition functions reach it without an import cycle.
- **Graph terminal notification seam** — The engine exposes an `onGraphTerminal` callback that fires exactly once per terminal transition (`GRAPH COMPLETE` / `GRAPH BLOCKED`), wired through a `graph-notify` platform seam that injects `<system-reminder>` markers into the orchestrator session to wake result collection. Per-node completion is surfaced through the engine node-completion seam and notifier.
- **Engine v2 signal-ledger origin tracking and two-tier persistence** — Engine state records a signal-ledger origin-source discriminator and terminal-state dedupe, persists via a debounced non-critical save plus flush-on-terminate (two-tier durability), captures per-node usage at termination paths, and re-uses the live runtime mid-flight in `graph_run`.
- **Prior-state adoption for incremental graph rebuild** — `adoptPriorNodeStates()` copies a prior engine run's per-node progress onto a freshly provisioned state so the imperative `graph_*` toolset can rebuild the engine after every mutation without resetting completed/running nodes; `EngineRuntime.adoptPrior()` reconciles adopted running nodes against the dispatch system and replays answer forward-flow.
- **Bounded backstop and node result capture for gated functions** — `signal(type="blocked")` sets a `blockedAt` + default 2-minute timeout that force-unblocks on expiry, and dispatch notifications / HITL approvals reset gated functions to active; `_captureNodeResult()` reads the dispatch task result onto node runtime state after completion (`answer` / `revise_needed` / approval paths).
- **Data-mapping fields include-whitelist** — `DataMapping.fields` adds a top-level JSON key include-whitelist (`keepJsonKeys`) applied before the existing exclude/key-stripping transform during edge data passthrough.
- **Terminal-state checker extraction** — Terminal-state detection is extracted into a shared `engine-termination` module with an exposed `resetTerminalDedupe`, consolidating COMPLETE/BLOCKED firing logic.
- **Monitor reads engine graphs and graph events** — `monitor` now surfaces the engine (v2) persisted state (`engine-*.json`) as rich `EngineGraphSnapshot`s (phase, per-node lifecycle, budget, frontier, loop groups, checkpoints) via `readEngineGraphs`, and reads back the last N graph events from the event log via `readGraphEvents`. Both are wired unfiltered into `MonitorSnapshot` (`engineGraphs` / `graphEvents`) — engine graphs are multi-agent primitives whose `graphId` never equals a dispatch task's `sessionId`, so the legacy live-session filter is deliberately not applied to them.
- **CLI Graphs panel and TUI sidebar activity** — The monitor renderer gained a `Graphs` panel (phase glyph, per-status node counts, budget/frontier, and recent node signals correlated by `graphId`), emitted between Orchestration and Tasks. The TUI sidebar surfaces engine-graph activity with per-node status glyphs, live signal from graph events, and cumulative budget, plus an incremental `GraphEventPoll` that maps NDJSON event lines onto `graph_node_start` / `graph_node_end` / `graph_signal` events with a monotonic per-file offset (no double-emits, no re-reads). `GraphNodeSnapshot` exposes `dispatchTaskId` / `dispatchSessionId`, and the TUI session scope is supplemented with engine-graph dispatch session IDs.
- **Loop tree-worker infrastructure** — The loop coordinator gains ancestor-chain prompt-fingerprint dedup, a `MAX_TREE_WORKER_SESSIONS` (30) registration-time budget, recursive `cancelNow()` cascade to child loops, a `CONSECUTIVE_STALE_THRESHOLD` (2) stall guard, and new `LoopState` fields (`objective`, `promptFingerprint`, `parentLoopId`, `consecutiveStaleRounds`).
- **Loop store v3 with backward compatibility** — The loop store accepts schema versions 1–3 (was strict v1), auto-migrates v1/v2 records by filling absent optional fields, and persists the new v3 fields.
- **`loop_start` and loop management tools** — `loop_start` (renamed from `createLoopTool`) gains required `prompt` / optional `objective` args and is registered as a canonical tool, alongside `loop_status` / `loop_output` / `loop_history` / `loop_list` management tools wired into `ToolService` with graceful degradation when `LoopService` is unavailable.
- **Pi 0.81.x JSON event vocabulary + loop integration** — `process-session` handles the Pi 0.81.x event vocabulary (`message_start` / `update` / `end`, `turn_end`, `tool_execution_*`) and drives completion from `turn_end` instead of process exit (fixing indefinitely-idling children); the loop coordinator is wired into the Pi extension with persistence, recovery, lifecycle handlers, `/stop-loop`, and child model resolution.
- **In-session role switching via `/role`** — Pi (which has no native agent picker) now surfaces rolebox roles as switchable primary agents via a `/role` command, selector UI, and `Ctrl+Shift+R` shortcut, gated by the `hasRoleSwitch` capability and driven by the `AgentDefinition` registry.
- **Active-agent ref for dispatch direct-child gate** — A shared mutable `activeAgentRef` bridges Pi's platform model (which never populates `context.agent`) to the dispatch tool's direct-child gate; it is seeded from `ROLEBOX_ACTIVE_AGENT` and passed as an external `getEffectiveAgent` resolver so nested sub-agent dispatch resolves correctly.
- **Session-level signal ledger** — Signals recorded by `signal-tool` now survive even in bare subagent sessions with no active functions via `SessionSignalLedger`; completion evaluation and engine recovery fall back to the ledger, and a `SYNTHETIC_ANSWER_SIGNAL` marker distinguishes framework-generated signals from real sub-agent signals.
- **Centralized signal constants** — The signal-type vocabulary (`SIGNAL_TYPES`, `TERMINATING_SIGNALS`, `PAUSING_SIGNALS`, `HANDOFF_SIGNALS`, `INFO_SIGNALS`, `SignalType`) is extracted into `src/signal/signal-constants.ts` as a single source of truth shared by `signal-tool` and the engine signal bridge.
- **Memory database driver and async factory** — Added a shared `DatabaseDriver` abstraction and converted memory CLI and context consumers to the async factory.
- **Portable filesystem utilities** — Added `readTextFile()` and `fileExists()` using `node:fs/promises`, SHA-1 hashing with `node:crypto`, and subprocess execution through `node:child_process`.
- **`rolebox migrate` CLI command** — A new `migrate` command backed by the registry client for running migrations.
- **Install/update progress output** — `rolebox install` and `rolebox update` now emit live download progress (`DownloadProgress` renderer): named phases (`resolving` / `downloading` / `verifying` / `extracting` / `installing` / `done`) with a determinate byte-progress bar on interactive TTYs (via `response.body` streaming) or throttled plain lines in degraded mode (non-TTY, `CI`, `TERM=dumb`). New `--quiet` / `-q`, `--verbose` / `-v`, and `--no-progress` flags on both commands, honoring `NO_COLOR`. See `docs/audit-progress-ui.md`.
- **Role path / env overrides** — `getDataDir` / `getConfigDir` now honor `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` env overrides ahead of platform defaults, with explicit win32 (`%LOCALAPPDATA%` / `%APPDATA%`) and darwin branches, plus writability pre-checks (`ensureWritableDir`) that fail with an actionable message. `roleId` / `registry` / `version` are validated by `assertSafePathSegment` (rejects path separators, `..` traversal, leading dots, Windows-invalid characters and reserved device names), closing the arbitrary-delete/traversal vector into `rmSync`. See `docs/audit-install-update-platform.md`.
- **Hardened download + atomic install** — `downloadRole` now streams the tarball to disk with a per-attempt timeout (`AbortController`) and bounded retry with exponential backoff, detects truncated bodies via `Content-Length`, and validates extracted entries against zip-slip / path-traversal escaping the extract dir. Install/update extract into a temp location first and atomically swap into place (with rollback: a failed new-version install leaves the previously-installed version and lock intact). Manifest-declared integrity digests are now verified when present. See `docs/audit-install-update-platform.md`.
- **CI platform matrix** — Added Linux, macOS and Windows typecheck, build and test jobs. Real-tar tests skip on hosts without `tar`.

### Bug Fixes

- **Dispatch fast-fail on null prompt result** — A `null` return from `client.prompt()` (Pi spawn failure) now transitions the task to `error` immediately — releasing the concurrency slot, notifying the parent — instead of leaving it `running` forever; the opencode session adapter's HTTP 204-void contract is corrected so a successful async prompt is no longer misread as a spawn failure.
- **Pi dispatch completion through the event bridge** — Synthetic `session.idle` / `session.error` events are emitted on Pi child-process exit / spawn failure so the dispatch completion pipeline triggers immediately instead of waiting for the watchdog timeout.
- **Terminating signals preserved across dispatch→engine bridge** — Real signal types (e.g. `revise_needed`) from loop-group sub-agents are now passed through the dispatch→engine bridge instead of being collapsed to `completed`, so loop back-edges keyed on `revise_needed` activate correctly.
- **Loop entry deadlock from revise back-edges** — `join-evaluator` excludes revision back-edges from in-degree on the first loop-group traversal so a loop entry node with only a `revise_needed` back-edge satisfies its join instead of deadlocking.
- **Always-edge loop-group traversal bound and pure-cycle deadlock** — Always-edge re-entries in a loop group consume a traversal (escalating at the cap), intra-loop-group always-edges are excluded from in-degree during provisioning so pure cycles (A⇄B) no longer deadlock, and `__inferred` synthetic answers prevent downgrade to `revise_needed` infinite spin.
- **Graph lifecycle robustness** — `provision()` routes root nodes through `markReady`, retry records a checkpoint before resetting downstream nodes, `Cancelled→Done` transitions use `markDone`, approval replay returns `already_resolved` with `actualStatus`, and `adopt-prior` re-runs in-degree reconciliation to demote stale-ready nodes.
- **Loop `Done` status for termination** — Loop-group termination paths (`max_traversals` exhausted, stuck) use `markDone` instead of `markEscalated`, giving clean Done/Done separation, with per-node traversal counting for diagnostics.
- **Memory/fs semantics** — `MemoryStore` `run()` spreads zero-arg params, and `fileExists` rethrows on unprobeable paths instead of silently reporting `false` (only `ENOENT` means absent).
- **Memory delete non-interactive confirmation** — `rolebox memory delete` requires `--yes` when stdin is not a TTY instead of blocking on `prompt()`.
- **Timer `unref` to prevent event-loop hang** — Guard, heartbeat and sweeper timers no longer keep the host process alive on their own.

### Refactors

- **v1 graph → collaboration module port** — v1 execution semantics are ported into `collaboration-*` modules under a new `collaboration-{hash}.json` path, with consumers, the orchestrator, migration, and termination-conditions re-pointed and v1 shims removed.
- **EngineState threaded through lifecycle** — `EngineState` is threaded through the graph lifecycle with dirty-flag persistence, and convergence stuck-detection is consolidated into `propagateRevise`; event sinks move from module globals to `EngineState` instance fields, and `materializedAt` changes from ISO string to epoch ms.
- **Memory async factory refactor** — All `MemoryStore` callers migrate from synchronous `new MemoryStore()` to the async `MemoryStore.create()` factory, and the memory clean command switches its direct SQL query to the cross-runtime `createDatabase()`.
- **TUI error-logging cleanup** — Empty catch blocks in the TUI event bridge are replaced with `console.warn` logging so headless-mode failures are diagnosable.

### Documentation

- **Graph Engine v2 architecture** — Added `docs/graph-engine-architecture.md` documenting the v2 engine design, two-tier persistence, and recovery.
- **v1 graph decommission** — Added `docs/graph-legacy-v1-decommission.md` covering the v1 subsystem removal and the `collaboration-*` migration.
- **Subagent `graph_run` instructions** — Subagent guidance updated to describe `graph_run` as non-blocking: dispatch ready nodes, end the turn, and await the `[GRAPH COMPLETE]` / `[GRAPH BLOCKED]` system-reminder before reading results via `graph_status`.

### Tests

- **Graph terminal notification end-to-end** — Added `tests/graph/engine-terminal.test.ts` verifying the `onGraphTerminal` seam fires exactly once per terminal type with correct `graphId` / phase / node-status summaries.
- **Graph monitoring end-to-end chain** — Added a cross-cutting integration test (`tests/monitor/graph-monitoring-chain.test.ts`) driving the real write-side primitives (`GraphEventRecorder` + `EnginePersistence`) through the full pipeline: readers (`engineGraphs` / `graphEvents` snapshot fields) → `renderHuman` Graphs panel → TUI `GraphEventPoll` and `computeFilteredActivity`.
- **Loop integration updates** — Integration tests updated for same-origin loop exclusivity semantics (nested-loop rejection → `loop already active for this session`).
- **Memory async factory tests** — Memory test helpers and setup blocks converted to the async `MemoryStore.create()` pattern.
- **Real download/extraction coverage** — Added `tests/cli/commands/install-realtime.test.ts` exercising the real (non-mocked) `downloadRole` → `tar xzf` → atomic-place path through `install()`, plus new win32-branch unit tests for `paths.ts` (`%LOCALAPPDATA%` / `%APPDATA%` resolution and `getRolePath` sanitization under a simulated platform via the `getPlatform` / `setPlatformForTest` seam). Real-tar tests across `registry-client.test.ts`, `download-progress-streaming.test.ts`, and the new command-level test are guarded by `tests/helpers/tar.ts` and skip gracefully on hosts without `tar`.

### Resolved vs deferred audit gaps

- **CI platform matrix** — Added Linux, macOS and Windows typecheck, build and test jobs. Real-tar tests skip on hosts without `tar`.

---

## 0.24.0

### Breaking Changes

- **`task_*` → `dispatch_*` tool rename** — All dispatch introspection tools renamed: `task_search` → `dispatch_search`, `task_status` → `dispatch_status`, `task_output` → `dispatch_output`, `task_concurrency` → `dispatch_concurrency`, `task_chronology` → `dispatch_chronology`, `task_export` → `dispatch_export`, `task_budget` → `dispatch_budget`, `task_graph` → `dispatch_graph`, `task_retry` → `dispatch_retry`. Old names preserved via deprecation aliases.

### Features

- **Priority scheduling and HITL approval gate** — Dispatch tasks now support priority-based scheduling. Human-in-the-loop approval gate: workers signal `need_approval`, tasks pause in `awaiting_approval` state, emperor can `dispatch_approve` or `dispatch_reject`.
- **Dispose lifecycle and O(1) inflight wiring** — New `dispose()` lifecycle method on dispatch manager for clean shutdown. Inflight tracking refactored from O(n) scans to O(1) `inflightByParent` map lookups.
- **Signal tool wired into function state machine** — The `signal` tool now integrates with the function state machine, enabling signal-based state transitions (`answer`, `revise_needed`, `need_approval`, etc.).
- **Model alias fallback resolution** — Resolver now supports model alias fallback at load time, allowing roles to reference model aliases that resolve to concrete models.
- **JSON output format for query/search tools** — `dispatch_search`, `asset_search`, `reference_search`, `memory_recall`, and `session_search` now support a `format` parameter (`markdown` or `json`) for machine-parseable output.

### Performance

- **Incremental hot-reload with change classification** — Hot-reload now classifies file changes and only rebuilds what changed, avoiding full reloads on minor edits.
- **Streaming sidecar result windows** — Large dispatch results are now streamed from disk in windows instead of loading entirely into memory.
- **Batch fast-glob and parallel subagent resolution** — Resolver batches `fast-glob` calls and parallelizes subagent resolution for faster startup.
- **Asset search index cache** — Asset search results are cached with async file check and LRU guard, eliminating redundant filesystem scans.

### Bug Fixes

- **Stale lock recovery and error suppression** — Resolved stale lock recovery blocking, silent error suppression, and continuation rollback issues in core services.
- **Loop deadlock prevention** — Added 30s lock sweeper for `_advancing` deadlock prevention in loop coordinator.
- **Parent-task index and budget persistence** — Added parent-task index, fixed budget persistence across restarts, and debounced loop store writes.
- **Checkpoint FIFO cap and serialization** — Fixed checkpoint FIFO cap enforcement, incremental `readOriginSummary`, and serialization edge cases.
- **Abort worker sessions and concurrency queue** — Fixed abort handling for worker sessions and concurrency queue promotion logic.
- **Path-traversal, recursion guard, dead params** — Hardened `dispatch_*` tools against path traversal, added recursion guard, removed dead parameters, and added security tests.
- **EXDEV cross-device rename** — Fixed `EXDEV` cross-device rename errors in CLI install/update by using copy+delete fallback.
- **Postinstall guard for CI** — Guarded postinstall script against missing `dist/` directory in CI environments.

### Refactors

- **Platform abstraction updates** — Extended platform ports with model/compact interfaces, added event bridge, updated adapters. Decoupled core services from SDK types via event canonicalization. Updated recovery, resolver, and utilities for platform abstraction.
- **Deprecation infrastructure** — Added deprecation infrastructure for tools, removed old aliases, improved tool descriptions.

### Documentation

- **README restructure** — Restructured README for readability and added demo GIFs.

### Tests

- **Platform abstraction tests** — Updated test suites for platform abstraction changes.

---

## 0.23.2

### Bug Fixes

- **README banner image** — Use HEAD ref for banner image to support all branches.

---

## 0.23.1

### Bug Fixes

- **CLI package.json path** — Resolve package.json path from correct depth in compiled binary.

---

## 0.23.0

### Features

- **TUI mouse interactions** — Click-to-select sessions, task rows, and filter options in the monitor. Keybindings updated to `Ctrl+` prefix to avoid conflicts.
- **TUI filters, metrics panel, and live event bridge** — New filter bar (session ID, status, agent), real-time metrics panel, and event-driven live updates in `rolebox monitor`.
- **Dispatch checkpoint and progress** — New checkpoint persistence (`dispatch_checkpoint`) and progress reporting (`dispatch_progress`) tools integrated into lifecycle hooks. Progress data displayed in both CLI and TUI. Failed tasks can be retried with checkpoint context automatically injected.
- **Project-level config** — `rolebox` now loads `.rolebox/config.json` from the project root to set a default role per project.

### Bug Fixes

- **SSRF guard improvements** — Block link-local (`169.254.x.x`) addresses in `web_fetch` in addition to existing private/localhost blocks. Applied to `web_read` (page-read tool) as well.
- **Loop idle bridging** — Replace poll-based idle detection with push-chain driven by `onTaskTerminated` event, eliminating the polling window between loop rounds.
- **Hot-reload stability** — Break infinite self-triggering loop and eliminate `EEXIST` symlink errors during asset reload.
- **Function merging** — Merge role-defined functions with built-in defaults instead of replacing them, preserving default capabilities when roles specify custom functions.
- **Memory validation** — Validate `category` and `relevance` fields in `memory_write` and `memory_update` with Zod enum at runtime instead of accepting arbitrary values.
- **Dispatch error hardening** — Robust error handling in sync dispatch and dispatch output tools; log watchdog errors and clean up emitted thresholds when a task leaves.
- **Dispatch adapter** — Accept configurable directory path in `DispatchAdapter` constructor instead of hard-coding.
- **TUI** — Restore missing `onCleanup` closing brace accidentally dropped during refactoring.
- **Core reliability** — Fix cleanup and race-condition gaps across dispatch, loop, signal, and notification subsystems.

### Refactors

- **Hashline engine** — Per-file content-hash versioning, hashWidth auto-escalation based on line count, trailing newline preservation, and exact-match echo for better editing stability. New `src/shared/hashline/` module.
- **TUI layout** — Compact activity rows (dense session layout), reduced filter bar to 2 lines, inline session IDs to save vertical space.
- **TUI keyboard removal** — Remove all keyboard interaction code, replaced by mouse-click interactions.
- **Codebase coupling** — Reduce coupling and duplication across dispatch, monitor, and tool registration for improved maintainability.

### Tests

- **Full lifecycle integration test** — End-to-end `pi` (plan-incomplete) scenario covering plan creation, partial execution, checkpoint, and cross-session resume.
- **Dispatch, graph, and loop edge cases** — Coverage for checkpoint and progress unit/integration tests, dispatch notification recovery, graph visualization edge cases, and loop coordination.
- **Integration tests** — End-to-end tests for dispatch, loop coordination, signal tool, and cross-session behavior.
- **Hooks pipeline** — Test coverage for the hooks/lifecycle pipeline.
- **Core services, CLI, LSP, and session** — Coverage for core service initialization, CLI command parsing, LSP integration, and session lifecycle.
- **Asset tools and validation** — Test coverage for asset inspection, search, validation, and hot-reload.
- **Web tools** — Test coverage for web fetching and reading tools, including SSRF guard behavior.


## 0.22.0

### Features

- **`web_fetch` tool** — New content-fetching tool with multiple rendering backends: browser (Playwright), crawlee, Jina Reader, and Mozilla Readability article extraction. Includes built-in SSRF protection, MIME detection, metadata extraction, and Cloudflare challenge retry. New `src/web/web-fetch.ts` and supporting modules.
- **Platform abstraction layer** — New ports-and-adapters architecture decoupling core logic from opencode platform dependencies. `ISessionClient` interface enables testable, swappable session backends. New `src/platform/` module.
- **`plan_incomplete` condition** — New function state machine condition supporting cross-session resume. Detects unchecked plan steps and gates execution flow accordingly.
- **Signal tool and observation infrastructure** — Universal out-of-band signal tool (`|signal|`) for state transitions (completion, approval, handoff, escalation) without embedding signals in text content. New `src/signal/` module.
- **Postinstall welcome banner** — ASCII wordmark displayed after `npm install` for a polished first-run experience.

### Bug Fixes

- **Test mock pollution** — Resolve 20 test failures caused by mock state leaking between test cases and incorrect parameter access patterns.
- **Import path resolution** — Fix remaining stale import paths after module restructuring to prevent runtime resolution failures.
- **Function spec caching** — Rebuild `fnSpecMap` per invocation to avoid stale function specification references across sessions.
- **Cyclic dependency detection** — Throw `DescriptiveCycleError` on circular service dependencies with clear diagnostic output instead of silent hang.

### Refactors

- **Session migration** — Migrate from `OpencodeClient` to `ISessionClient` interface, enabling platform-agnostic session management.
- **Tool migration** — Migrate all tools from legacy `tool()` to `defineTool()` for consistent tool definition patterns.
- **Module decomposition** — Split oversized modules into focused subdirectories across dispatch, core, CLI, and types packages:
  - Dispatch: split `task-lifecycle.ts` god file into focused modules
  - Core: consolidate service files into `core/services` with composition module
  - CLI: consolidate CLI commands into subdirectories
  - Types: extract domain-specific types into `loader/types` and `memory/types`
- **Registry robustness** — Improve download stability with consistent output directories and tar integrity checks.
- **Type safety** — Replace `as any` casts with typed bridge interfaces across dispatch module.

### Tests

- **Platform abstraction tests** — Test suite for `ISessionClient` interface and platform adapter behavior.
- **State-gc tests** — Garbage collection tests for state management, graceful degradation renaming, and expanded path mock coverage.

---

## 0.21.0

### Features

- **Crash recovery architecture** — New supervisor module with init resilience and startup health checks. Integrates with the health monitor to provide degraded startup defense — the plugin starts in reduced-capability mode rather than crashing outright. New `src/core/supervisor.ts`.
- **`rolebox config` CLI command** — Interactive model selection for roles without manually editing YAML. Lets you pick models from available providers in a guided flow.
- **`dispatch_status` tool** — Proactive liveness checks for running background tasks. Returns status, duration, last activity, tool call count, and output availability without blocking.
- **Dispatch failure escalation** — Running tasks with consecutive fetch failures are now escalated to error state automatically. Configurable via `consecutiveFetchFailures` in `TaskEventState`.
- **Dispatch eventState persistence** — `TaskEventState` (including fetch failure counts) now persists across save/load cycles, surviving plugin restarts.
- **TUI task liveness indicators** — `rolebox monitor` surfaces stalled tasks with warning badges and activity indicators. Session-scoped refresh wired into the refresh cycle.
- **P2 dispatch and asset tools** — New tools for deeper introspection:
  - `task_concurrency` — Real-time concurrency slot status per key
  - `task_chronology` — Time-bucketed task activity by hour/day/agent
  - `task_export` — Export completed task results to file
  - `skill_compose` — Analyze skill combinations for conflicts
  - `asset_hot_reload` — Trigger hot-reload without restart
  - `context_assemble` — Cross-domain search across memory/assets/tasks/sessions
- **Search and introspection tools** — Full suite of search and query tools:
  - `task_search` — Search dispatch task history by query/status/agent/date
  - `task_budget` — Query token/cost consumption and remaining quota
  - `task_graph` — Visualize dispatch task dependency trees
  - `task_retry` — Retry failed tasks with context preservation
  - `asset_search` — Search skills/functions/references by keyword
  - `asset_inspect` — View complete frontmatter for any asset
  - `asset_validate` — Check dependency integrity across all roles
  - `reference_search` — Full-text search across reference documents
  - `function_state` — Query function state machine (phases, gates, evidence)
  - `function_graph` — Visualize function dependency and state-machine graphs
- **Logo rebrand** — New isometric cube logo with Space Grotesk font and sky-blue accent, conveying the "box" metaphor visually.

### Bug Fixes

- **Function parser** — Support function activation (`|name|`) at start of any line, not just after whitespace.
- **Stale lock recovery** — Reclaim stale state locks instead of blocking indefinitely; stop swallowing silent errors during lock acquisition.
- **Dispatch notification deduplication** — Prevent duplicate `system-reminder` notifications from intermediate tasks in multi-level dispatch chains.
- **Dispatch cancel-before-abort** — Cancel tasks before abort signal to prevent completed-status race conditions.
- **Dispatch retry on inflight siblings** — Retry final notifications even when sibling tasks are still inflight, preventing notification loss.
- **Monitor sidecar path** — Fall back to rebuilt sidecar path in `--tail` mode when stored path is empty.
- **Monitor stale filtering** — Filter stale functions/graphs by live dispatch sessions only, preventing phantom entries.
- **Hot-reload failure resilience** — Preserve existing state on reload failure and return structured error results instead of crashing.
- **TUI session scope** — Wire `buildSessionScope` to refresh cycle so session-scoped activity updates in real time.

### Refactors

- **Module decomposition** — Decompose oversized source files into focused single-responsibility modules across dispatch, session, and core packages.
- **SearchService dissolution** — Dissolve the monolithic SearchService and colocate tools directly by domain (dispatch tools live in `src/dispatch/`, asset tools in `src/asset/`, etc.).

### Documentation

- **README rewrite** — Complete README overhaul showcasing all major features (Memory, LSP, Hashline, Notifications, Session Management, Dispatch, Function State Machine, Context Assembly, Asset Management) with comparison table against raw opencode.

### Tests

- **Crash recovery integration tests** — New test suite covering supervisor startup, degraded mode entry, and health monitor integration.

---

## 0.20.0

### Features

- **Persistent memory system** — SQLite-backed persistent memory store with CLI tools (`rolebox memory` commands) and automatic prompt injection for cross-session knowledge retention. New `src/memory/` module (store, tools).
- **Microkernel architecture (P0–P3)** — Complete architectural refactor introducing:
  - **P0**: Service pattern + unified extension points
  - **P1**: Event bus + state isolation across services
  - **P2+P3**: Capability-based security, full role hot-reload pipeline, health monitor, and pluggable concurrency adapter
- **Full role hot-reload** — Real-time role reload on file changes with stable handler reference, debounced file watcher (300ms), and module cache invalidation. No opencode restart required. New `src/core/hot-reload-service.ts`.
- **Token/cost budget management** — Configurable budget limits for multi-agent dispatch: total sessions, input/output tokens, and cost per request and per session. Model pool limits are respected automatically. New `dispatch_budget` tool and `src/dispatch/budget-tracker.ts`.
- **Session compaction** — Runtime state injection via compaction hook during dispatch lifecycle, preserving session continuity. New `src/hooks/compaction.ts`.
- **TUI dashboard** — Redesigned `rolebox monitor` with Solid.js + OpenTU TUI rendering, proper screen refresh and layout management. New `src/tui/` module and `./tui` package export path.
- **Status Overview Panel** — New status panel in `rolebox monitor` showing active loops, graph workflows, dispatch summary, and concurrency pool health. Use `--no-status` to hide.
- **Monitor improvements** — `sessionId` field added to task snapshots for task-to-session tracing; fnstate active function filtering fixed (gated/active phases included, complete excluded); default watch interval reduced from 2s to 1s.

### Bug Fixes

- **hooks system.transform** — Fallback to `sessionAgentRegistry` when agent ID is undefined in `system.transform` hook context, preventing errors during prompt assembly.
- **Hot-reload test reliability** — Replace brittle `setTimeout` waits with polling-based `waitForRestart` utility in hot-reload service tests, eliminating flakiness.

### Refactors


- **Microkernel architecture** — Full P0–P3 decomposition into service pattern with event bus, state isolation, capability security, and pluggable concurrency adapters.
## 0.19.0

### Features

- **Comprehensive monitoring system** — `rolebox monitor` rebuilt from a simple task list into a full observability dashboard:
  - **Metrics persistence bridge** — In-process `MetricsRegistry` now flushes to `.rolebox/state/metrics-{hash}.json` via a new `MetricsPersister` class (atomic writes, NDJSON ring-buffer event log capped at 100KB). Integrated into `DispatchManager` lifecycle (persist/flush/dispose).
  - **Recovery metrics bridge** — `RecoveryMetricsCollector` snapshots are now embedded in the persisted metrics file via a provider callback wired in `plugin-hooks.ts`, making recovery chain data (attempts, successes, aborted/exhausted, by-category, by-strategy, error-type frequency) visible to the monitor.
  - **Metrics panel** — Counter totals (dispatch_total, completed, error, cancelled, timeout, rejected, backpressure_retry), gauge snapshots (inflight_tasks, concurrency_active/queued/limit), and histogram summaries (task_duration_ms, queue_wait_ms with avg/p50/p95) rendered in the CLI.
  - **Filtering & sorting** — `--agent=<pattern>` (case-insensitive substring), `--status=<list>` (comma-separated), `--sort=<field>` (status/agent/duration/started).
  - **Task detail view** — `--task-id=<id>` one-shot mode with `--offset`/`--limit` pagination for full result sidecar text.
  - **Incremental diff watch** — Watch mode now updates only changed lines via ANSI cursor positioning instead of full-screen clear. Tracks added/removed/changed tasks with a `diff: +N ~M -N` summary. SIGWINCH triggers full redraw. `--full-redraw` falls back to old behavior.
  - **Notification display** — `--show-notifications` reveals quiet-hours status, throttle stats, and recent events.
  - **Export** — `--export=json|prometheus|summary` with `--output=<path>`. Prometheus format includes HELP/TYPE lines, labeled metrics, and histogram buckets with `le=` labels.
- **Plugin-style extension system** — Users can now extend rolebox with custom conditions, graph topologies, notification channels, and hooks via a registry-based extension API. New `src/extensions/` module with loader and type-safe registries.
- **Configurable error recovery framework** — YAML-configurable error recovery system with provider-agnostic error pattern detection (7+ patterns), 7 built-in recovery strategies (retry, compact, fallback_model, etc.), recovery strategy chains (try A → B → C → abort), state persistence across restarts, metrics collection, 5 error-recovery hooks (default ON: session, edit, JSON, context, empty), and 4 guard hooks (default OFF). Extensible via `RecoveryStrategy` interface and `PatternRegistry`.
- **Custom hook registration** — Users can declare hooks in `role.yaml` that subscribe to agent lifecycle events (`chat.message`, `tool.execute.before/after`, `system.transform`, `event`). Each hook is a JS/TS module with typed handlers, configurable phase (before/after built-in), priority-based ordering, and tool/event filtering.
- **Notification manager** — Full notification subsystem integrated with session lifecycle: multi-channel delivery (terminal, file, system), quiet hours, throttling, scheduling, and content formatting. New `src/notifications/` module (12 files).

### Bug Fixes

- **dispatch_output on running tasks** — Replace the successful text response ("Task is still running") with an Error throw when `dispatch_output` is called on a running/pending task, preventing the LLM from entering a polling loop. Three layers of defense: primary tool throw, tool-before guard, tool-after correction injection.

### Refactors

- **Notifications enums → const objects** — Convert enums to const objects for extensibility, enabling the extension system to register new notification channels.
- **Metrics `reset()` fix** — `MetricsRegistry.reset()` now also clears `coreCounters`/`coreGauges`, fixing a state leak across test runs.

## 0.18.0

### Features

- **Model repetition prevention** — Added validation gate that detects and rejects model output that repeats the same or similar content consecutively. Prevents echo/loop patterns in agent responses, improving output quality and reducing wasted token usage.

## 0.17.0

### Features

- **Session management tools** — 6 new tools for session introspection: `session_list`, `session_read`, `session_search`, `session_info`, `session_diff`, `session_fork`. New `src/session/` module.
- **Available functions prompt block** — System prompt now includes an `<available_functions>` block listing activated functions and their descriptions.
- **Sync dispatch session continuation** — Sync dispatch tasks can now use `session_id` to continue a previous session, preserving conversation history. Previously only background tasks supported this.
- **Language Server Protocol integration** — Full LSP client with 30+ tools covering completions, diagnostics, hover, go-to-definition, references, rename, code actions, formatting, document symbols, workspace symbols, folding ranges, inlay hints, call hierarchy, type hierarchy, semantic tokens, selection ranges, signature help, and code lenses. (Client manager, document manager, server detection, position translation — ~4,375 lines)
- **Hash-anchored edit system** — New `hashline_read` and `hashline_edit` tools with configurable hash width (2-4 chars, auto-escalates by file size), SHA-256 file version guard for staleness detection, Myers diff re-anchoring, fuzzy anchor recovery with offset auto-correction, and atomic writes (temp+rename). 13 source modules, 5 test suites (251 tests).
- **Inline result text in completion notification** — The final "all tasks complete" system-reminder now includes result text inline (truncated at 4000 chars), so the orchestrator sees results directly without needing `dispatch_output`.
- **Output-gated observe specs** — `ObserveSpec` gains a `when_output` gate that conditionally fires based on tool output content (`contains?`, `not_contains?`). Also suppresses `requires_evidence` auto-mark when an output-gated observe covers the same tool+evidence pair.

### Refactors

- **LSP server detection order** — Check for binary in PATH before scanning project files, avoiding unnecessary filesystem traversal.
- **Derive inflight count from tasks map** — Removed the fragile `inflightByParent` map (maintained via inc/dec at every terminal path) and replaced it with authoritative derivation from the tasks map. `notifyCompletion` now accepts an explicit remaining count.

## 0.15.0

### Breaking Changes

- **Loop rewrite**: The `|loop|` semantics have been rewritten. Every round (including the first) now runs in a child worker session dispatched through the dispatch system. The main session becomes a pure orchestrator that summarizes each round for the user. The summary also seeds the next round (inherit mode). The old LoopManager sequential state machine has been removed and replaced by LoopCoordinator.

### Features

- Implement LoopCoordinator with phased state machine (idle → running → summarizing) and cancellation support
- Wire LoopCoordinator into event-handler and plugin lifecycle, replacing the old LoopManager
- Harden LoopCoordinator with persistence, cancelNow, and failure recovery
- Add `loop` to DEFAULT_FUNCTIONS — available in every role without explicit declaration
- Gate loop activation on functionSessionState to prevent spurious activations
- Refine loop cancellation: only cancel on user message after round 1, then further restricted to explicit `/stop-loop` command only
- Propagate agent identity through dispatch notifications and continuation flow
- Add evidence-based continuation gating — auto-continue now requires dispatch completion evidence
- Gate loop activation on functionSessionState in chat-message hook
- Add orchestrator integration tests and remove dead LoopManager code

### Bug Fixes

- Fix CLI optional positional args: mark `role` (update), `query` (search), and `name` (init) as `required: false` — citty defaults positional args to required, causing `rolebox update` and `rolebox search` without arguments to fail
- Fix dispatch-manager: notify parent session when a task errors while running
- Fix dispatch-adapter: make readOriginSummary `sinceMessageId` boundary exclusive
- Fix event-handler: replace `break` with flag to allow loop advance after suppression
- Fix loop coordinator test assertion to match boundary tracking
- Fix plugin-hooks: exclude dispatch completion reminders from auto-continue counter reset
- Add safer gate to terminate loop

### Refactors

- Add LoopPhase model, IDispatchAdapter interface, and unified-seed constants for LoopCoordinator
- Extract `bridgeLoopAdvance` helper in event-handler
- Extract `failSession` method and use in event-handler
- Extract `resolveMaxBytes` helper in logger
- Extract hook handlers into `src/hooks/` module
- Extract `collectAllFunctions` helper and hoist dynamic imports
- Extract magic strings to constants and consolidate duplicate utilities

## 0.14.0

### Features

- Add loop system with sequential state machine (LoopManager), configurable modes (fixed, until, forever, while), and per-loop counters
- Add loop param parsing and validation with defaults, clamping, and alias resolution
- Add loop state persistence store with save/load and version migration
- Add summarizer session with configurable timeout, token cap, and fallback
- Wire loop activation, cancellation, and function exclusions into plugin hooks
- Add idle round-advance, error handling, session.error routing, and recovery notes for loop
- Add round timeout watchdog and spawn retry for background dispatch
- Add `--tail`/`-t` flag to monitor command to show last N characters of each completed task's output

### Bug Fixes

- Prevent unbounded auto-continue spin: exclude auto-continue reminder messages from continuation counter reset in chat.message hook

## 0.13.0

### Features

- Add loop termination conditions: `timeout_ms`, `converged`, `result_matches`, `stuck` — configurable via `any_of`/`all_of` composition
- Add v2 graph state machine with per-loop counters, sync termination, and structured `terminationReason`
- Add gated prompt blocks and two-phase bridge with correction budget for review-loop workflows
- Add SCC (strongly connected component) loop detection and termination parsing
- Add sync/async termination evaluators, template edge locks, and persistence
- Wire two-phase loop termination into runtime hooks
- Add shared `state-paths` utility module with deterministic hash/path functions, migrate callers
- Add monitor command enhancements: scan all state files, resolve project root up-tree

### Bug Fixes

- Normalize workspace directory in plugin hooks for consistent state paths
- Skip creating empty agent/skill directories during sync

### Documentation

- Update README with state directory description and loop termination examples

## 0.12.0

### Features

- Add `configureLogDirectory` to logger for project-local `.rolebox` logging

### Bug Fixes

- Add gone-gate for non-existent sessions in dispatch evaluate loop
- Treat absent session status as idle-equivalent in completion detector

### Refactors

- Migrate state storage from `XDG_DATA_HOME` to project-local `.rolebox`

## 0.11.0

### Features

- Add `monitor` command — runtime dispatch dashboard with human-readable and JSON output, active/pending/error task filtering (`--all`), error detail display, live-refresh watch mode (`--watch`, `--interval`), and active function tracking with agent resolution
- Add `monitor-reader` module: reads dispatch, fnstate, and graph state files into a unified `MonitorSnapshot`, resolves agent IDs from graph and dispatch session mappings
- Add `state-hash` utility: deterministic directory-to-hash for state file naming

## 0.10.0

### Features

- Redesign dispatch subsystem: event-driven TaskWatchdogManager replaces GlobalPoller, per-model concurrency isolation, backpressure with bounded FIFO queue, session continuation, state persistence v2 with debounced writes, crash recovery
- Add dispatch task state persistence (TaskStateStore) with schema v3/v4: result refs, outbox, sidecar, LRU cleanup, state-file locks
- Add dispatch metrics: in-process MetricsRegistry with counters, gauges, histograms; lifecycle metrics; dispatch_metrics tool; sync task metrics; snapshot export
- Add dispatch output: getResult extraction with timeout, subagent result contract, output pagination, spill-to-file, materialize-before-notify, cache-first retrieval
- Add dispatch configuration: role-level `dispatch:` block merging with env vars (`ROLEBOX_DISPATCH_*`)
- Add dispatch completion detection with finish-reason analysis, session-monitor for gone detection
- Add dispatch error recovery: allocate-concurrent with timeout, single-authority CAS completion gate, atomic per-parent in-flight counter, stall timeout
- Add dispatch session.idle event handling and permission transformation
- Add collaborative graph advancements: idempotent advanceStep, structured args advancement, single-authority advancer, unicode agent name support, disconnected subgraph validation
- Add graph runtime state persistence and recovery via plugin hooks
- Add unified logger module (tslog) with file transport, log rotation, lazy initialization, prompt size monitoring
- Add init summary logging with actionable context

### Bug Fixes

- Fix dispatch: prevent cleanup during in-flight notifications, notify parent on failure, terminal-status guards for cancelTask/lifecycle handlers, bounded cleanedUpTasks FIFO buffer, unhandled rejection in enqueueNotify
- Fix dispatch: double-completion race via CAS gate, executeSync under concurrency/timeout/abort control
- Fix graph: advanceStep edge selection with deferred state cleanup, lazy-init graph state in system.transform, clamp negative max_iterations to 0
- Fix dispatch: recovery notification and inflight rebuild, unify terminal cleanup with leaveRunning
- Fix sync: add logging to silent catch blocks, fallback to opencode config dir when workspace-level config is unavailable

### Refactors

- Restructure src/ into domain subdirectories (dispatch, graph, cli, prompt)
- Move tests from src/ to tests/ directory
- Extract constants, XML DOM builder utilities, shared test helpers
- Migrate all resolvers, loaders, and CLI logging to tslog
- Rewrite graph advancer to single-authority pattern

### Documentation

- Update README with init, info, status commands, References system, dispatch config, dispatch env vars

## 0.9.0

### Features

- Add `status` command — rolebox health dashboard with sync status, plugin registration, skill symlink integrity
- Add `info` command — detailed role inspection with model config, skills, functions, subagents, collaboration graph, sync status, and optional integrity hash verification (`--check`)
- Add `--no-cache` flag to `search` and `update` commands to bypass registry cache

## 0.7.0

### Features

- Add `init` command — interactive role scaffolding with 4 templates
- Add scaffold templates: `minimal` (role.yaml + PROMPT.md), `standard` (+ skills/functions/references dirs), `subagents` (+ subagent scaffolding), `collaboration` (+ collaboration graph topology)

## 0.6.0

### Features

- Add References system: auto-discovered `references/` directories (recursive .md discovery), explicit declarations in role.yaml, skill-specific references, frontmatter description extraction
- Add Collaboration Graph system: define multi-agent workflows with pipeline/review-loop/star topologies or custom flow edges, runtime state tracking, prompt injection, automatic graph advancement
- Add graph persistence: state files, session recovery, role config integration
- Add `<available_references>` and `<collaboration_graph>` XML blocks to agent prompts

### Documentation

- Add collaboration graph section to README with topology descriptions, custom flow examples, and runtime behavior

## 0.5.1

### Features

- Add SubAgentConfig and ResolvedSubAgent types
- Add subagent parsing, file-based and inline declaration, auto-discovery from `subagents/` directory
- Add config inheritance: subagents inherit model, color, variant, temperature, top_p, permission, tools from parent
- Add subagent naming convention: `{parentId}--{childId}` (`--` separator reserved)
- Add `<available_subagents>` XML block injection into parent prompt
- Add subagent skills and functions support with rolebox-- prefix symlinks
- Wire subagents into plugin lifecycle with dispatch/output/cancel tools
- Add team-lead example and E2E tests

### Bug Fixes

- Fix subagent skill path resolution, type safety, naming, and duplicate detection

## 0.5.0

### Features

- Add automatic version check on CLI startup — checks npm registry for newer release, caches result for 24 hours, displays colored update notice
- Never blocks CLI — version check uses 3s timeout, all failures silently swallowed

## 0.4.1

### Bug Fixes

- Add .js extensions for ESM compatibility (NodeNext module resolution)

## 0.4.0

### Features

- Add CLI skeleton with citty framework
- Add config manager: `~/.config/rolebox/config.yaml` with multi-registry support
- Add registry client: fetches role manifests from GitHub-based registries
- Add CLI commands: `list` (installed roles), `search` (registry search), `update` (role updates), `registry` (registry management)
- Add `sync` command — deploys installed roles to opencode via symlinks
- Add lock file (`rolebox.lock`) for version and integrity tracking

## 0.3.1

### Bug Fixes

- Export plugin as PluginModule format for opencode compatibility

## 0.3.0

### Features

- Add parameterized function support: positional (`|review:security,strict|`) and key-value (`|review focus=security severity=strict|`) syntax
- Add parameter substitution in function resolver — params fall back to declared defaults
- Wire parameterized function calls into plugin hooks

### Documentation

- Update README and function docs for parameterized functions

## 0.2.0

### Features

- Add Functions system: composable behavior modules activated via `|name|` syntax
- Add function type definitions, resolver, parser, and session state modules
- Add function resolution priority: role-local > global > built-in
- Add built-in functions: `plan` (codebase investigation + structured plan), `execute` (step-by-step implementation with verification)
- Add `functions` and `disable_functions` fields to role.yaml
- Add function hooks integration for dynamic injection into system prompt
- Add comprehensive test suite for function system

## 0.1.2

### Bug Fixes

- Fallback to opencode config directory when workspace-level config is unavailable
