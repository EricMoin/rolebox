# dsh (DeepSeek Harness) Plugin Contract — verified against the 0.1.5-rc.1 source checkout

> Contract gate for "Adapt rolebox to run as a `@deepseek-ai/dsh` cordis plugin".
> **The reference of record is the dsh SOURCE checkout**, not published npm
> tarballs: `/path/to/harness-checkout`, version **`0.1.5-rc.1`**
> (`package.json`). Every claim below is grounded in a source file under that
> checkout, and where noted, in executable behavior at runtime. Anything not
> verifiable from source is flagged `[UNVERIFIED]`.
>
> rolebox's own alignment: every `@deepseek-ai/dsh-*` devDependency is pinned to
> **`0.1.5-rc.1`** and `@deepseek-ai/cordis` to **`4.0.2`** (`package.json`).
> `@deepseek-ai/dsh-client-runtime` has been **removed** (zero references remain
> in the repo); its successor surfaces are `@deepseek-ai/dsh-client-ui-slots` and
> `@deepseek-ai/dsh-client-ui-settings`. See §6.
>
> Citation format: `source:<packages/.../src/file.ts>:<line>` (e.g.
> `source:packages/core/tools/src/schema.ts`) refers to a file in the source
> checkout, relative to its root. `live:` marks an executable runtime check
> performed against the installed `@deepseek-ai/dsh-*` packages (the
> `0.1.5-rc.1` line) — re-confirm it when the pinned version moves. Claims
> retained from the superseded published-`0.1.0-rc.6`-tarball verification are
> no longer carried in this document; that material is superseded and lives only
> in git history.
>
> The `0.1.0-rc.6` published-npm-tarball verification is **superseded** and has
> been removed from this document. The source checkout above is the sole
> reference of record.

---

## 0. Contract seams at a glance (source of record: dsh 0.1.5-rc.1)

rolebox consumes dsh structurally (it never imports `@deepseek-ai/*` at runtime)
and is verified against six seams. Each seam's source of truth, relative to the
dsh checkout root:

| Seam | Surface | Source of truth |
|---|---|---|
| 1. Tool registration | `ToolDefinition`, `ToolOutputDefinition`, `ToolSchema` | `packages/core/tools/src/index.ts`; `packages/core/tools/src/schema.ts`; `packages/core/tools/src/json-schema.ts`; `packages/core/tools/src/presentation.ts`; `ToolSchema` in `packages/llm/llm/src/types.ts` |
| 2. Skill provider | `SkillProvider` / `SkillCandidate` / `SkillDefinition`; rank constants | `packages/skill/skill/src/index.ts`; `packages/skill/skill-filesystem/src/index.ts` |
| 3. Subagent provider | `SubagentCapabilities`, `SubagentProvider`, `ResolvedSubagentStartRequest.descriptor`, `ContinuableCreateRequest` / `ContinuableCreateSpec`; `SubagentRuntime` | `packages/subagent/subagent/src/types.ts`; `packages/subagent/subagent/src/index.ts`; `packages/subagent/subagent/src/descriptor.ts` |
| 4. Session store / events | `SessionStore`, `Session`, `SessionEvent`, known-event catalog | `packages/core/session/src/index.ts`; `packages/core/session/src/types.ts`; `packages/core/session/src/known-event-types.ts` |
| 5. Cordis Config / StandardSchema | `Plugin.Base.Config` = `StandardSchemaV1` | `vendor/cordis/src/registry.ts`; `vendor/cordis/src/context.ts`; `vendor/cordis/src/service.ts` |
| 6. Bundle patch + client envelope/slots | `EntryOptions`; profile boot; slot contracts; client module registry | `vendor/loader/src/config/entry.ts`; `vendor/include/src/index.ts`; `packages/boot/app-boot/src/{profile.ts,index.ts}`; `packages/client/ui-conversation/src/client/contract/slots.ts`; `packages/client/ui-settings/src/client/contract/slots.ts`; `packages/client/modules/src/index.ts`; `packages/client/tsdown.client.ts` |

Conformance of these seams to the checkout is enforced by the read-only drift
detector `scripts/verify-dsh-contract.ts` (§9). Run against the checkout, it
reports every seam conforming (or a per-seam diff).

---

## 1. Executive summary for the implementer

- A dsh plugin is a **Cordis plugin**: a function `(ctx, config)`, a class
  `new (ctx, config)`, or an object `{ apply(ctx, config) }`, optionally with a
  `Config` schema, an `inject` dependency list, a `name`, and `provide`/`intercept`
  metadata. (`source:vendor/cordis/src/registry.ts`)
- The runtime `ctx` exposes services as properties. Relevant injected services for
  rolebox's adapters: **`ctx.tools`** (register tools), **`ctx.sessions`**
  (session lifecycle), **`ctx.agents`** (agent registry), **`ctx.subagents`**
  (subagent spawn seam), **`ctx.skills`** (skill registry, §4.6). All five
  services are `Service` subclasses mounted by loading the corresponding
  `@deepseek-ai/dsh-*` package as a plugin.
- Tools are registered via `ctx.tools.register(defineTool({...}))`. The `defineTool`
  contract requires a **typed value-schema DSL** for `parameters` and
  `output.schema` (NOT raw JSON Schema — see §3.3 for the raw-JSON-schema path),
  a mandatory `output.render(args, value)` returning `ContentBlock[]`, and an
  `execute(args, exec)` returning the canonical JSON value.
- The plugin is delivered to dsh as a **profile bundle**: an npm package whose
  `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  and ships a `cordis.patch.yml` containing an entry list with an `insert:` block
  (`{id, name, config, disabled}` entries). Bundles are installed with
  `dsh plugin --profile <name> add <package>` which **forwards to pnpm** and then
  reconciles `dsh.profile.bundles`. (§5)
- **Migration status (§6): complete.** rolebox now pins every `@deepseek-ai/dsh-*`
  dependency at `0.1.5-rc.1` and `@deepseek-ai/cordis` at `4.0.2`;
  `@deepseek-ai/dsh-client-runtime` is removed (zero references remain). The
  superseded `0.1.0-rc.6` published-tarball installability verdict is no longer
  part of this contract — the source checkout is the reference of record.

---

## 2. Cordis plugin conventions (`@deepseek-ai/cordis`, vendored at `4.0.2`)

### 2.1 What the package exports

`source:vendor/cordis/src/index.ts` re-exports `context`, `events`, `fiber`,
`logger`, `registry`, `service`, `utils`. Live runtime export check:

```
live: import * as cordis from '@deepseek-ai/cordis'
live: Object.keys → Context, CordisError, DisposableList, EventsService, Fiber,
      Inject, Logger, LoggerService, RegistryService, Service, ValidationError,
      buildOuterStack, composeError, createCallable, defaultFormatters, isBailed,
      isConstructor, isObject, joinPrototype, resolveConfig, symbols, ...
live: default → undefined  (no default export; named exports only)
```

Key named exports: **`Context`** (class + interface), **`Service`** (abstract
base class), **`Inject`** (decorator + namespace), **`Fiber`**, **`Logger`**,
**`EventsService`**, **`RegistryService`**.
(`source:vendor/cordis/src/index.ts`,
`source:vendor/cordis/src/registry.ts`)

### 2.2 Plugin entrypoint shapes

`source:vendor/cordis/src/registry.ts`:

```ts
export type Plugin<T = any> =
  | Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;

export namespace Plugin {
  interface Base<T = any> {
    name?: string;                       // fiber diagnostics + logger name
    Config?: StandardSchemaV1<any, T>;   // config validator (see §2.4)
    inject?: Inject;                     // required services; plugin waits for them
    provide?: string | string[];
    intercept?: Dict<boolean>;
  }
  interface Function<T> extends Base<T> { (ctx: Context, config: T): any; }
  interface Constructor<T> extends Base<T> { new (ctx: Context, config: T): any; }
  interface Object<T> extends Base<T> { apply(ctx: Context, config: T): any; }
}
```

Live-verified all three shapes run: function plugin `(ctx, config)`, class
plugin `new (ctx, config)`, object plugin `{ apply(ctx, config) }` —
`live: ctx.plugin(fn, {..}); ctx.plugin(Cls, {..}); ctx.plugin({apply}, {..})`.

### 2.3 Loading plugins: `ctx.plugin()` and `ctx.inject()`

`source:vendor/cordis/src/registry.ts` (module augmentation on `Context`):

```ts
ctx.plugin<P extends Plugin>(plugin: P, ...args): Fiber & PromiseLike<Fiber>;
ctx.inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
```

- `ctx.plugin(plugin, config)` validates `config` against `plugin.Config`, starts a
  fiber, returns a `Fiber` that is awaitable. `live: await ctx.plugin(fn, {name:'test'})`
  ran the body with defaults applied.
- `ctx.inject(['svc'], cb)` is shorthand for `ctx.plugin({ inject, apply: cb })`.
- Config validation is live-verified: a schemastery `z.object` schema applied
  defaults (`retries: 3`) and rejected an invalid value
  (`live: invalid config rejected: $.name expected string but got 42 (at name)`).

### 2.4 Config schemas: the schemastery fork

The `Config` field type is `StandardSchemaV1<any, T>` (the standard-schema
interface, `source:vendor/cordis/src/registry.ts`). The dsh packages use the
**`@deepseek-ai/schemastery` fork** (a republish of
[shigma/schemastery](https://github.com/shigma/schemastery)) as their schema
DSL. Verified from the vendored source:

- `@deepseek-ai/schemastery` default-exports a callable `Schema` function.
  (`source:vendor/schemastery/src/index.ts` — `export default Schema`)
- Factory methods: `string()`, `number()`, `natural()`, `percent()`, `boolean()`,
  `date()`, `regExp()`, `array(inner)`, `dict(inner, sKey?)`, `tuple([...])`,
  `object({...})`, `union([...])`, `intersect([...])`, `transform(inner, cb)`,
  `lazy(cb)`, `const(v)`, `from(v)`, `is(ctor)`, `any()`, `never()`, `extend(type, resolve)`.
  (`source:vendor/schemastery/src/index.ts`)
- Instance chainables: `required()`, `default(v)`, `description()`, `comment()`,
  `pattern(re)`, `min/max/step`, `hidden()`, `disabled()`, `role()`, `link()`,
  `set()`, `push()`, `i18n()`, `extra()`. (`source:vendor/schemastery/src/index.ts`)
- Schemas implement `'~standard'` (StandardSchemaV1). Verified:
  `live: obj['~standard'] → yes`, and a `z.object({...})` schema worked directly as
  a Cordis plugin `Config` (defaults applied + validation error surfaced, §2.3).
- The fork is a **fork of upstream schemastery** (`README.md` "Type Driven Schema
  Validator"), published under the `@deepseek-ai` scope.

Usage pattern in dsh-tools: `ToolRuntime.Config` is declared as `static Config: z<Config>`
(`source:packages/core/tools/src/index.ts`) where `z` is the schemastery default
import (`source:packages/core/tools/src/index.ts` —
`import z from '@deepseek-ai/schemastery'`).

### 2.5 `Context` API

`source:vendor/cordis/src/context.ts`:

- `Context` is a **proxy**: property reads resolve services (`ctx.tools`,
  `ctx.sessions`, ...); `extend(meta)`, `isolate(name, label?)`, `intercept(name, config)`
  create scoped child contexts.
- Built-in services on every context: `ctx.events` (event bus), `ctx.logger`
  (logger factory), `ctx.reflect` (service resolver/proxy backing), `ctx.registry`
  (plugin registry). (`source:vendor/cordis/src/context.ts`)
- `ctx.root` — the root context; `ctx.baseUrl` — base URL for relative module
  specifiers (set by the loader to the config directory, §5.4).
- Live-verified: `new Context()` boots with `root, baseUrl, fiber, reflect,
  registry, events, logger` present.

### 2.6 `Service` base class

`source:vendor/cordis/src/service.ts`:

```ts
export abstract class Service<out T = never> {
  protected ctx: Context;
  name: string;
  constructor(ctx: Context, name: string);   // registers this as ctx[name]
  static readonly init / check / config / invoke / extend / tracker / resolveConfig: unique symbol;
}
```

- Subclass constructor `super(ctx, name)` registers the instance as `ctx[name]`,
  auto-removed when the owning fiber unloads. All dsh services follow this:
  `ToolRuntime`, `SessionStore`, `AgentRegistry`, `SubagentRuntime`, `SkillRegistry`
  all `extends Service` with `static inject` (dependency services) and
  `static Config` (config schema).

---

## 3. Tool registry: `ctx.tools` (`@deepseek-ai/dsh-tools`, source)

### 3.1 Service mounting and interface

- Mounted by loading the package default export as a plugin:
  `await ctx.plugin(dshTools)`. The default export IS the `ToolRuntime` class
  (`source:packages/core/tools/src/index.ts` — `export default ToolRuntime`).
- `static inject = ['systemPrompt']` — **`ctx.tools` only mounts after a
  `systemPrompt` service exists** (`source:packages/core/tools/src/index.ts`).
  Live-verified: `ctx.plugin(dshTools)` alone leaves `ctx.tools` undefined;
  after mounting a stub `systemPrompt` service, `ctx.tools` is a `ToolRuntime`.
  In a full dsh profile this dependency is satisfied by the `@deepseek-ai/dsh-system-prompt`
  bundle row (see §5.5 example, `id: system-prompt`).
- Public API (`source:packages/core/tools/src/index.ts`):
  - `register(definition: ToolDefinition): () => void` — global or scope-local
    registration; returns the disposer.
  - `restrict(filter: ToolRestriction): () => void` — per-scope allow/deny mask.
  - `guard(guard: ToolGuard): () => void` — monotonic deny-after-pre-execute gate.
  - `get(name, scope?): ToolDefinition | undefined` — resolve as one scope sees it.
  - `schemas(scope?): ToolSchema[]` — model-facing schema projection (whitelists
    name/description/parameters only).
  - `execute(args, exec): Promise<unknown>` — dispatch a call through the full
    pipeline (the class-level execution method; see `ToolDefinition.execute`).
  - `presentAs(mode: ToolPresentationMode): () => void` — per-scope presentation
    mode (`'native' | 'ptc' | 'both'`).
  - Config: `mode?: ToolPresentationMode` (default `native`), `maxParallelSubCalls?: number`
    (default 10). (`source:packages/core/tools/src/index.ts`)

Live round-trip (stub systemPrompt):

```
live: ctx.tools.register(defineTool({name:'echo_test', ...}))
live: ctx.tools.get('echo_test') → ToolDefinition (present)
live: ctx.tools.schemas() → [{name:'echo_test', description, parameters}]  (name/description/parameters only)
live: ctx.tools.execute({callId, name, arguments:{text:'hi'}, signal}) → {isError:false, value:{echoed:'hi'}}
live: ctx.tools.execute({... arguments:{text:42}}) → {isError:true, error.message:'invalid arguments: "text" must be a string'}
live: disposer() → ctx.tools.get('echo_test') → undefined
```

### 3.2 `defineTool` signature and parameter schema DSL

`source:packages/core/tools/src/schema.ts`:

```ts
export function defineTool<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec
>(options: DefineToolOptions<S, O>): ToolDefinition;
```

`DefineToolOptions` (`source:packages/core/tools/src/schema.ts`):

```ts
{
  name: string;                       // unique tool name
  description: string;                // model-facing
  parameters: S;                      // ParameterSchemaSpec — per-property map
  output: {
    schema: O;                        // ValueSchemaSpec — canonical output
    render(args: InferArgs<S>, value: InferValue<O>): ContentBlock[];
    presentationMeta?(args, value): JsonValue;
  };
  timeoutMs?: number;                 // cooperative budget; never model-visible
  isConcurrencySafe?(args): boolean;
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>>;
  finalizeContent?(exec, result): ContentBlock[] | undefined;
  presentCall?(args): ToolCallView | undefined;
  presentResult?(args, result): ToolResultView | undefined;
}
```

**Parameter schema DSL** (`source:packages/core/tools/src/schema.ts`): the
parameters object is an implicit open object root; each property is a
`ValueSchemaSpec` (one of
`type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json' | oneOf`)
plus optional `required: true`, `description`, `title`, `default`, `examples`,
`enum`, `const`, `items`, `additionalProperties`. Requiredness is per-property
(`required: true`), never a top-level `required` array.

- `ParameterPropertySpec = ValueSchemaSpec & { required?: true }` (`source:packages/core/tools/src/schema.ts`)
- `ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }` (`source:packages/core/tools/src/schema.ts`)
- Value schemas compile to raw JSON Schema via `valueSchemaSpecToJsonSchema` /
  `parameterSchemaSpecToJsonSchema` (`source:packages/core/tools/src/schema.ts`);
  args are validated with `validateArgs(spec, args): string[]`
  (`source:packages/core/tools/src/schema.ts`).

**Live-verified DSL boundary**: passing a raw JSON-Schema `required` array inside
`output.schema` throws
`JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL`
— i.e. the DSL rejects raw JSON Schema keywords; use the DSL types or the explicit
raw-schema functions in §3.3.

### 3.3 Raw JSON-schema tool support

`source:packages/core/tools/src/json-schema.ts` — an **enforced JSON Schema subset**:

```ts
interface JsonSchemaNode {              // json-schema.ts:31-58
  type?: 'object'|'array'|'string'|'number'|'integer'|'boolean'|'null';
  oneOf?: JsonSchemaNode[];             // exact-one; ≥2 branches
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];                  // each must appear in properties
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  enum?: JsonSchemaScalar[];            // string|number|boolean|null
  const?: JsonSchemaScalar;
  description? / title? / default? / examples?: ...  // annotations, non-validating
}
```

- `assertSupportedJsonSchema(schema)` — accepts the subset, annotation-only
  schema = unconstrained JSON. (`source:packages/core/tools/src/json-schema.ts`)
- `assertObjectJsonSchema(schema)` — subset + object root (used by subagent
  `outputSchema`, §4.3). (`source:packages/core/tools/src/json-schema.ts`)
- `validateJsonSchemaValue(schema, value, path?)` — path-qualified violations.
  (`source:packages/core/tools/src/json-schema.ts`)
- The subset is enforced: unsupported/misplaced keywords **reject** rather than
  pass through (`source:packages/core/tools/src/json-schema.ts`).
- Tool *output* declaration always uses the value-schema DSL (`output.schema: O`);
  the raw JSON-schema path is for **external inputs** (e.g.
  `SubagentStartRequest.outputSchema`), validated through `assertObjectJsonSchema`.

### 3.4 `output.render` contract

- `ToolOutputDefinition` (`source:packages/core/tools/src/index.ts`):
  `{ schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }`
  — "Pure projection from validated arguments and value to Native/model content."
- `ToolDefinition.output` is **mandatory** (`source:packages/core/tools/src/index.ts`).
  `execute` must return a JSON value matching `output.schema`; violations throw
  `ToolOutputError` (`source:packages/core/tools/src/index.ts`).
- `ContentBlock` comes from `@deepseek-ai/dsh-llm`
  (`source:packages/core/tools/src/index.ts` re-exports;
  `source:packages/llm/llm/src/message.ts` +
  `source:packages/llm/llm/src/types.ts`):
  `{type:'text', text}`, `{type:'reasoning', text}`,
  `{type:'image', attachment}`, `{type:'tool-call', id, name, arguments}`,
  `{type:'tool-result', toolCallId, content, isError?}` — merge-extensible
  `ContentBlockMap`.
- Result contract (`ToolExecutionResult`, `source:packages/core/tools/src/index.ts`):
  success `{isError:false, value: JsonValue, content: ContentBlock[], meta?, additionalContexts?, concludesTurn?}`;
  failure `{isError:true, error: {message, info?: {name, code}}, content, meta?, additionalContexts?}`.
- Failure codes: `TOOL_ABORTED = 'ABORTED'` (body invoked then cancelled) and
  `TOOL_ABORTED_BEFORE_DISPATCH` (cancelled before body started)
  (`source:packages/core/tools/src/index.ts`). Live-verified both paths (§3.5).
- Presentation intents (`source:packages/core/tools/src/presentation.ts`):
  `ToolCallView` = `generic | terminal | diff` cards; `ToolResultView` = adds
  `search | read | web` cards. Pure, replayable, side-effect-free.

### 3.5 `exec.signal` / `exec.agent` / `exec.token` semantics

`ToolRunContext` (`source:packages/core/tools/src/index.ts`):

```ts
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;   // attach context to this call's result
  concludeTurn(): void;                       // mark result as terminal for the agent turn
}
```

`ToolExecution` / `ToolExecutionInput` (`source:packages/core/tools/src/index.ts`):

```ts
interface ToolExecutionInput {
  callId: CallId;                 // provider-issued call id (branded string)
  rootCallId?: CallId;            // root model-requested call (nested dispatchers propagate)
  name: string;
  arguments: unknown;             // lossless JSON, deep-frozen before policy
  agent?: Agent;                  // the agent on whose behalf the call runs
  parent?: ToolExecutionToken;    // set for SDK/transport sub-dispatches
  signal: AbortSignal;            // REQUIRED caller-owned cancellation
}
```

- **`exec.signal`** — required `AbortSignal`; async tool bodies must observe or
  forward it and settle only after owned work reaches quiescence. The registry
  cannot hard-kill same-process code
  (`source:packages/core/tools/src/index.ts`). Live-verified:
  aborting before the body starts → `{isError:true, code:'ABORTED_BEFORE_DISPATCH'}`;
  aborting after the body started (body observing `exec.signal`) →
  `{isError:true, code:'ABORTED'}`.
- **`exec.agent`** — optional `Agent` (from `@deepseek-ai/dsh-agent`); set by the
  agent loop; scope-filtered dispatch keys on it. The tool receives it in
  `ToolExecutionInput.agent`.
- **`exec.token`** — `ToolExecutionToken`, an opaque `symbol & { brand }`
  registry-assigned identity (`source:packages/core/tools/src/index.ts`);
  callers do not choose it; nested calls see only the parent's token as `parent`
  (`source:packages/core/tools/src/index.ts`).
- Events (for plugins that want to observe instead of dispatch):
  `tools/pre-execute` (allow/deny/ask waterfall), `tools/execute`
  (around-dispatch, may replace `exec.signal`), `tools/post-execute`
  (accept/replace/block), `tools/ptc-dispatch-log` (the PTC
  sub-dispatch waterfall — the `0.1.5` rename of the earlier
  `tools/code-dispatch-log`), `tools/result` (frozen final outcome),
  `tools/change` (registry changed).

### 3.6 `ToolSchema` base (model-facing projection)

`source:packages/llm/llm/src/types.ts`:

```ts
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema object for arguments
}
```

`ToolDefinition extends ToolSchema` and adds `output`, `execute`,
`finalizeContent?`, `timeoutMs?`, `isConcurrencySafe?`, `presentCall?`,
`presentResult?` (`source:packages/core/tools/src/index.ts`). `schemas()`
returns only the `ToolSchema` projection (execution/presentation callbacks never
model-visible).

### 3.7 Intentionally-unused optional surfaces (and why)

`defineTool`/`ToolDefinition` expose two optional fields rolebox deliberately
does NOT set. The decision is recorded here so a future maintainer does not
"fill them in" without the evidence they require:

- **`timeoutMs` — OMITTED.** `timeoutMs?: number` is a "cooperative tool-call
  timeout budget in milliseconds. Omit for no deadline. … Declaring it asserts
  this tool forwards `exec.signal` to a cooperative implementation that can reach
  quiescence when the signal aborts." (`source:packages/core/tools/src/index.ts`;
  same contract in `DefineToolOptions.timeoutMs`, §3.2). rolebox's dsh tools do
  not have a truthful fixed deadline — their work is caller-bounded dispatch, not
  a duration-bounded operation — so declaring a number would assert a deadline
  the tool cannot honor. Omitted; the harness's
  `@deepseek-ai/dsh-tool-call-timeout-policy` wrapper leaves the call unbounded.
- **`isConcurrencySafe` — SET ONLY FOR PROVABLY READ-ONLY TOOLS.** The classifier
  is a "pure synchronous classifier for overlap with sibling tool calls. Only
  `true` opts in; omission, exceptions, non-`true` returns, and invalid
  `defineTool` arguments are exclusive. Opted-in executions must not mutate
  parent-owned state." (`source:packages/core/tools/src/index.ts`).
  rolebox sets it to `true` only where the tool is provably read-only (no
  mutation of parent-owned state, no shared-state race); every other tool omits
  it and stays exclusive. It is never inferred.
- **`output.presentationMeta` / `presentCall` / `presentResult` — OMITTED WHERE
  NO TRUTHFUL DATA.** These are the pure, replay-safe projections: the durable
  result `meta` (`output.presentationMeta`), the pending-state call view
  (`presentCall`), and the completed-state result view (`presentResult`)
  (`source:packages/core/tools/src/index.ts`). rolebox emits them
  only for tools whose display data it actually holds — enumerated in
  `DSH_TOOL_PRESENTATION` (`src/platform/adapters/dsh/tool-factory.ts`)
  with the field-by-field rationale at
  `src/platform/adapters/dsh/tool-factory.ts`. For every other tool the
  field is absent, which is the honest dsh generic fallback — never an
  `undefined` placeholder.

All three groups of fields are never model-visible — `schemas()` whitelists only
`name`/`description`/`parameters` (§3.1) — so they cannot leak into the model's
view of the tool.

---

## 4. Sessions, agents, and subagents — public APIs needed by the adapters

### 4.1 `ctx.sessions` — session lifecycle (`@deepseek-ai/dsh-session`, source)

Mounted by `await ctx.plugin(dshSession)` → `ctx.sessions` is a `SessionStore`
(`source:packages/core/session/src/index.ts`):

```ts
class SessionStore extends Service {
  create(id?: SessionId, options?: CreateSessionOptions): Session;          // :930
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session;        // :962
  enter(session): () => void;                                               // :1028
  announce(session): void;                                                  // :1083
  flush(session): Promise<boolean>;                                         // :1137
  get(id): Session | undefined;                                             // :1170
  list(): Session[];                                                        // :1178
  fork(source, boundary?, childSessionId?): Session;                        // :1196
}
```

`Session` class (`source:packages/core/session/src/index.ts`):

```ts
class Session {
  static create(id, seed?, header?): Session;      // detached create :508
  static fromRestore(id, seed, header): Session;   // :530
  get id(): SessionId;                             // :470
  get seq(): SessionLogOffset;                     // :662 — next seq == log length
  get surface(): SessionSurface;                   // :452
  readonly header: SessionHeader;                  // :464 — format version, cwd, lineage, seed boundary
  append<T>(type, data, ...opts): SessionEvent<T>; // :703 — message append
  deriveMessages(): Message[];                     // :825 — LLM history from surface
  requestHeader(): EpochHeader | undefined;        // :769
  requestContext(): RequestContext | undefined;    // :790
}
```

**Message append** — `append(type, data, ...opts)`
(`source:packages/core/session/src/index.ts`):
- Surface event types (`source:packages/core/session/src/types.ts`):
  `'system/message' | 'user/message' | 'assistant/message' | 'tool/result'` —
  these REQUIRE a `surfaceOp` in `opts`.
- `SurfaceOp` (`source:packages/core/session/src/types.ts`): `'append'` or
  `{ op: 'replace', startSeq, endSeq }` (compaction).
- `SurfaceIntent = { surfaceOp, sourceEventSeqs? }`
  (`source:packages/core/session/src/types.ts`).
- Log-only event types (no surfaceOp): `turn/start`, `turn/end`, `step/start`,
  `step/end`, `tool/call`, `todo/write`, `request/header`, `request/context`,
  `session/end-seed`, and the rest of `SessionEventMap`
  (`source:packages/core/session/src/types.ts`). The earlier
  `assistant/chunk` no longer exists — the assistant stream now travels inside
  `assistant/message` (`stream: AssistantStreamRecord[]`) and the separate
  `assistant/attempt` event.
- Data must be lossless JSON; invalid data throws at the append site.
- `Message`/`UserMessage`/`AssistantMessage`/`ToolResultMessage` shapes come from
  `@deepseek-ai/dsh-llm` (`source:packages/llm/llm/src/message.ts`): each
  message has `{ id: MessageId, role, content: ContentBlock[], source }`.

Live round-trip:

```
live: ctx.sessions.create() → session-1 (auto id), seq 0
live: s.append('user/message', {content:[{type:'text',text:'hello'}], source:{kind:'user'}}, {surfaceOp:'append'})
live: s.append('assistant/message', {turn, step, message:{role:'assistant', content, source:{kind:'model',provider,model}}, stream:[]}, {surfaceOp:'append'})
live: s.append('tool/result', {turn, step, message:{role:'user', content:[{type:'tool-result',...}], source:{kind:'tool',callId}}, isError:false}, {surfaceOp:'append'})
live: s.deriveMessages() → 3 messages [user, assistant, tool]  (derived history correct)
live: ctx.sessions.get(s.id) === s → true; flush(s) → false (no persistence listener mounted)
```

Events (for persistence/telemetry plugins): `session/created`, `session/disposed`,
`session/event`, `session/flush`
(`source:packages/core/session/src/index.ts`). Persistence is a plugin
concern: subscribe `session/event`, drain on `session/flush`.

#### 4.1.1 Rolebox boundary rule — session-event write discipline

rolebox is a downstream, out-of-repo plugin: it consumes the harness session log
but must not extend the harness's event vocabulary. The boundary is:

- **MAY read harness logs.** Reading `session.events` / subscribing to
  `session/event` is permitted and is how rolebox derives session status, todos,
  and diffs (`session.ts`). Reads are non-mutating and never affect a log's
  reloadability.
- **MUST NOT append rolebox-owned state.** rolebox MUST NOT write its own event
  types — anything outside `KNOWN_SESSION_EVENT_TYPES`, such as the former
  `rolebox/active-role` — into the session log. The persistence read path refuses
  to interpret a log containing a type outside the catalog unless the event
  envelope carries `ignorable: true`
  (`source:packages/session/session-persistence/src/storage-contract.ts`), and
  the public `append()` surface exposes no option to set that marker — its
  `...opts` are `SurfaceIntent` only and the envelope is built internally with
  `{type, seq, time, data, ...surfaceMetadata}`
  (`source:packages/core/session/src/index.ts`; the `ignorable?` field is
  declared on `SessionEvent`, `source:packages/core/session/src/types.ts`,
  but not settable through `append`). Writing such an event would make the
  harness refuse to reload the session it just wrote. Durability for
  rolebox-owned state lives in a rolebox-owned sidecar under `.rolebox/state`
  (e.g. `active-role-store.ts`), never in the session log.
- **Only harness-catalog-declared types may be written.** Any
  `session.append(type, …)` call in rolebox MUST pass a type that is a member of
  `KNOWN_SESSION_EVENT_TYPES` — the event vocabulary generated from the harness's
  own `SessionEventMap`
  (`source:packages/core/session/src/known-event-types.ts`). This is
  enforced mechanically by `tests/platform/dsh-no-custom-session-events.test.ts`,
  which scans `src/platform/adapters/dsh/**` and `src/dsh-plugin.ts`; it resolves
  inline literals, named string constants, and non-interpolated template
  literals, and fails on any non-catalog or statically unresolvable type. The
  guard is pinned to the installed `@deepseek-ai/dsh-session` catalog, so an
  upgrade that moves the vocabulary re-runs the check against the new set.

This rule closes the defect where a rolebox-owned event made the harness refuse to reload the session log.

#### 4.1.2 Rolebox active-role durability — the sidecar

The concrete instance of the §4.1.1 boundary is the per-session **active-role**
selection. rolebox persists it in a rolebox-owned, workspace-scoped JSON sidecar
at `.rolebox/state/activerole-<dirHash>.json`
(`src/platform/adapters/dsh/active-role-store.ts`; schema `version: 1`,
`{ version, sessions: [{ sessionId, roleId, updatedAt }] }`), never in the
session log. The store is constructed from the workspace directory
(`process.cwd()`) and injected into the shared `ActiveRoleRef` at
`src/dsh-plugin.ts`; the holder hydrates synchronously from the sidecar
at construction, writes back best-effort on every switch, and is pruned on load
by TTL + a session cap. The switcher's `session/created` restore uses the
precedence **sidecar entry → read-only legacy-event adoption → fork
inheritance** via `header.parentSession` (`role-switcher.ts`); the legacy
adoption scans a loadable session's existing `rolebox/active-role` events and
copies the last selection into the sidecar — it never writes the log.

**Migration non-goal.** Pre-fix persisted logs that already contain the custom
event are already unreloadable by the current harness (`assertEventsSupported`),
and repairing them is a **harness-layer non-goal**: rolebox cannot make an
already-rejected log loadable and does not attempt to. Post-fix sessions reload
cleanly because they contain no custom event. The read-only adoption above is a
best-effort salvage for a session that is loadable in the running process; it is
not a log repair.

### 4.2 `ctx.agents` — agent registry (`@deepseek-ai/dsh-agent`, source)

Mounted by `await ctx.plugin(dshAgent)` → `ctx.agents` is an `AgentRegistry`
(`source:packages/core/agent/src/index.ts`):

```ts
class AgentRegistry extends Service {
  setFactory(factory: AgentFactory): () => void;         // :355  — loop registers the creation factory
  create(options: CreateAgentOptions): Promise<AgentHandle>;  // :388
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;  // :407
  register(agent: Agent): () => void;                    // :434  — record already-constructed agent
  enter(agent, owner): () => void;                       // :458  — insert without announcing
  announce(agent): void;                                 // :533
  get(id: SessionId): Agent | undefined;                 // :567
  isOwnedBy(id, owner): boolean;                         // :579
  list(): Agent[];                                       // :587
  roots(): Agent[];                                      // :597
  currentInitiator(): Agent | undefined;                 // :292
  requireInitiator(): Agent;                             // :305
  withInitiator<T>(agent, operation): T;                 // :324
  withoutInitiator<T>(operation): T;                     // :339
}
```

- **`AgentFactory`** (`source:packages/core/agent/src/index.ts`):
  `{ createAgent(ownerCtx, options): Promise<AgentHandle>,
  resume(ownerCtx, options): Promise<AgentHandle> }` — the loop implementation
  (`@deepseek-ai/dsh-agent-loop`) provides it via `setFactory`. Creation is
  delegated; `create()` rejects if no factory is registered.
- `AgentHandle = { agent: Agent; dispose(): Promise<void> }`
  (`source:packages/core/agent/src/index.ts`).
- `Agent` (`source:packages/core/agent/src/types.ts`): `{ id: SessionId,
  options: AgentOptions, session: Session, inbox: Inbox, status: 'idle'|'running',
  ctx: Context (agent-scoped), cancel(cause, opts?), whenIdle(), runMaintenance(task),
  send(msg, target, wakeup), followup(msg), steer(msg), inject(msg) }`.
- `AgentOptions = { provider?, model?, maxTokens? }`
  (`source:packages/core/agent/src/runtime-types.ts`).
- Events: `agent/created`, `agent/disposed`, `agent/status`, `agent/session-start`
  (`source:packages/core/agent/src/runtime-types.ts`, module augmentation).

Live-verified: `ctx.agents` mounts; `list()` empty; `currentInitiator()` undefined
outside an initiator boundary; `withInitiator` preserves the operation return;
`setFactory` returns a disposer.

#### 4.2.1 Rolebox model mapping → `AgentOptions` (provider + model)

`AgentOptions = { provider?, model?, maxTokens? }`
(`source:packages/core/agent/src/runtime-types.ts`) is the create/resume seed.
rolebox stores each role's `model:` as a canonical `provider/model-id` string
(`src/resolver/model-resolver.ts`; see the
[role.yaml reference](role-yaml.md#model-references)) and maps it at spawn time
in `DshAgentRegistrar`:

- The model string is split on the **first** slash by the shared `splitModel`
  helper (`src/platform/model-ref.ts`) into `provider` (segment before the
  first slash) and `model` (everything after, so multi-segment ids survive —
  e.g. `openrouter-anthropic/anthropic/claude-opus-4.8` → provider
  `openrouter-anthropic`, model `anthropic/claude-opus-4.8`). Both
  `AgentOptions.provider` and `AgentOptions.model` are set
  (`src/platform/adapters/dsh/agent-registrar.ts`).
- A bare name, `"default"`, or a malformed value (no slash / leading slash /
  trailing slash) has no split: it overrides `model` only and leaves the base
  `provider` untouched (the pre-split behavior).
- The per-session active-role seam reuses the same mapping: when a role is
  active for the session, its model override is split and merged over the
  definition's options (`agent-registrar.ts`), so a role switch routes
  the **next spawn** through the role's provider.

**Provider-route safety path (degrade, not fail).** Emitting a `provider` that
dsh has no registered llm adapter for would turn a working spawn into a hard
`NO_ADAPTER` dispatch failure (`source:packages/llm/llm/src/index.ts`; see
[dsh provider notes](dsh-provider-notes.md) §2/§4). When the plugin can resolve
the `ctx.llm` service, it probes `listProviders()` (the
`probeLlmRoutes`/`providerRoutes` seam in `src/dsh-plugin.ts`) and hands the
registrar a spawn-time route probe. If the split provider is absent from that
list, the registrar logs ONE warning and **degrades to a model-only override** —
leaving the base provider intact so the spawn inherits the runtime default route
instead of failing. A probe that throws is treated as "no routes registered"
(degrade). If no `ctx.llm` service is available (headless profiles, test
doubles), the split is emitted unchanged (the pre-safety behavior). This is the
actual fallback: it is best-effort and only fires when the llm service is
probeable — it is not a provider-validation guarantee.

**Known limitation — a role switch does not change the live session's model.**
The switch records the active role for the session and the override is applied
to **subsequent spawns** through the active-role seam; the currently running
session's model is not mutated. The `model` field on the `GET /rolebox/roles`
list item (`RoleSwitchRoleDto.model`,
`src/platform/adapters/dsh/web-role-switch-route.ts`)
is **display-only** — it reports the role's configured model for the UI and does
not participate in switching.

### 4.3 `ctx.subagents` — subagent spawn seam (`@deepseek-ai/dsh-subagent`, source)

Mounted by `await ctx.plugin(dshSubagent)` → `ctx.subagents` is a `SubagentRuntime`
(`source:packages/subagent/subagent/src/index.ts`). This is the **abstract
seam**: the concrete spawn providers
(`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork-in-process`, `-acp`) are
separate packages that register providers into it.

**Concrete providers in the base profile.** The dsh base bundle registers the
two in-process providers as profile rows
(`source:packages/bundle/base/cordis.patch.yml`):
`@deepseek-ai/dsh-subagent-spawn-in-process` with `providerName: spawn`
 and `@deepseek-ai/dsh-subagent-fork-in-process` with
`providerName: fork`. Each provider defaults its registry name to
that value (`source:packages/subagent/subagent-spawn-in-process/src/index.ts`
— `providerName: z.string().default('spawn')`;
`source:packages/subagent/subagent-fork-in-process/src/index.ts` —
`default('fork')`) and registers it via
`ctx.subagents.registerProvider(new …Provider(config.providerName))`
(`source:packages/subagent/subagent-spawn-in-process/src/index.ts`). A
deployed dsh profile therefore has at least `spawn` and `fork` in
`ctx.subagents.list()`. rolebox registers its own per-agent providers under the
agent ids and **delegates real spawning to one of these host providers by name**:
`DshAgentRegistrar.buildProvider().start()` forwards the resolved request to the
provider named by its `spawnProviderName` option (default `"spawn"`, wired from
config in `src/dsh-plugin.ts`), refusing recursion when that name
collides with a rolebox agent id
(`src/platform/adapters/dsh/agent-registrar.ts`).

```ts
class SubagentRuntime extends Service {
  registerProvider(provider: SubagentProvider): () => void;   // :509
  getProvider(name: string): SubagentProvider | undefined;    // :532
  list(): string[];                                           // :540
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;  // :556
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;   // :228
  sendMessage(sender, targetId, content, options): Promise<MessageId>;       // :246
  interrupt(targetSessionId, authority): void;                // :295
  drainContinuableDescendants(parents): Promise<void>;        // :309
  listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>;      // :349
  listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>; // :368
}
```

**`SubagentProvider`** (`source:packages/subagent/subagent/src/types.ts`):

```ts
interface SubagentProvider {
  name: string;                       // unique registry name (e.g. 'spawn', 'fork', 'acp')
  capabilities: SubagentCapabilities; // start-time features (see below)
  inheritsParentContext: boolean;
  agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;  // optional: continuable capability
}
```

**`SubagentCapabilities` — the five required keys.**
(`source:packages/subagent/subagent/src/types.ts`):

```ts
interface SubagentCapabilities {
  readonly agentOptions: boolean;
  readonly outputSchema: boolean;
  readonly depthLimit: boolean;
  readonly toolFilter: boolean;
  readonly persona: boolean;
}
```

All five are **required** on the interface. Each flag corresponds one-to-one to
a `SubagentStartRequest` option (`depthLimit` ↔ `maxDepth`; the other names
match). `SubagentRuntime.start()` validates the requested options against the
named provider's declared flags before delegating to `start()`, so a provider
that declares a flag the running harness does not know (or omits one it does)
can be rejected under version drift. rolebox avoids encoding the shape itself:
it advertises the capabilities its delegated host provider supports and
delegates at the provider level, forwarding the request to the host provider by
name (`{...request}`) rather than re-declaring or re-validating the host's
capability set (`src/platform/adapters/dsh/agent-registrar.ts`).
A capability-shape change in a future dsh line therefore needs no rolebox
change — the host provider and the dsh service that validates it own that
contract. The `SubagentCapabilities` key set is asserted exactly by
`scripts/verify-dsh-contract.ts` (§9).

**Required durable `descriptor`.** The service resolves the request to a
`ResolvedSubagentStartRequest` whose `descriptor: SubagentDescriptorData` is
required (`source:packages/subagent/subagent/src/types.ts`); a
session-backed provider persists it inside the child's initial turn as the
model-hidden `subagent/descriptor` session event
(`source:packages/subagent/subagent/src/descriptor.ts`). rolebox's mirror
must therefore model `descriptor` on the resolved request; the drift detector
asserts the `SubagentProvider` member set (with `prepareContinuable` allowed as
a source-only member — see §4.3.x).

**`SubagentStartRequest`** (`source:packages/subagent/subagent/src/types.ts`):
`{ label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, agentOptions?,
outputSchema?: ObjectJsonSchema, maxDepth?, toolFilter?: ToolRestriction, persona? }`.

**`SubagentRun`** (`source:packages/subagent/subagent/src/types.ts`):
`{ id: SessionId, localAgent: Agent | undefined, result: Promise<SubagentResult>,
dispose(): Promise<void> }` — `result` resolves (never rejects on child failure)
with `{ output: ContentBlock[], structured?: unknown, stopReason }` where
`stopReason ∈ { completed, aborted, error, 'max-tokens', refusal }`
(`source:packages/subagent/subagent/src/types.ts`).

Live-verified: `ctx.subagents` mounts; `registerProvider({name:'mock', capabilities:{…five keys…},
inheritsParentContext:false, start: async()=>{throw ...}})` → `getProvider('mock')` resolves;
disposer removes it.

Events: `subagent/provider-added`, `subagent/provider-removed`, `subagent/start`,
`subagent/end` (`source:packages/subagent/subagent/src/index.ts`).

#### 4.3.x Continuable children — fresh-start seeding (implemented)

The current dsh line splits a provider's participation in continuable children
out of `capabilities` and into a single optional method, `prepareContinuable`
(`source:packages/subagent/subagent/src/types.ts`). **Method presence IS
the continuable capability**: the service rejects continuable starts on a
provider without it, while a provider that has it may still serve ordinary
one-shot delegations. The method receives a `ContinuableCreateRequest`
(`source:packages/subagent/subagent/src/types.ts`) and returns a
`ContinuableCreateSpec` (`source:packages/subagent/subagent/src/types.ts`):

```ts
interface ContinuableCreateRequest {
  readonly sessionId: SessionId;   // the reserved durable child session id
  readonly parent: Agent;          // whose history a seeding provider reads
  readonly signal: AbortSignal;    // preparation-only cancellation
}
interface ContinuableCreateSpec {
  /** Completed-turn prefix of the parent's log to seed the child session with,
   *  or absent for a fresh child. Contiguous from seq 0, lossless JSON, balanced. */
  readonly seed?: readonly SessionEvent[]
}
```

The continuation manager — not the provider — owns identity reservation,
composition, Agent creation, prompt delivery, cold resume, ownership, and
disposal; the provider never sees the child's Agent, handle, turns, or teardown.
Distinct preparations may overlap; each follows its own signal
(`source:packages/subagent/subagent/src/types.ts`).

**rolebox implements continuable children with a FRESH-START seeding decision:
the child is NOT seeded with parent history.** rolebox's provider returns a
`ContinuableCreateSpec` with `seed` absent. The rationale is boundary discipline:
rolebox role children are independent department executors with their own role
prompt and context block (§4.5); seeding them with the parent's completed-turn
prefix would import a foreign agent's history into a child whose active role and
tools differ. A fresh child gets a clean `Session` (no inherited events) and the
rolebox-composed initial prompt, which is the behavior rolebox's dispatch
contract expects. The drift detector treats `prepareContinuable` as a
source-only member of `SubagentProvider` (`scripts/verify-dsh-contract.ts`,
`allowSourceOnly: ["prepareContinuable"]`) so the rolebox mirror need not model a
method it does not call for seeding.

**How dsh honors the fresh-start choice.** The `seed` field's ABSENCE is exactly
the fresh-start signal: the continuation manager reads `prepared.seed` at
`source:packages/subagent/subagent/src/continuation.ts`
(`undefined` → `inheritedEventCount` 0, `childSessionMeta(..., false)`), while a
present array is persisted through the child's `create.seed`. rolebox's
`DshAgentRegistrar.buildProvider().prepareContinuable` returns `{}` (an empty
spec) and touches none of `request`
(`src/platform/adapters/dsh/agent-registrar.ts`); the erased
compile-time guard `_DshContinuableFreshStartGuard`
(`src/platform/adapters/dsh/agent-registrar.ts`) fails
`bun run typecheck` if `seed` ever becomes required — which would make the
fresh-start choice inexpressible. The contract is pinned by
`tests/dsh-dispatch.test.ts` (continuable provider handling) and
`tests/platform/agent-registrar.test.ts`.

### 4.4 Web-UI extension: host route + browser slot plugin (source)

The role-switch UI ships as two halves: a **host route** on dsh's own web server
(the `/rolebox` REST API) and a **browser slot plugin** (`dsh.client` bundle that
mounts the dock into the web app). Both surfaces are verified against the
`0.1.5-rc.1` source checkout. The sidebar monitoring surface ships through the
same two halves: two read-only endpoints added to the `/rolebox` host API
(§4.4.6) and a `settings.section` monitoring page contributed by the same client
bundle (§4.4.7).

#### 4.4.1 Host webserver: `ctx.webServer.register` WebRoute shape

`source:packages/host/webserver/src/index.ts`:

```ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
  kind: WebRouteKind;
  path: string;                  // absolute pathname, no trailing slash
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
```

`register(route)` returns the disposer that unmounts the route
(`source:packages/host/webserver/src/index.ts`); duplicate `(kind, path)`
registrations throw (`webserver: duplicate prefix route "…"`,
`source:packages/host/webserver/src/index.ts`). rolebox consumes this surface
structurally (duck typing — never imports `@deepseek-ai/*`,
`src/platform/adapters/dsh/web-role-switch-route.ts`) and registers one
`{ kind: 'prefix', path: '/rolebox', handler }` route
(`web-role-switch-route.ts`). The service is optional: `apply()` probes
`ctx.get("webServer")` and skips route registration when absent (headless
profiles) (`src/dsh-plugin.ts`).

#### 4.4.2 `dsh.client` roster contract (node half)

`dsh-client-modules` is the node half that collects browser plugins: it scans the
enabled Loader entries for packages declaring `dsh.client`, resolves each
`exports["./client"]`, hashes the built bundle into the boot graph, and serves it
with its source map under `/plugins` (`source:packages/client/modules/README.md`).
The registry service (`ClientModuleRegistry`,
`source:packages/client/modules/src/index.ts`) recomposes on entry changes
and registers the `/plugins` bundle route plus an index tap that injects the
boot manifest (`source:packages/client/modules/src/index.ts`). The
per-package parse reads `pkg.dsh.client`, accepts only `platform: "web"`,
resolves the `./client` export, and records `inject` / `immediately`
(`source:packages/client/modules/src/index.ts`). rolebox's declaration
(`package.json`):

```json
"dsh": {
  "bundle": { "patch": "./dsh/cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-conversation",
               "@deepseek-ai/dsh-client-ui-settings",
               "@deepseek-ai/dsh-client-locale"]
  }
}
```

**Resolution precondition (the missing link this integration tripped on).** Before
parsing `dsh.client`, the registry resolves the package by the loader entry's
**name** (`fiber.entry.options.name`) through
`require.resolve('<name>/package.json')` from the host context
(`createRequire(ctx.baseUrl)`, `source:packages/client/modules/src/index.ts`);
an unresolvable name is cached as a permanent "not a client package" verdict
(`resolveMeta`, `source:packages/client/modules/src/index.ts`) and the entry
silently never reaches the boot graph. dsh's own roster rows use plain package
names (`@deepseek-ai/dsh-client-ui-goal`), so `<name>/package.json` resolves
naturally. rolebox's cordis plugin lives at the scoped sub-path export `./dsh`,
making its entry name `rolebox/dsh` — which is NOT a resolvable package spec on
its own. The packaging must therefore export `"./dsh/package.json"` →
`"./package.json"` (package.json), so
`require.resolve('rolebox/dsh/package.json')` lands on the root manifest carrying
the `dsh.client` declaration. And the browser half requires the bundle envelope
id to EQUAL the boot-graph row id (the entry name): `arrive()` rejects a bundle
that loads without registering its row id. The client bundle is therefore
wrapped with `id: "rolebox/dsh"` (scripts/build-dsh-web-client.ts) to match the
row — dsh's own bundles satisfy this trivially because their row name IS their
package name. Both sides of this contract are pinned by `tests/dsh-plugin.test.ts`
("dsh packaging exposes the dsh-client-modules resolution seam").

#### 4.4.3 Slot registry + `ctx.slots.inject` pattern

`source:packages/client/ui-slots/src/index.ts` documents the slot core:
`SlotCore.register(options, component)` (list/keyed/chain validation,
load-time throws, unload cascade) and the inject-bearing overload that
joins the registrant's business face into the component's composed props. The
runtime `SlotRegistry` service wraps it with cordis lifecycle — disposal through
`ctx.effect`, store-instance minting, the registrant stamp — and adds the
declaration-wait API:

```ts
// packages/client/ui-renderer/src/client/registry.ts:172
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
```

`inject` installs one effect per declaration lifetime of a slot (runs
synchronously when the declaration already exists, otherwise inside the declaring
`register()` call); the controller belongs to the caller's fiber, so plugin
unload cancels pending waits and removes active contributions
(`source:packages/client/ui-renderer/src/client/registry.ts`). The
canonical registrant posture — the one rolebox's client entry mirrors
(`src/platform/adapters/dsh/web-ui/client.ts`) — is
dsh-client-ui-conversation's QueueDock entry: `ctx.slots.inject(key, () =>
ctx.slots.register({name, id, order, locale}, Component))`
(`source:packages/client/ui-conversation/src/client/queue/QueueDock.tsx`).

#### 4.4.4 Declared seats

The conversation UI declares the input-zone region seats
(`source:packages/client/ui-conversation/src/client/contract/slots.ts`):

```ts
'conversation.input.dock': {        // :166 — full-width row above the composer
    kind: 'list'; scope: 'session'; owner: InputZone;
};
'conversation.composer.dock': {     // :170 — band under the composer card
    kind: 'list'; scope: 'session';
};
'conversation.input.left' / 'conversation.input.right':  // :172 / :174 — tool row ends
```

The broader roster also declares `conversation.session.header` /
`conversation.session.header.actions` / `conversation.session.header.utilities`
(`source:packages/client/ui-conversation/src/client/contract/slots.ts`).
rolebox mounts into `conversation.input.dock` (`client.ts`); the
`scope: 'session'` slot makes the inject factory resolve the definite session id
(`(sessionId) => ({ sessionId })`, `client.ts`).

#### 4.4.5 Client bundle format

Browser bundles are registered through the loader's global, emitted by the
shared tsdown preset (`source:packages/client/tsdown.client.ts`):

```js
// packages/client/tsdown.client.ts — emitted envelope shape
window.__ModuleLoader__.load({
    id: "@deepseek-ai/dsh-client-ui-commands",
    factory: (require) => { var module = { exports: {} }; ... return module.exports; },
});
```

The factory-form CJS model: executing the bundle only **registers** the factory;
module body side effects run at materialization (`factory(require)` → exports,
memoized in `loadCache`) — so require cycles throw and load order needs no
external sequencing (`source:packages/client/modules/README.md`). rolebox's build
(`scripts/build-dsh-web-client.ts`) bundles `web-ui/client.ts` with Bun
(`format: "cjs"`, `react` / `react/jsx-runtime` / `@deepseek-ai/*` external) and
wraps the output in this exact envelope with `id: "rolebox/dsh"`.

#### 4.4.6 Monitoring endpoints: `GET /rolebox/status` / `GET /rolebox/metrics`

The monitoring surface adds two **read-only** endpoints under the existing
`/rolebox` prefix route (§4.4.1) — no existing endpoint is touched. They are
dispatched by the same structural host-route module pattern:
`DshRoleboxMonitorWebRoute` (`src/platform/adapters/dsh/web-rolebox-monitor-route.ts`)
provides the handler and is composed with the role-switch surface into a single
`{ kind: 'prefix', path: '/rolebox', handler }` registration in `apply()` (after
the loop-coordinator block, whose live-loop census the monitor needs — see the
`Registration constraint` below) through the same `webServer` probe seam — so
headless profiles (no `webServer` service) skip registration exactly as the
role-switch route does (§4.4.1). The response composition below is the pinned
contract; every data source is rolebox's own in-process service:

**Registration constraint (real host).** The host webserver rejects a
duplicate `(kind, path)` registration
(`source:packages/host/webserver/src/index.ts`): a second `prefix /rolebox`
`register()` throws `webserver: duplicate prefix route "/rolebox"`. `apply()`
therefore composes the role-switch surface and the monitor surface into a SINGLE
`{ kind: 'prefix', path: '/rolebox' }` registration (after the loop-coordinator
block): the monitor route owns `/status` + `/metrics` and delegates every other
sub-path (`/roles*`) to the role-switch handler via its optional `delegate`
option (`web-rolebox-monitor-route.ts`). Both `webRouteRegistered` and
`monitorRouteRegistered` are set from this one registration outcome, so the
monitor endpoints are reachable on a real host. The route tests cover the
composed handler serving both surfaces, and `tests/dsh-plugin.test.ts` includes
a duplicate-rejecting registrar double (mirroring the real host) proving exactly
one `/rolebox` registration happens.

- **`GET /rolebox/status`** — composite runtime snapshot:
  - **loop summary** — `LoopCoordinator.getAllLoopStates()` (`src/loop/coordinator.ts`,
    `Map<string, LoopState>`: per-loop round state, status, termination);
  - **engine graph snapshot** — `readLiveEngineGraphs(stateDir)` (`src/cli/commands/monitor/monitor-reader-engine.ts`,
    `EngineGraphSnapshot[]`: live in-memory graph registry rows — the same feed
    the monitor TUI reads);
  - **sessions** — count + most recent ids from `DshSessionStoreLike.list()`;
  - **per-session active role** — `DshRoleSwitcher.getActive(sessionId)` (`src/platform/adapters/dsh/role-switcher.ts`,
    the session's active role id or `null` for the base agent).
- **`GET /rolebox/metrics`** — the in-process dispatch metrics snapshot
  `metrics.snapshot()` (`src/dispatch/persistence/metrics.ts`):
  `{ counters, gauges, histograms }` keyed by metric name; each
  counter/gauge entry is `{ value }` and each histogram entry is
  `{ buckets, sum, count }` (the optional `labels` field is declared on the
  snapshot types but never populated by `snapshot()` — labels fold into the
  entry key via `makeKey`, `metrics.ts`).

**`ROLEBOX_METRICS` gating.** The module-level `metrics` registry reads the env
var at construction (`metrics.ts` — `!!process.env.ROLEBOX_METRICS`). When
the var is **unset**, the registry still tracks only the core-named metrics —
counters `dispatch_rejected_total`, `dispatch_backpressure_retry_total`; gauges
`inflight_tasks`, `concurrency_queued` (`CORE_METRIC_NAMES`, `metrics.ts`)
— and `snapshot()` returns `{ counters, gauges, histograms: {} }` containing
exactly those core metrics **that have been touched** (`metrics.ts`) —
a process that has not dispatched yet returns
`{ counters: {}, gauges: {}, histograms: {} }` (the metrics-persister test
pins this: `tests/dispatch/metrics-persister.test.ts`). With
`ROLEBOX_METRICS` set it carries the full counter/gauge/histogram snapshot.
The endpoint itself is not gated by the env var — only the payload richness
varies; whether the route is reachable at all on a real host is governed by
the registration constraint below.

**Error contract** — the same stable JSON error shape as the role-switch route
(§4.4.1, `web-role-switch-route.ts`): every non-2xx response is JSON
with `{ "ok": false, "error": string }`. The monitor handler itself emits
`404` (unknown route under `/rolebox`), `405` (known path, wrong method), and
`500` (unexpected failure — the handler never rejects; every branch is guarded
so a failing handler yields stable JSON instead of a bare socket teardown).
`400` and `413` are NOT part of the monitor surface: both endpoints are pure
`GET` reads that never buffer a request body (unlike `POST /rolebox/roles/switch`,
which owns the 64 KiB body cap), so those two role-switch codes cannot fire
here. Both endpoints have no mutation surface.

#### 4.4.7 `settings.section` monitoring page entry

The monitoring panel is the client bundle's **second** slot contribution — the
existing `conversation.input.dock` dock registration (§4.4.4) is untouched.
`src/platform/adapters/dsh/web-ui/client.ts` adds, alongside the dock, the
canonical QueueDock registrant posture (§4.4.3) targeting the settings page
seat:

```ts
ctx.slots.inject("settings.section", () =>
  ctx.slots.register(
    { name: "settings.section", id: "rolebox-monitor", order: 90, label: "Monitoring" },
    RoleboxMonitorPanel,
  ),
);
```

The `settings.section` seat is declared by `@deepseek-ai/dsh-client-ui-settings`
(`source:packages/client/ui-settings/src/client/contract/slots.ts`):

```ts
'settings.section': {
    kind: 'list';
    scope: 'root';
    owner: SettingsSectionOwnerProps;   // { close: () => void } — slots.ts:123
};
```

The declaration's contract comment
(`source:packages/client/ui-settings/src/client/contract/slots.ts`): "One
settings page per list entry. Registrant options carry the nav identity: `id`
(section key, drives `only` filtering), `order` (nav position), `label`
(registrant-localized display text …). Sections render inside the panel content
column." The `SettingsSectionOwnerProps` owner share
(`source:packages/client/ui-settings/src/client/contract/slots.ts`) hands the
registrant `close: () => void` — the panel may close the settings shell; the
shell owns the open state.

- **Entry metadata** — slot key `settings.section`; list-kind entry `id`
  `rolebox-monitor`; `order` `90` (after the stock sections); `label`
  `Monitoring`. The `scope: 'root'` slot means the inject factory receives **no
  definite session id** — unlike the session-scoped `conversation.input.dock`
  (§4.4.4, whose inject factory resolves `(sessionId) => ({ sessionId })`) —
  so the panel hydrates the session dimension itself from `GET /rolebox/status`.
- **Posture** — mirrors the QueueDock entry exactly (§4.4.3): `ctx.slots.inject`
  waits on the declaration; `register` runs inside the injection callback, so
  the contribution tracks the declaration across independent activation and
  reload.
- **Graceful degradation** — if the `settings.section` declaration is absent
  (a profile without the settings feature), the inject effect never fires, the
  contribution does not mount, and the plugin stays healthy — the same
  declaration-wait semantics as §4.4.3; the dock contribution is unaffected.
- **Why `settings.section` and not the sidebar list** — the dsh sidebar column
  (session list + foot) exposes no third-party list slot; `settings.trigger`
  (the sidebar-foot trigger) is single-kind and occupied by the settings
  feature itself. The sidebar gear → settings panel → `settings.section` page
  is the only additive sidebar-reachable seat, so the monitoring page lives
  there. The panel (`src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx`
  + `rolebox-monitor-panel.css.ts`) fetches `GET /rolebox/status` and
  `GET /rolebox/metrics` same-origin (relative paths on the dsh web server)
  and renders the engine-graph / loop / metrics readings with
  loading/error/empty states.
- **Attention-first posture** — the body leads with a derived verdict band
  ("N need attention" / "All clear") before it lists any evidence, because the
  page is opened under time pressure. Every raw backend phase renders beside a
  normalised state word (`Running`/`Blocked`/`Stopped`/`Complete`/`Failed`/
  `Idle`/`Unknown`) so neither the engine phase vocabulary
  (`idle | executing | complete`) nor the eight-state loop machine has to be
  memorised. `cancelled`/`interrupted` are `Stopped`, deliberately not
  `Failed` — the run stopped, it did not break.
- **Honest verdicts** — the band claims `All clear` only when every phase was
  actually classified. A phase the classifier cannot read is named in the band
  (`N state unrecognized`) rather than silently dropped, because a monitoring
  surface that under-reports is worse than one that over-reports.
- **Terminal graphs keep their own verdict** — `nodeStatusCounts` is a snapshot
  of node statuses that OUTLIVE the run (a cancelled or timed-out node stays in
  the map for the life of the session, and a graph can legitimately complete
  with one present). No node count may therefore raise the verdict once
  `phase === "complete"` — **except `blocked`**, which the engine
  deliberately leaves for the human when a graph is cancelled, and which
  therefore still raises the verdict on a terminal graph. Without that
  carve-out a finished graph would pin a permanent red band beside its own green
  `Complete` chip, and alarm fatigue is the one failure mode a monitoring
  surface cannot afford; with too broad a rule the panel would instead hide a
  pending approval gate behind the same green chip. On a LIVE graph the same
  node statuses do raise the band: `escalate` (a NodeStatus the host's own
  renderer paints as an error — a node waiting on a human) reports as
  `Blocked`, and a failed, timed-out or cancelled node reports as `Failed`.
- **Reference data is demoted, not hidden** — metric groups cap at
  `GROUP_ROW_LIMIT` rows behind an accessible "Show all N" disclosure, and the
  first load shows a content-shaped skeleton in place of the former bare text
  line while a refresh keeps the existing data on screen.
- **Dock focus restoration** — a successful switch or clear collapses the
  disclosure out from under the row the user just activated, which would drop
  keyboard focus to `<body>`. The dock therefore holds exactly one ref, on the
  header toggle, and returns focus to it after a successful mutation. That is
  the module's only DOM interaction, and it is deliberate: every other rule
  (no measurement, no scroll listeners, no other DOM reads) still holds.

### 4.5 Session-level system-prompt registration (`rolebox:role` / `rolebox:context`)

The model-facing system prompt is composed EXCLUSIVELY by the mounted
`systemPrompt` service — the `@deepseek-ai/dsh-system-prompt` registry that
`ctx.tools` waits for (`static inject: ["systemPrompt"]`, §3.1; mounted in a
full profile by the `system-prompt` bundle row). Its `SystemPrompt` service is at
`source:packages/core/system-prompt/src/index.ts`; `section()`,
`context()`, and `renderPrompt()`. rolebox's session-level
role injection registers two contributions into it via `DshSystemPromptAdapter`
(`src/platform/adapters/dsh/system-prompt.ts`, wired by
`src/dsh-plugin.ts`):

- **Section `rolebox:role` — `order: 50`** — renders the ACTIVE role's full
  `systemPrompt` for the current session (`resolveActiveRolePrompt`). The
  provider resolves PER-SESSION through the render context: `context.agent.id`
  (the model-facing agent) must be present, then the session id (dsh spelling
  `sessionID`, rolebox spelling `sessionId`, or — on the real harness assembly
  context `{ agent, scope }`, where the agent is the session — the agent's own
  `id`), then the shared per-session `ActiveRoleRef` (`activeRole.get(sessionId)`
  — the same holder the role switcher writes and the registrar reads at spawn),
  then the registrar's definition lookup. Returns `''` when no role is active;
  the registry's `renderPrompt` drops empty sections, so the base agent's prompt
  is unchanged.
- **Context entry `rolebox:context` — `order: 0`** — renders the active role's
  available-functions block (`buildAvailableFunctionsBlock`), the
  session-level analog of the registrar's spawn-time context provider
  (agent-registrar.ts, §4.3). Also `''` when nothing applies, dropped the
  same way.

Ordering mirrors the spawn-time `composePrompt` convention (context leads,
role prompt follows): the context entry (order 0) renders AHEAD of the role
section (order 50).

**Graceful degradation** — the `systemPrompt` service is OPTIONAL. `apply()`
probes it structurally (`probeSystemPrompt`, `src/dsh-plugin.ts` —
`ctx.systemPrompt` property or `ctx.get("systemPrompt")`, both duck-typed)
and registers the contributions only when the service is present. Full
profiles mount it; headless profiles have no model-facing prompt assembly, so
the probe returns absent, `apply()` logs a warning ("No systemPrompt service
on ctx — role prompt injection disabled") and keeps booting — the same
degradation shape as the `webServer` seam (§4.4.1). The service is
deliberately NOT in the `inject` roster, so it can never gate plugin
activation. Each `section()` / `context()` call returns a disposer; the
adapter collects them and releases them on fiber unload (`dispose()`).

### 4.6 Skill registry: `ctx.skills` — the rolebox skill-provider seam

Under dsh the role prompt's `<available_skills>` block is resolved EXCLUSIVELY
through the `@deepseek-ai/dsh-skill` registry (`ctx.skills`), a layered merge of
provider catalogs. rolebox registers one LAZY skill provider into it so every
advertised skill name is resolvable by the `skill` tool. This section records the
verified `0.1.5-rc.1` source surface that the provider
(`src/platform/adapters/dsh/skill-provider.ts`) is built against.

#### 4.6.1 Service shape and the registration seam

- `ctx.skills` is a `SkillRegistry` service
  (`source:packages/skill/skill/src/index.ts`), added to `Context` by module
  augmentation (`source:packages/skill/skill/src/index.ts`); the package
  default export IS `SkillRegistry`
  (`source:packages/skill/skill/src/index.ts`). The row is optional: a
  profile that does not mount it has no `ctx.skills`, and rolebox's provider is
  simply not registered (`src/dsh-plugin.ts`).
- The plugin seam is a FACTORY, not a value
  (`source:packages/skill/skill/src/index.ts`):

  ```ts
  registerProvider(
    create: (control: SkillProviderControl) => SkillProvider,
  ): () => void;
  ```

  `create` is invoked once, synchronously, during the registering plugin's
  `apply()`; the returned function is the exact Cordis effect disposer that
  unregisters the provider and invalidates catalog caches
  (`source:packages/skill/skill/src/index.ts`).
- rolebox consumes only this seam, structurally (no `@deepseek-ai/*` import):
  `DshSkillRegistryLike` (`src/dsh-plugin.ts`), probed at
  `src/dsh-plugin.ts`, invoked at `src/dsh-plugin.ts` with the
  factory from `createDshSkillProviderFactory` (`skill-provider.ts`).
  The registration control is held so a role switch can call `invalidate()`
  (`skill-provider.ts`).

**Why a provider, not `ctx.skills.register()`.** The eager path —
`register(skill: SkillRegistration): () => void`
(`source:packages/skill/skill/src/index.ts`) — requires an eager `content`
body: `SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> &
{ content: string }` (`source:packages/skill/skill/src/index.ts`) and
`SkillDefinition.content` is a required markdown string
(`source:packages/skill/skill/src/index.ts`). Every role's every skill body
would be read at boot. `registerProvider` is lazy — `list()` advertises metadata,
`get()` loads the body only on invocation — matching how Pi
references skill files and reads them on demand.

#### 4.6.2 Verified signatures

```ts
// packages/skill/skill/src/index.ts
export interface SkillLookupOptions {                 // :105-116
  readonly cwd?: string | undefined;                  // :109
  readonly signal?: AbortSignal | undefined;          // :113
}

export interface SkillProviderControl {               // :272-278
  readonly signal: AbortSignal;                       // :274
  readonly invalidate: () => void;                    // :276
}

export interface SkillProvider {                      // :249-270
  readonly name: string;                              // :251
  list(options: SkillLookupOptions):
    Promise<readonly SkillCandidate[] | SkillProviderObservation>;   // :261
  get(candidate: SkillCandidate, options: SkillLookupOptions):
    Promise<SkillDefinition | undefined>;             // :269
}

export interface SkillCandidate extends SkillSummary {  // :75-86
  readonly rank: number;                              // :77
  readonly locator: unknown;                          // :81
  readonly path?: string;                             // :83
  readonly metadata?: Readonly<Record<string, unknown>>; // :85
}
```

`SkillSummary` (`source:packages/skill/skill/src/index.ts`) supplies
`name`, `description`, `whenToUse?`, `invocation`, `source`, `provider`,
`resourceBase?`. `SkillInvocationPolicy` is `{modelInvocable, userInvocable}`
(`source:packages/skill/skill/src/index.ts`). `SkillSource` is an open
union of the reserved buckets plus `(string & {})`
(`source:packages/skill/skill/src/index.ts`), so rolebox's custom
`"rolebox"` source is legal (`skill-provider.ts`). `SkillViewOptions` adds
`scope?: ScopeKey` for the REGISTRY read path
(`source:packages/skill/skill/src/index.ts`).

#### 4.6.3 Name grammar and the catalog-poisoning failure mode

- The grammar is kebab-case, `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
  (`source:packages/skill/skill/src/index.ts`), exposed as `isSkillName`
 and documented on `SkillSummary.name` as "kebab-case identifier".
rolebox role ids such as `emperor--chancellor` are NOT
  grammar-valid (`skill-provider.ts`).
- `validateCandidate` (`source:packages/skill/skill/src/index.ts`) throws
  on a grammar-violating name, a non-string or EMPTY description, an
  invalid `rank`, and a `provider` field that differs from the
  registered provider name.
- **Catalog poisoning.** `validateCandidate` is called from the
  provider-collection loop (`source:packages/skill/skill/src/index.ts`) but
  is not wrapped by the per-provider `try/catch` that guards `provider.list()`:
  a throwing `list()` is caught and skipped, but a malformed RETURNED candidate
  throws out of collection entirely — one bad candidate rejects every `list()`.
  rolebox therefore pre-filters by grammar with one warning per rejected name
  (`skill-provider.ts`), dedupes by name first-wins,
  falls an empty description back to the name, and echoes its own
  provider name on every candidate.

#### 4.6.4 Rank landscape and rolebox's rank-450 choice

Duplicate names are ordered by `rank`, then provider registration order, then
local order (`source:packages/skill/skill/src/index.ts`); only after that
sort is the first entry kept.

| Bucket | Rank | Citation |
|---|---|---|
| project-dsh | 100 | `source:packages/skill/skill-filesystem/src/index.ts` |
| project-agents | 200 | `source:packages/skill/skill-filesystem/src/index.ts` |
| runtime | 250 | `source:packages/skill/skill/src/index.ts` |
| custom | 300 | `source:packages/skill/skill-filesystem/src/index.ts` |
| user-dsh | 400 | `source:packages/skill/skill-filesystem/src/index.ts` |
| user-agents | 500 | `source:packages/skill/skill-filesystem/src/index.ts` |
| **rolebox** | **450** | `skill-provider.ts` |
| bundled | 600 | `source:packages/skill/skill/src/index.ts` |

**Rationale for 450.** Lower rank wins. Placing rolebox at 450 puts a
role-declared skill ABOVE the generic `custom` (300) and `runtime` (250)
buckets — the user explicitly configured these role skills, so they should win a
collision with an unrelated custom/runtime entry — while staying BELOW `bundled`
(600), so a first-party shipped skill keeps precedence on a name it deliberately
claims. rolebox skills are user-configured role knowledge: more specific than
the generic buckets, but not first-party harness content.

#### 4.6.5 Scope layering rule

A registration files into the layer of its CALLING context's scope: host rows
and repository plugins land in the GLOBAL layer, while a plugin mounted by an
agent preset's standing composition lands in that preset's layer. A read merges
the global layer with the viewing scope's chain — the nearest layer's entry wins
a duplicate name OUTRIGHT, and rank decides duplicates only WITHIN one layer
(`source:packages/skill/skill/src/index.ts`).

#### 4.6.6 Per-workspace, NOT per-session (verified limitation)

- A provider's `list()`/`get()` receive `SkillLookupOptions` = `{cwd?, signal?}`
  only (`source:packages/skill/skill/src/index.ts`). The registry reads
  the wider `SkillViewOptions` (`scope?`), but providers receive the
  same borrowed options object and read only their `SkillLookupOptions` contract
  from it — a provider CANNOT see the calling session or agent.
- rolebox's active-role selection IS per-session: `ActiveRoleStore` persists
  `{ version, sessions: [{ sessionId, roleId, updatedAt }] }`, keyed by
  `sessionId` (`src/platform/adapters/dsh/active-role-store.ts`),
  read through the `ActiveRoleRef.snapshot()` seam (`skill-provider.ts`;
  `src/platform/adapters/dsh/role-switcher.ts`).
- Because it cannot receive a session id, the provider advertises the
  workspace-wide union: the skills of {roles active in ANY recorded session}
  plus {the promoted default role}, walking each role's own skills and then its
  `subagents[].skills` recursively (`skill-provider.ts`). The
  result is per-workspace, not per-session.
- **Per-session precision is unreachable through the registration rolebox
  performs.** It would require registering a provider from a context scoped to
  the specific dsh agent object, so the registry files it into that agent
  preset's layer and a read from that scope sees it
  (`source:packages/skill/skill/src/index.ts`). Only an agent preset's
  standing composition mints such a context; rolebox registers once from the
  plugin's global context (`src/dsh-plugin.ts`). The limitation is
  structural, not a rolebox gap.
- Graceful degradation: an absent `ctx.skills` is a no-op, never a boot gate
  (`src/dsh-plugin.ts`); the service is deliberately not in the
  `inject` roster (`src/dsh-plugin.ts`).

---

## 5. Profile bundle contract for a NON-workspace package (`@deepseek-ai/dsh` + `dsh-app-boot`)

### 5.1 Layout: `$DSH_HOME` and profiles

- `DSH_HOME_ENV = 'DSH_HOME'`; default home is `join(homedir(), '.dsh')`; display
  form `~/.dsh`. (`source:packages/util/home-paths/src/index.ts`)
- `resolveDshHome(configured?, env?)` precedence: explicit configured path >
  `$DSH_HOME` (non-blank) > `~/.dsh`; blank env treated as unset.
  (`source:packages/util/home-paths/src/index.ts`)
- Profiles live under `$DSH_HOME/profiles/<name>` (`PROFILES_DIR = 'profiles'`,
  `source:packages/boot/app-boot/src/profile.ts`; `resolveProfileDir`).
- Profile directory contains: `package.json` (deps + `dsh.profile.bundles` list),
  `cordis.patch.yml` (user's own patch layer), and a pnpm workspace
  (`pnpm-workspace.yaml`: `nodeLinker: hoisted`, `autoInstallPeers: false`).
  (`source:packages/boot/app-boot/src/profile.ts`; `initProfile` writes
  manifest + patch template + workspace)

### 5.2 Bundle package contract (`dsh.bundle`)

A **bundle** is any npm package whose `package.json` declares
(`source:packages/boot/app-boot/src/profile.ts`):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

- `patch` is a **relative path** (from the package root) to the bundle's patch file.
- Resolution: bundle name resolves **installation-anchor first, then the profile
  directory** (`resolveBundleDir`,
  `source:packages/boot/app-boot/src/profile.ts`). So an in-box bundle
  always comes from the same dsh installation; an out-of-tree
  (profile-installed) bundle resolves from the profile's `node_modules`
  (pnpm-managed).
- Loading (`loadProfile`, `source:packages/boot/app-boot/src/profile.ts`):
  for each name in `dsh.profile.bundles`, read the package's `dsh.bundle.patch`,
  join to the package dir, parse that patch file; a listed bundle **without**
  `dsh.bundle` fails loud ("declares no dsh.bundle in its package.json").
- **Reference bundle**: `@deepseek-ai/dsh-base` ships `cordis.patch.yml` and
  declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` in its
  package.json (`source:packages/bundle/base/package.json`).

### 5.3 `cordis.patch.yml` entry shapes

Patch files are YAML arrays of loader patch entries (the `cordis-plugin-include`
`PatchOptions`, `source:vendor/include/src/index.ts`):

```yaml
- id: <row-id>                      # target an existing row (config override / disable)
  config: {...}
  disabled: true

- insert:                           # insert one or more new rows
    - id: <row-id>
      name: <module-specifier>      # package name or relative module
      config: {...}
      disabled: false
```

- `EntryOptions` (what a row becomes after patching),
  `source:vendor/loader/src/config/entry.ts`:
  `{ id: string, name: string, config?: any, group?: boolean|null, disabled?: boolean|null, inject?: Inject|null }`.
- `!!js <expression>` scalars are evaluated by the loader at activation time
  (e.g. `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
  `!!js dshHomePath('sessions')`, `!!js process.platform === 'win32'`) — the
  entry-list YAML dialect is `entryListSchema` from
  `source:vendor/include/src/index.ts`.
- Patch semantics (`applyEntryPatches`, `source:vendor/include/src/index.ts`):
  patches apply in order over the entry list; an `id`-targeted patch replaces
  the row's config **per-key, with no deep merge** — the override object is
  assigned field-by-field onto the row, so a `config:` override replaces the
  ENTIRE config object (any bundle-provided keys not re-declared in the override
  are lost); a patch matching nothing warns and is skipped;
inserted rows can be targeted by later patches.
  Live-verified with `applyEntryPatches` directly (config replaced, insert
  appended, unknown-id warned).
- A `name` can be a **bare package name** (`@deepseek-ai/dsh-tools`), a scoped
  sub-path (`@deepseek-ai/dsh-tool-subagent-control/list-agents`), or a relative
  module (`./foo.js`) resolved against `ctx.baseUrl` (the profile directory).
  (`source:packages/bundle/base/cordis.patch.yml` rows; loader `EntryTree.import`)

### 5.4 How the tree composes (boot order)

The profile tree is composed **over an empty root** `[]` (written to
`cordis.yml` as `# ... an empty entry list ...`), in this layer order
(`source:packages/boot/app-boot/src/profile.ts` module doc; boot in
`source:packages/boot/app-boot/src/index.ts`):

1. each bundle's patch list, in `dsh.profile.bundles` order;
2. the profile's own `cordis.patch.yml`;
3. the home-level `$DSH_HOME/cordis.patch.yml` (applies to every profile);
4. `--patch <path>` overlays (argv order);
5. the telemetry switch patch (`DSH_TELEMETRY_DISABLED` → disable the
   `session-telemetry-otel` row).

Mechanics: `composeEntries(layers)` = `applyEntryPatches([], layers.flat())`
(`source:packages/boot/app-boot/src/profile.ts`); `boot()` creates a root
`Context`, sets `ctx.baseUrl` to the config dir, provides `ctx.dshHomePath`, loads
the `Loader` plugin, mounts a root include (`cordis:include` with the patch
list), and awaits the tree (`source:packages/boot/app-boot/src/index.ts`).
Live-verified end-to-end with the real CLI:

```
live: DSH_HOME=/tmp/... dsh --profile headless --dump-default-config
live: → "# == @deepseek-ai/dsh-base" ... rows; hmr disabled by @deepseek-ai/dsh-headless overlay
live: dsh plugin --profile testp add /tmp/dsh-contract/test-bundle   (local bundle declaring dsh.bundle)
live: → profile auto-initialized, pnpm install ran, dsh.profile.bundles now:
live:   ["@deepseek-ai/dsh-base", "@dsh-contract-test/test-bundle"]
live: dsh --profile testp --dump-default-config
live: → "# == @dsh-contract-test/test-bundle" with the bundle's insert rows composed
```

### 5.4.1 rolebox plugin config options

Every option is optional — the rolebox plugin activates with the dsh-home
defaults alone (`roleboxDir` / `skillsDir` resolved on top of
`dshPlatformPaths()`, see §5.1):

| Option | Type | Default | Description |
|---|---|---|---|
| `roleboxDir` | `string` | `{dsh home}/rolebox` | Directory containing `role.yaml` files |
| `skillsDir` | `string` | `{dsh home}/skills` | Global skills directory |
| `defaultRole` | `string` | — | Role id (directory name) promoted to primary mode |
| `enabledNamespaces` | `string[]` | all | Tool allow-list: exact tool names or namespace prefixes (e.g. `hashline`, `graph`); `"*"` or absent registers every assembled tool |

Set them by patching the rolebox row's `config` from the profile's own
`cordis.patch.yml` (applied after every bundle layer, §5.4):

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: rolebox
  config:
    roleboxDir: /absolute/path/to/roles
    enabledNamespaces: ["asset", "graph", "hashline", "loop", "memory", "reference", "session", "signal"]
```

Because an `id`-targeted patch replaces the row's config wholesale (§5.3), keys
the bundle layer declared are lost unless re-declared in the same patch. A fully
configured example ships at `examples/dsh/cordis.patch.yml`.

### 5.4.2 Global `web_search` / `web_fetch` collision (verified at boot)

The dsh base profile already registers a **global** `web_search` / `web_fetch`
tool (via `@deepseek-ai/dsh-tool-web`). dsh's tool registry rejects duplicate
global tool names, so registering rolebox's own `web_search` / `web_fetch` /
`web_read` on top fails boot with:

```text
tool "web_search" is already registered
```

**Mitigation:** exclude the colliding `web` namespace from rolebox's
`enabledNamespaces` in the profile patch and let dsh's own web tools serve — or
choose an allow-list that avoids the overlap (see §5.4.1 for the option itself).

### 5.5 `dsh plugin add` reconcile behavior

`dsh plugin` is a **thin pnpm forwarder** (`apps/cli/src/plugin.ts`):

1. `runPlugin(profile, args)` resolves the profile dir; if no `package.json`,
   `initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)`
   (`source:packages/boot/app-boot/src/profile.ts`). Templates: `web` →
   `[dsh-base, dsh-web-app]`, `headless` → `[dsh-base, dsh-headless]`; default →
   `[dsh-base]` (`source:packages/boot/app-boot/src/profile.ts`).
2. Forwards args verbatim to `pnpm` with cwd = profile dir
   (`spawnSync('pnpm', args, {cwd: dir})`, `apps/cli/src/plugin.ts`). Relative
   path specs (`.`, `../x`) are anchored to the invoking directory
   (`anchorPathSpec`, `apps/cli/src/plugin.ts`). `dsh plugin --profile <name>
   add <pkg>` == `pnpm add <pkg>` in the profile.
3. On pnpm exit 0: **`reconcilePlugins(before, dir)`** (`apps/cli/src/plugin.ts`):
   reads the updated manifest, and for each dependency that **now resolves to a
   package declaring `dsh.bundle.patch`**, appends it to `dsh.profile.bundles`
   (dependency order); removes names that stopped being bundles; warns once per
   newly-added bundle-less dependency. Reconciliation is by **installed state**,
   not dependency diff — so `update` activates a package that gained its bundle
   declaration in a newer version.
4. pnpm missing → exit 127 with "install pnpm to manage profile plugins"
   (`apps/cli/src/plugin.ts`).

Live-verified: `dsh plugin --profile testp add /tmp/dsh-contract/test-bundle`
created the profile, ran pnpm (link install), and appended the bundle to
`dsh.profile.bundles`.

### 5.6 CLI surface (`@deepseek-ai/dsh` bin)

`apps/cli/src/bin.ts` (commander grammar):

```
dsh --profile <name> [args...]          # boot a profile
dsh web [args...]                       # alias of --profile web
dsh plugin --profile <name> <pnpm args> # forward to pnpm + reconcile (§5.5)
dsh --profile <name> --patch <path>...  # extra patch overlays
dsh --profile <name> --dump-config      # print composed tree (with user layer)
dsh --profile <name> --dump-default-config  # print bundle layers only
```

- Launcher parses only its own flags; everything after the first unknown token is
  handed to the booted app via `ctx.cmdlineArgs` (`apps/cli/src/profile-boot.ts`,
  `provideCmdline`). App plugins inject their own flag families
  (`@deepseek-ai/dsh-cmdline`).
- Source version is `0.1.5-rc.1` (`source:package.json`); the installed
  `@deepseek-ai/dsh-*` packages rolebox resolves against are the `0.1.5-rc.1`
  line (`node_modules`; verified by package manifest).

---

## 6. Dependency pinning & migration status (completed)

The migration to the `0.1.5-rc.1` line is **complete**. rolebox's `package.json`:

- every `@deepseek-ai/dsh-*` devDependency is pinned to **`0.1.5-rc.1`**
  (`dsh-client-locale`, `dsh-client-ui-conversation`, `dsh-client-ui-settings`,
  `dsh-client-ui-slots`, `dsh-invariants`, `dsh-llm`, `dsh-scope`, `dsh-session`,
  `dsh-session-persistence`, `dsh-skill`, `dsh-system-prompt`).
- `@deepseek-ai/cordis` is pinned to **`4.0.2`**.
- `@deepseek-ai/dsh-client-runtime` has been **removed** — zero references remain
  in the repo. Its successor surfaces are `@deepseek-ai/dsh-client-ui-slots`
  (the slot registry, §4.4.3) and `@deepseek-ai/dsh-client-ui-settings` (the
  `settings.section` seat, §4.4.7); `@deepseek-ai/dsh-client-ui-conversation`
  remains the source of the dock seat (§4.4.4) and `@deepseek-ai/dsh-client-locale`
  the i18n surface.
- The old `0.1.0-rc.6` published-npm-tarball installability verdict — including
  its "restricted `latest` dist-tag" analysis — is **superseded** and has been
  removed from this contract. The source checkout is the reference of record.

The structural boundary is unchanged: rolebox never imports `@deepseek-ai/*` at
runtime — the pins exist only to run the adapter's contract tests against the
real packages. Conformance of the structural mirrors is checked by
`scripts/verify-dsh-contract.ts` (§9).

---

## 7. Risks / flags

- **`[UNVERIFIED]`** — Behavior of `ctx.agents.create()` with a real
  `AgentFactory` (requires `@deepseek-ai/dsh-agent-loop`, a heavyweight package
  not part of this contract verification). The `AgentRegistry` surface and
  `AgentFactory` interface are verified from source; the loop's concrete
  create/resume behavior is not exercised here.
- **`[PARTIALLY VERIFIED]`** — `ctx.subagents.start()` with a real provider.
  **Implemented:** rolebox's registered providers delegate real spawning to a
  host provider by name — `DshAgentRegistrar.buildProvider().start()` forwards
  the resolved request to the provider named by `spawnProviderName` (default
  `"spawn"`, registered by `@deepseek-ai/dsh-subagent-spawn-in-process`), with a
  recursion guard against an agent-id collision
  (`src/platform/adapters/dsh/agent-registrar.ts`; config wiring
  `src/dsh-plugin.ts`). Covered by unit tests against a fake registry
  double and by the cordis e2e harness (`tests/dsh-cordis-e2e.test.ts`,
  `tests/platform/agent-registrar.test.ts`). **Still unverified:** a live
  end-to-end boot against the deployed dsh profile (`~/.dsh/profiles/...`) that
  proves a real child agent spawns, runs, and returns output through the
  installed `spawn` provider — the provider packages depend on the agent loop
  and are not exercised in this repo's verification.
- **`[UNVERIFIED]`** — `dsh plugin add` against a **registry-published** (not
  local-path) bundle; the live test used a local directory spec. The reconcile
  code path is identical (installed-state based), so risk is low.
- **`[UNVERIFIED]`** — `!!js` expression evaluation details beyond the examples
  seen in `dsh-base/cordis.patch.yml` (the loader's `evaluate` uses a
  context; exact available bindings are loader-internal). Documented examples:
  `process.env.X`, `process.cwd()`, `process.platform`, `dshHomePath(...)`.
- **API stability**: `0.1.5-rc.1` is a release candidate; all signatures above
  are pinned to that version. Cross-version drift is possible and re-verification
  is required before upgrading — use `scripts/verify-dsh-contract.ts` (§9).

---

## 8. Appendix: minimal working plugin skeleton (from verified surfaces)

```ts
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import dshTools, { defineTool } from '@deepseek-ai/dsh-tools';
import dshSession from '@deepseek-ai/dsh-session';

export const name = 'rolebox';
export const inject = ['tools', 'sessions'];   // wait for both services
export const Config = z.object({               // schemastery fork schema
  workspace: z.string().required(),
  maxDepth: z.natural().default(3),
});

export function apply(ctx: Context, config: typeof Config) {
  // register a tool — mount dsh-tools first (this plugin's inject already
  // depends on the bundle rows; in a full profile dsh-base provides them)
  const disposeTool = ctx.tools.register(defineTool({
    name: 'rolebox_dispatch',
    description: 'dispatch a subtask to a department worker',
    parameters: {
      task: { type: 'string', description: 'the subtask', required: true },
    },
    output: {
      schema: { type: 'object', properties: {
        ok: { type: 'boolean' },
      }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // exec.signal — observe cancellation; return canonical JSON value
      return { ok: true };
    },
  }));

  // append to the session log
  // (session obtained via ctx.sessions.get(id) / .create() — see §4.1)

  return () => { disposeTool(); };   // fiber disposer
}
```

The bundle packaging side (what makes this a dsh profile bundle, §5.2-5.3):

```json
// package.json
{ "name": "rolebox", "version": "0.1.0",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

```yaml
# cordis.patch.yml
- insert:
    - id: rolebox
      name: rolebox
      config:
        workspace: !!js process.cwd()
```

Install into a profile: `dsh plugin --profile <name> add <rolebox-package-or-path>`.

---

## 9. Drift detector: `scripts/verify-dsh-contract.ts`

`scripts/verify-dsh-contract.ts` is the **read-only drift detector** for the six
seams. rolebox consumes dsh across a structural boundary (it never imports
`@deepseek-ai/*` at runtime), so a dsh rename or removal of a mirrored member
fails silently until a spawn/route/skill call breaks. This gate re-derives the
dsh source member sets from a local checkout and compares them with the `Dsh*`
mirrors, mirroring dsh's own `scripts/verify-cordis-config.ts` pattern.

It asserts, per seam:

- tool `ToolDefinition` / `ToolSchema` / `ToolOutputDefinition` members;
- `SkillProvider` / `SkillCandidate` / `SkillDefinition` members;
- the `SubagentCapabilities` key set (all five) and `SubagentProvider` members;
- `SessionStore` / `Session` methods;
- the `SessionEvent` envelope keys (`type`, `seq`, `time`, `data`);
- the cordis `Plugin.Base.Config` slot (must stay a `StandardSchemaV1`);
- the `dsh.bundle.patch` row shape (every row key must be a loader
  `EntryOptions` member);
- the two client slot keys rolebox contributes into
  (`conversation.input.dock`, `settings.section`).

**Invocation (developer-local by design).** It is NOT wired into CI and never
vendors or clones dsh:

```sh
DSH_SOURCE_DIR=/path/to/harness-source bun run scripts/verify-dsh-contract.ts
```

- When `DSH_SOURCE_DIR` is **unset** it prints a notice and **exits 0**, so CI
  stays green.
- When set it reads the checkout **read-only** and exits non-zero (1) with a
  per-seam diff on any drift.
- The source paths it reads are those in §0 (e.g.
  `packages/core/tools/src/index.ts`, `packages/subagent/subagent/src/types.ts`,
  `packages/core/session/src/index.ts`, `vendor/cordis/src/registry.ts`,
  `vendor/loader/src/config/entry.ts`,
  `packages/client/ui-conversation/src/client/contract/slots.ts`,
  `packages/client/ui-settings/src/client/contract/slots.ts`).

Run this gate against the checkout before/after a dsh version bump; every
citation in this document should also be re-checked at that time.
