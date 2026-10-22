# Benchmarks on dsh

> Part of the rolebox documentation. See [CLI reference](cli.md#bench-subcommand) for the command surface and the [infrastructure design](benchmark-infrastructure-design.md) for future work.

The first benchmark implementation runs a self-contained role in a real dsh primary session, scores its final text response, and saves the evidence locally. It supports `init`, `validate`, `doctor`, `run`, `watch`, and `report`. This is the initial execution and reporting foundation; the broader design is not fully implemented.

Each trial gets a separate process, workspace, home, and runtime state. The role is frozen before execution, and the adapter checks the activated role prompt and the actual top-level provider/model route. A trial is one case executed once; increasing `repetitions` creates independent trials rather than retrying a failed answer until it passes.

## First run

Use Bun on a system with POSIX process groups. Windows execution is currently unsupported. You also need a compatible, complete dsh installation and a trusted dsh plugin that registers the provider you intend to evaluate. The benchmark does not automatically load your normal dsh profile or credentials.

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

From a source checkout, the equivalent entry point is `bun src/cli/main.ts bench <subcommand>`.

## Feedback while editing

```bash
rolebox bench watch output-quality --output benchmark-results
```

Watch runs the initial valid suite immediately, then polls the suite, cases, and role snapshot for content changes. By default it polls every 500 milliseconds and waits for 300 milliseconds of stable input after a change. Formatting-only suite changes and unchanged content do not trigger another run. It executes the full plan configured in `suite.yaml`; choose a small case set and repetition count for interactive feedback. Each execution can make model requests and has the same per-trial timeout as `run`.

If a save changes the revision or leaves invalid configuration, watch cancels the previous run and waits for its cleanup before starting another. Invalid input produces a static diagnostic and pauses model execution until it is valid again. Rapid saves are combined into the latest stable revision. A revision never changes underneath an already-running trial.

Old run directories remain available for audit. Completion feedback distinguishes the current revision from superseded results; an old run finishing during cancellation is not the current role's score. Stopping watch waits for the active run to finish cleanup. An unexpected run error or unconfirmed worker termination stops watch entirely, because safely starting another revision would require proof that the previous workers stopped.

The result directory must be outside the role directory, including through symlinks. This prevents generated results from becoming watched role input. Watch does not set a baseline, compare scores across runs, or calculate statistical significance. A normally returned infrastructure failure does not automatically retry unchanged input; save a changed valid revision to run again.

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

`equals` compares the whole final response exactly. `contains` checks a literal substring. Both are case-sensitive and preserve whitespace; there is no automatic trimming or normalization. Every assertion must pass. An empty `equals` value can test a deliberately empty response; an empty `contains` value is rejected. Regex assertions and custom graders are not available in this version.

The initial scenario is one user prompt submitted to the primary session. Roles execute through real dsh services and can use registered tools and child agents, but grading currently evaluates the final text response. Workspace fixtures, file-state assertions, hidden tests, multi-turn scenario drivers, and LLM judges are future extensions.

## Preparing the role

Keep the role's prompts, skills, functions, references, and supported child definitions inside its directory. Global skills, `open_roles`, symlinks, and dependencies that escape the role directory are not supported by the initial snapshot contract. Bundle assets locally when validation reports an external dependency. Role metadata and files selected by `prompt_file` cannot contain `{env:...}` substitutions in this version; host credentials use the separate `$env` mechanism described above.

The runner captures role file contents and executable bits before launching trials. Enabled built-in functions, including the default functions, are copied into the role snapshot when there is no local override; their contents participate in its digest. Each trial receives a fresh materialization of that snapshot; later edits to the source role do not change the trials already planned. Script execution bits are preserved while ordinary snapshot files are read-only. A later run takes a new snapshot and records a new role digest when its contents or executable bits change.

The suite digest covers cases and effective execution settings. The saved plan includes the case prompts and assertions, fixed provider/model, repetition and concurrency settings, timeout, and host configuration references. Local plugin module locations use hashed identifiers in that plan, and the plan records whether `moduleRoot` was configured without storing its path.

This is not a complete host dependency lock. Local plugin entry files are checked against their recorded digests immediately before and after import; a mismatch produces an `invalid`, unscored trial. Their transitive imports and the host installation are not frozen. Keep the dsh installation, provider plugins, and local plugin source files unchanged for the duration of a run. Effective dsh and rolebox versions are recorded when the runtime reaches that observation point; failed startup may leave them unknown.

## Reading results

Execution status and grading are separate:

| Execution status | Grade | Meaning |
| --- | --- | --- |
| `completed` | `pass` or `fail` | Confirmed completion; every assertion passes, or at least one fails |
| `task_failure` | `fail` | The host reports unsuccessful task execution |
| `task_timeout` | `fail` | The task exceeds its execution deadline |
| `infra_error` | `unscored` | Startup, protocol, observation, or shutdown could not establish a valid trial |
| `invalid` | `unscored` | The requested target or route could not be activated as specified |
| `cancelled` | `unscored` | The run was cancelled |

A partial response does not rescue a failed or timed-out task. Unconfirmed termination prevents a run from being treated as a completed measurement. There are no automatic benchmark-layer retries; all planned repetitions remain visible.

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
  run.json
  report.html
  report.json
```

The snapshot subdirectory uses the target role's directory name. `report.html` and `report.json` are created only when requested.

SQLite is the authoritative run and trial store. Each finished trial is committed before progress is emitted. A process interruption leaves previously committed trials readable; `report` reads that store and marks unfinished runs incomplete. Missing trials remain missing. `run.json` is a final JSON snapshot written when the coordinator finishes; an interrupted run may not have one. `plan.json` and the role snapshot are prepared before trials start.

Crash-readable results do not imply automatic resumption or replay. Restarting `run` creates a new run. A report does not start a model request.

### Command outcomes

For a run that reaches result reporting, exit code `0` means all planned trials passed, `1` means the complete run contains task failures, `2` means the result is incomplete, and `130` means cancellation through the command's signal handler. Invalid arguments, configuration, or unavailable prerequisites can fail before a run is created.

`validate` checks the suite, cases, and role assets without importing provider plugins or requesting a model. `doctor` adds static installed-module resolution and reports `pluginsConfigured`; it reports `liveExecutionVerified: false`. An available runtime and a nonempty plugin list do not establish that the provider can authenticate, register successfully, or serve the selected model. The actual run verifies those execution conditions.

## Current scope

Native graph execution and named skill loading have been verified through the real dsh services. Native loop execution has a known role/provider routing limitation in the current integration, so successful multi-round loop benchmarks are not yet a supported claim. This benchmark work does not change that existing runtime route. A loop ending in an unsuccessful terminal state without evidence of a business-task failure is recorded as `infra_error` and `unscored`, keeping the overall result incomplete rather than lowering the role's score.

Use this version for explicit local runs and watch feedback while developing a role. It does not yet provide baselines, paired comparisons, confidence intervals, CI regression gates, container isolation, replay, custom grader SDKs, or a complete host/plugin dependency lock. Watch has no cumulative token or cost budget. These remain part of the [infrastructure design](benchmark-infrastructure-design.md), whose broader examples describe planned interfaces rather than the schema above.
