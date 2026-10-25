# Benchmarks on dsh

> Part of the rolebox documentation. See [CLI reference](cli.md#bench-subcommand) for the command surface and the [infrastructure design](benchmark-infrastructure-design.md) for future work.

The benchmark implementation runs a self-contained role in a real dsh primary session, scores its final response or working files, and saves the evidence locally. Workspace cases can run trusted local checks against the role's resulting files. It supports `init`, `validate`, `doctor`, `run`, `watch`, `report`, `baseline`, and historical `compare`. The broader design is not fully implemented.

Each trial gets a separate process, workspace, home, and runtime state. The role is frozen before execution, and the adapter checks the activated role prompt and the actual top-level provider/model route. A trial is one case executed once; increasing `repetitions` creates independent trials rather than retrying a failed answer until it passes.

## First run

Use Node.js 26.4 or newer on a system with POSIX process groups. Windows execution is currently unsupported. You also need a compatible, complete dsh installation and a trusted dsh plugin that registers the provider you intend to evaluate. The benchmark does not automatically load your normal dsh profile or credentials.

```bash
rolebox bench init output-quality
```

This creates a new directory and refuses to overwrite an existing one. Its parent directory must already exist.

```text
output-quality/
  suite.yaml
  cases.jsonl
  role/
    role.yaml
  README.md
```

The starter includes three simple cases. Configure `target.provider`, `target.model`, and `host.plugins` in `suite.yaml` before running. Replace the starter role with the self-contained role you want to measure, or point `target.role` at its directory.

```bash
rolebox bench validate output-quality
rolebox bench doctor output-quality
rolebox bench run output-quality --output benchmark-results
```

`run` prints a result directory and progress as each trial finishes. Use that directory to generate a report; replace `RUN_ID` below with its final path component.

```bash
rolebox bench report benchmark-results/RUN_ID
rolebox bench report benchmark-results/RUN_ID --format json
```

The default report files are `report.html` and `report.json` inside the run directory. Pass `--output report.html` or another destination to choose a file. HTML reports are standalone and work offline. Without `run --output`, results go under the rolebox data directory's `benchmarks/` subdirectory.

From a source checkout, the equivalent entry point is `node --import tsx src/cli/main.ts bench <subcommand>`.

## A code repair benchmark

```bash
rolebox bench init code-quality --template code-fix
```

The `response` template remains the default. `code-fix` creates a small JavaScript module with a real bug: `sum([])` throws instead of returning zero. It includes a role instructed to edit the actual working file, a case, and dependency-free checks using Node.js and its built-in assertions:

```text
code-quality/
  suite.yaml
  cases.jsonl
  role/role.yaml
  fixtures/sum/src/sum.mjs
  checks/sum/check.mjs
  README.md
```

The fixture contains the source the model may edit. The separate checks exercise ordinary, empty, negative, fractional, and immutable inputs. A successful final explanation alone cannot pass the checks. Configure the provider/model and trusted plugins as in the first-run instructions; the template does not supply a provider or call a model during creation. For workspace cases, the benchmark adapter mounts dsh's native filesystem tools and observation policy; `doctor` checks their package availability. You do not need to add filesystem tools to `host.plugins` yourself.

Before spending model tokens, verify the checks locally:

```bash
cd code-quality
node checks/sum/check.mjs fixtures/sum
```

This must fail on the starter's empty-array bug. Copy the fixture to a temporary directory, add `0` as the initial value to `reduce`, and point the same check at that copy; it should pass. Keep the original fixture defective for actual benchmark runs. The generated README includes this check; there is no general `test-graders` command yet.

Run the suite and save a baseline, then edit `role/role.yaml` and use `watch --baseline` to compare results. The HTML run report shows before/after file evidence and check output, while the historical comparison shows the change in pass rates. Changes to fixture or check contents change the suite digest and require a new baseline.

## Feedback while editing

```bash
rolebox bench watch output-quality --output benchmark-results
```

Watch runs the initial valid suite immediately, then polls the suite, cases, workspace fixtures/checks, and role snapshot for content changes. By default it polls every 500 milliseconds and waits for 300 milliseconds of stable input after a change. Formatting-only suite changes and unchanged content do not trigger another run. It executes the full plan configured in `suite.yaml`; choose a small case set and repetition count for interactive feedback. Each execution can make model requests and has the same per-trial timeout as `run`.

If a save changes the revision or leaves invalid configuration, watch cancels the previous run and waits for its cleanup before starting another. Invalid input produces a static diagnostic and pauses model execution until it is valid again. Rapid saves are combined into the latest stable revision. A revision never changes underneath an already-running trial.

Old run directories remain available for audit. Completion feedback distinguishes the current revision from superseded results; an old run finishing during cancellation is not the current role's score. Stopping watch waits for the active run to finish cleanup. An unexpected run error or unconfirmed worker termination stops watch entirely, because safely starting another revision would require proof that the previous workers stopped.

The result directory must be outside the role, fixture, and checks directories, including through symlinks. This prevents generated results from becoming watched input. Add `--baseline <name>` for historical feedback as described below. A normally returned infrastructure failure does not automatically retry unchanged input; save a changed valid revision to run again.

## Comparing role edits with a baseline

Save a complete run before editing the role, then use its name for feedback:

```bash
rolebox bench baseline set main benchmark-results/BASELINE_RUN_ID
rolebox bench baseline show main
rolebox bench watch output-quality --output benchmark-results --baseline main
```

`baseline set` captures the full validated run record in a local SQLite catalog under the rolebox data directory at `benchmarks/baselines/baselines.sqlite`. It accepts complete scored runs, including runs containing task failures. It rejects incomplete runs. Names contain 1–64 letters, digits, underscores, or hyphens and must start with a letter or digit. Names are case-sensitive.

Each saved record is content-addressed and verified on read. Changing or deleting its original run directory does not change the captured baseline. Updating a name explicitly appends a revision and keeps previous records; it never happens automatically after a high score. The catalog captures result evidence, including workspace change previews and command grades, not a runnable copy of the workspace or host installation. Keep the original run directory if you need its role snapshot, plan, or full workspace artifacts.

```bash
rolebox bench baseline list
rolebox bench baseline history main
rolebox bench baseline set main benchmark-results/NEW_BASELINE_RUN_ID
rolebox bench run output-quality --output benchmark-results --baseline main
```

Both `run --baseline` and `watch --baseline` resolve the name once at startup and print the pinned name/revision with the result. Watch compares only `current: true` results; cancelled and superseded revisions have no comparison. Updating the name from another process does not move an active watch's baseline. Restart watch to use the new revision. Comparisons appear in command output; export a saved comparison separately when needed:

```bash
rolebox bench compare benchmark-results/CANDIDATE_RUN_ID --baseline main
rolebox bench compare benchmark-results/CANDIDATE_RUN_ID --baseline main --format html --output comparison.html
rolebox bench compare benchmark-results/CANDIDATE_RUN_ID --against benchmark-results/BASELINE_RUN_ID --output comparison.json
```

`compare` reads existing evidence without model requests. Supply exactly one of `--baseline <name>` and `--against <run-directory>`. The default format is JSON; omitting `--output` prints the comparison. HTML is standalone and works offline. Exports cannot overwrite either compared run's evidence or the baseline catalog. When using a named baseline, its original source directory is no longer an input; the captured catalog record is the protected baseline.

Every comparison is labeled `mode: "historical"` and identifies both run IDs, record digests, suite/role digests, summaries, and observation times. It checks the suite digest, case plan, isolation, observed top-level provider/model, and known dsh/rolebox versions. Changed role and prompt digests are allowed. Conflicting conditions yield `incompatible`; missing runtime or route observations yield `unverified`. Both preserve side-by-side observations but suppress deltas. A changed dataset or execution setting requires a new baseline; matching case IDs alone is insufficient.

Only complete, comparable runs receive overall and per-case pass-rate deltas. `successRateDelta` is candidate minus baseline as a ratio: `0.10` means **+10 percentage points**, including when the baseline is zero. Per-case `improved` and `regressed` labels describe observed scores. There are no confidence intervals, significance claims, paired trials, or CI quality gates. Historical differences cannot be attributed solely to the role edit: backend models, external services, environment values, and unlocked dependencies can change between runs.

Token and cost deltas additionally require that particular metric to be known for every planned trial on both sides. Unknown values stay `null`; a measured zero stays zero. Duration summaries include failed and timed-out trials and measure host startup, execution, and cleanup, not pure model latency. A shorter unsuccessful run is not a quality improvement.

For `compare`, exit `0` means a complete, comparable historical comparison, even if scores regressed; exit `2` means incomplete or unverified/incompatible evidence. Invalid arguments or corrupt records fail the command. Adding `--baseline` to `run` does not change its existing pass/fail exit policy.

## Suite configuration

The following uses illustrative provider and plugin names. Replace the plugin module and its `config` fields with those required by your installed provider adapter.

```yaml
schemaVersion: 1
id: output-quality

target:
  host: dsh
  role: ./role
  provider: example-provider
  model: model-name

host:
  moduleRoot: ../dsh-runtime
  plugins:
    - module: example-provider-plugin
      config:
        apiKey:
          $env: EXAMPLE_API_KEY
  env:
    - EXAMPLE_API_KEY

dataset: cases.jsonl

run:
  repetitions: 3
  concurrency: 2
  timeoutMs: 120000
```

Paths are resolved relative to `suite.yaml`. `target.role` must name a directory containing `role.yaml`; `dataset` names a JSONL file. A local plugin module such as `./provider-plugin.mjs` must be a readable file. Package plugin names are resolved through the selected dsh installation.

`host.moduleRoot` is the directory containing the package manifest for that installation. The adapter resolves the dsh agent loop there, then resolves its core services and provider plugins from the same installation. Use one compatible set of dsh packages. If omitted, resolution starts from the rolebox installation; a partial set of development packages may not supply a runnable host.

The top-level `provider` and `model` are explicit experimental conditions. A conflicting model declaration in the role is rejected; the benchmark does not silently fall back to another top-level route. Role activation is checked again against the actual model request before accepting a completed result.

### Credentials and trusted plugins

Add required environment variable names to `host.env` and supply their values to the invoking process through your usual environment or secret manager. A plugin config value of `{ $env: EXAMPLE_API_KEY }` resolves inside the worker. References may appear in nested config objects and arrays. They must name an allowed variable and contain no additional fields.

Literal credential fields such as `apiKey`, `password`, `token`, and authorization headers are rejected. Credential-bearing URLs also need an environment reference. Environment references stay unresolved in the persisted plan; credential values are not substituted into that plan. The benchmark cannot infer every plugin-specific secret field, so use references for all credentials.

`host.env` cannot override isolation or runtime-loading variables, including `HOME`, `PATH`, `XDG_*`, `DSH_*`, `ROLEBOX_*`, `NODE_*`, and `BUN_*`.

Provider plugins are executable code. Use plugins and roles you trust. The recorded isolation mode, `trusted-process`, isolates ordinary session state and working directories; **it is not an operating-system security sandbox**. Tools and plugins retain the user's operating-system permissions, including access outside the temporary workspace and network access. This mode does not protect hidden answers from a deliberately adversarial role.

### Defaults and limits

Unknown suite fields are rejected instead of being ignored.

| Field | Default | Accepted range |
| --- | --- | --- |
| `schemaVersion` | Required | `1` |
| `target.host` | Required | `dsh` |
| `dataset` | `cases.jsonl` | Readable JSONL file, at most 16 MiB |
| `run.repetitions` | `1` | Integer, 1–20 |
| `run.concurrency` | `1` | Integer, 1–8 |
| `run.timeoutMs` | `120000` | Integer, 100–3,600,000 milliseconds |
| Number of cases | Required | 1–1,000 |
| Assertions per case | Required | 1–64 |

The task deadline covers execution, including waiting for child agents and graph work to settle. Initialization and teardown also have bounded waits; failure to establish or confirm a clean lifecycle is an infrastructure error. There is no run-wide token or cost budget in this version.

## Writing cases

Each nonblank line of `cases.jsonl` is one JSON object:

```jsonl
{"id":"literal","prompt":"Reply with exactly READY and no other text.","assertions":[{"kind":"equals","value":"READY"}]}
{"id":"explanation","prompt":"Write one sentence explaining a benchmark. Include the words benchmark and task.","assertions":[{"kind":"contains","value":"benchmark"},{"kind":"contains","value":"task"}]}
```

Case IDs must be unique. Suite and case IDs start with a letter or digit and contain only letters, digits, `.`, `_`, or `-`, up to 100 characters. Prompts must contain non-whitespace text and are limited to 131,072 characters. Each assertion value is limited to 16,384 characters.

`equals` compares the whole final response exactly. `contains` checks a literal substring. Both are case-sensitive and preserve whitespace; there is no automatic trimming or normalization. Every assertion must pass. An empty `equals` value can test a deliberately empty response; an empty `contains` value is rejected. Regex assertions and a custom grader SDK are not available in this version.

The scenario is one user prompt submitted to the primary session. Roles execute through real dsh services and can use registered tools and child agents. Multi-turn scenario drivers and LLM judges remain future extensions.

### Workspace fixtures and checks

Add a `workspace` object to a case to populate its working directory before the model starts:

```jsonl
{"id":"sum-empty","prompt":"Fix src/sum.mjs so sum([]) returns 0 without changing the other numeric behavior. Edit the file itself.","workspace":{"fixture":"./fixtures/sum","checks":"./checks/sum"},"assertions":[{"kind":"file_exists","path":"src/sum.mjs"},{"kind":"command","argv":["node","{checks}/check.mjs","{workspace}"],"timeoutMs":10000,"expectedExitCode":0}]}
```

`fixture` is required when `workspace` is present. `checks` is optional; both name directories inside the suite directory, relative to `suite.yaml`. Each snapshot supports at most 1,000 regular files, 1 MiB per file, and 16 MiB total. A suite allows 64 MiB and 50,000 files across all case references, counting repeated references separately. Symlinks, special files, paths outside the suite, and excessive nesting are rejected. File contents and executable bits are frozen at load time and included in the suite digest. Changing inputs on disk does not change an existing run; watch detects the change for the next run. Keep generated results outside role, fixture, and checks directories.

The top-level `.rolebox` directory is reserved for runtime state. Fixtures, checks, and file assertions cannot target that namespace, and workspace artifact capture excludes it.

Each trial receives a fresh writable copy of its fixture. Checks are held separately and are not copied into the model's initial workspace. After model termination is confirmed, the runner captures the resulting workspace before executing any grading command. File assertions inspect that frozen result. Every command receives its own fresh copy of the same result and checks, so a command that writes files cannot change a later assertion or the recorded artifact. There is no automatic dependency installation or arbitrary fixture setup hook; prepare small, self-contained fixtures and trusted checks explicitly.

Artifact capture and checks require a completed model task with confirmed termination. Model task failures and timeouts keep their execution-failure grades; they do not run checks or claim a captured workspace artifact.

| Assertion | Fields | Passing condition |
| --- | --- | --- |
| `file_exists` | `path` | A regular file exists in the captured workspace; binary files are allowed |
| `file_equals` | `path`, `value` | The file's strict UTF-8 text equals `value` exactly |
| `file_contains` | `path`, nonempty `value` | The file's strict UTF-8 text contains `value` literally |
| `command` | `argv`, `timeoutMs`, `expectedExitCode` | The command exits with the expected code before its deadline and cleanup is confirmed |

File assertion paths are workspace-relative, such as `src/sum.mjs`; do not prefix them with `./` or use `..`. Missing files fail their assertion. Text assertions preserve case and whitespace, reject invalid UTF-8 or NUL-containing content, and do not trim or normalize. File and command assertions require a workspace fixture; final-response assertions may be combined with them.

Commands use an argument array without a shell. The runner replaces `{workspace}` and `{checks}` inside arguments with their temporary directories; `{checks}` requires a checks directory. The working directory is the result copy. Shell operators and environment substitutions are not interpreted. The command gets fresh home/temp/state directories and a small runtime environment containing `PATH` and locale/timezone settings; provider credentials from `host.env` are not forwarded to grading commands.

`argv` contains 1–64 arguments of at most 4,096 characters each. `timeoutMs` defaults to 10,000 and accepts 100–60,000 milliseconds; it applies separately to each command. `expectedExitCode` defaults to `0` and accepts integers from 0 to 255. These grading deadlines are separate from the model task deadline and do not form a run-wide budget.

A nonmatching exit code or a timeout with confirmed cleanup is a failed assertion. Failure to start a check, cancellation, or uncertain process cleanup leaves grading unscored. These infrastructure problems do not become a failed role score. Reports retain the check's status, exit code, duration, cleanup result, and bounded stdout/stderr with a truncation marker.

**Command checks are explicitly trusted local execution.** They can execute code generated by the role with your operating-system permissions. An argument array prevents implicit shell parsing but is not a security sandbox. Separate checks prevent ordinary accidental edits by the model; they do not keep answers secret from a role with unrestricted filesystem access. Use trusted roles, plugins, fixtures, and checks without secrets. Untrusted benchmark packs and protected test oracles need stronger isolation, which this version does not provide.

## Preparing the role

Keep the role's prompts, skills, functions, references, and supported child definitions inside its directory. Global skills, legacy `open_roles` declarations, symlinks, and dependencies that escape the role directory are not supported by the initial snapshot contract. Team discovery makes top-level roles visible by default; `open`, `exports`, and `open_roles` no longer control visibility, and child roles stay private. The benchmark snapshot remains self-contained and does not bundle teammate roles. Bundle assets locally when validation reports an external dependency. Role metadata and files selected by `prompt_file` cannot contain `{env:...}` substitutions in this version; host credentials use the separate `$env` mechanism described above.

The runner captures role file contents and executable bits before launching trials. Enabled built-in functions, including the default functions, are copied into the role snapshot when there is no local override; their contents participate in its digest. Each trial receives a fresh materialization of that snapshot; later edits to the source role do not change the trials already planned. Script execution bits are preserved while ordinary snapshot files are read-only. A later run takes a new snapshot and records a new role digest when its contents or executable bits change.

The suite digest covers cases, fixture/check contents and executable bits, and effective execution settings. The saved plan includes the case prompts and assertions, fixed provider/model, repetition and concurrency settings, timeout, and host configuration references. Local plugin module locations use hashed identifiers in that plan, and the plan records whether `moduleRoot` was configured without storing its path.

This is not a complete host dependency lock. Local plugin entry files are checked against their recorded digests immediately before and after import; a mismatch produces an `invalid`, unscored trial. Their transitive imports and the host installation are not frozen. Keep the dsh installation, provider plugins, and local plugin source files unchanged for the duration of a run. Effective dsh and rolebox versions are recorded when the runtime reaches that observation point; failed startup may leave them unknown.

## Reading results

Execution status and grading are separate:

| Execution status | Grade | Meaning |
| --- | --- | --- |
| `completed` | `pass`, `fail`, or `unscored` | Confirmed model completion; grading passes/fails, or a grader infrastructure problem prevents scoring |
| `task_failure` | `fail` | The host reports unsuccessful task execution |
| `task_timeout` | `fail` | The task exceeds its execution deadline |
| `infra_error` | `unscored` | Startup, protocol, observation, or shutdown could not establish a valid trial |
| `invalid` | `unscored` | The requested target or route could not be activated as specified |
| `cancelled` | `unscored` | The run was cancelled |

A partial response does not rescue a failed or timed-out task. Unconfirmed termination prevents a run from being treated as a completed measurement. There are no automatic benchmark-layer retries; all planned repetitions remain visible.

For workspace cases, JSON and HTML reports retain file additions, modifications, and deletions with content digests, executable-bit changes, and bounded before/after text previews. Binary or large content can be omitted from previews and is marked accordingly; the run directory retains the captured file artifacts. Grading command output is shown with the corresponding trial. Workspace evidence and grades are part of saved records and immutable baseline captures. A baseline remains usable for comparison if the original run directory is removed, but its previews are not a complete artifact backup.

The overall `successRate` is the mean of the per-case pass rates, giving every case equal weight. For example, case pass rates of `1.0` and `0.5` produce `0.75`. The overall rate is `null` until the entire planned run has scored observations and confirmed termination. Missing trials and infrastructure failures do not silently disappear from coverage.

`observedCaseSuccessRate` summarizes the available scored cases for diagnosis. When the plan is incomplete, it is explicitly a partial observation rather than the overall result. Reports show planned, recorded, scored, unscored, and missing trial counts alongside per-case results and the final response evidence.

Usage is measured separately for input tokens, output tokens, and cost. Missing usage is `null`, never an invented zero. Each reported total shows how many trials had observations and how many remain unknown; a sum with missing observations is labeled partial. The current dsh adapter leaves monetary cost unknown. Reported token totals depend on complete usage observations from the provider calls; they are not a cost estimate. Runtime versions, activation details, and digests remain available in saved trial records, with runtime versions also shown in HTML.

### Saved files and interruptions

Each run uses a separate result directory:

```text
RUN_ID/
  benchmark.sqlite
  plan.json
  snapshot/
    role/
      role.yaml
  fixtures/
    CASE_INDEX/
      workspace/
      checks/
  artifacts/
    TRIAL_ID/
      workspace/
  run.json
  report.html
  report.json
```

The snapshot subdirectory uses the target role's directory name. `fixtures/` contains frozen workspace inputs in six-digit case-index directories, with `checks/` present only when configured. The plan maps each case ID to its input directories; cancellation during preparation can leave some unmaterialized. `artifacts/` contains successfully captured results from completed model executions; timed-out, failed, or uncapturable workspaces do not have a complete artifact claim. `report.html` and `report.json` are created only when requested.

SQLite is the authoritative run and trial store. Each finished trial is committed before progress is emitted. A process interruption leaves previously committed trials readable; `report` reads that store and marks unfinished runs incomplete. Missing trials remain missing. `run.json` is a final JSON snapshot written when the coordinator finishes; an interrupted run may not have one. `plan.json` and the role snapshot are prepared before trials start.

Crash-readable results do not imply automatic resumption or replay. Restarting `run` creates a new run. A report does not start a model request.

### Command outcomes

For a run that reaches result reporting, exit code `0` means all planned trials passed, `1` means the complete run contains task failures, `2` means the result is incomplete, and `130` means cancellation through the command's signal handler. Invalid arguments, configuration, or unavailable prerequisites can fail before a run is created.

`validate` checks the suite, cases, and role assets without importing provider plugins or requesting a model. `doctor` adds static installed-module resolution and reports `pluginsConfigured`; it reports `liveExecutionVerified: false`. An available runtime and a nonempty plugin list do not establish that the provider can authenticate, register successfully, or serve the selected model. The actual run verifies those execution conditions.

## Current scope

Native graph execution and named skill loading have been verified through the real dsh services. Native loop execution has a known role/provider routing limitation in the current integration, so successful multi-round loop benchmarks are not yet a supported claim. This benchmark work does not change that existing runtime route. A loop ending in an unsuccessful terminal state without evidence of a business-task failure is recorded as `infra_error` and `unscored`, keeping the overall result incomplete rather than lowering the role's score.

Use this version for explicit local runs and watch feedback against a captured historical baseline while developing a role. It does not yet provide paired experiments, confidence intervals, CI regression gates, container isolation, replay, custom grader SDKs, or a complete host/plugin dependency lock. Watch has no cumulative token or cost budget. These remain part of the [infrastructure design](benchmark-infrastructure-design.md), whose broader examples describe planned interfaces rather than the schema above.
