# dsh (DeepSeek Harness) Plugin Contract — verified against published npm artifacts

> Contract gate for "Adapt rolebox to run as a `@deepseek-ai/dsh` cordis plugin".
> **Every claim below was verified by downloading and inspecting the published npm
> tarballs** (not GitHub master, which tracks `apps/cli` at rc.5), and where noted,
> by executing the packages at runtime. Anything not verifiable from these
> artifacts is explicitly flagged `[UNVERIFIED]`.
>
> Verified artifact set (all unpacked from `registry.npmjs.org` tarballs):
>
> | Package | Version | Tarball |
> |---|---|---|
> | `@deepseek-ai/dsh` | `0.1.0-rc.6` | `deepseek-ai-dsh-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/cordis` | `4.0.1` | `deepseek-ai-cordis-4.0.1.tgz` |
> | `@deepseek-ai/dsh-tools` | `0.1.0-rc.6` | `deepseek-ai-dsh-tools-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/dsh-session` | `0.1.0-rc.6` | `deepseek-ai-dsh-session-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/dsh-subagent` | `0.1.0-rc.6` | `deepseek-ai-dsh-subagent-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/dsh-agent` | `0.1.0-rc.6` | `deepseek-ai-dsh-agent-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/dsh-home-paths` | `0.1.0-rc.6` | `deepseek-ai-dsh-home-paths-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/schemastery` | `3.18.1` (the schemastery fork dsh uses) | `deepseek-ai-schemastery-3.18.1.tgz` |
> | `@deepseek-ai/dsh-app-boot` | `0.1.0-rc.6` | `deepseek-ai-dsh-app-boot-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/dsh-base` | `0.1.0-rc.6` (example bundle) | `deepseek-ai-dsh-base-0.1.0-rc.6.tgz` |
> | `@deepseek-ai/cordis-plugin-loader` | `1.0.2` | `deepseek-ai-cordis-plugin-loader-1.0.2.tgz` |
> | `@deepseek-ai/cordis-plugin-include` | `1.0.6` | `deepseek-ai-cordis-plugin-include-1.0.6.tgz` |
> | `@deepseek-ai/dsh-llm` | `0.1.0-rc.6` (types for ContentBlock/ToolSchema) | installed from registry |
>
> Citation format: `tarball:path:line` (e.g. `dsh-tools/lib/types/schema.d.ts:239`)
> refers to the unpacked package file; `live:` marks a runtime execution check
> performed against the installed artifacts during this verification.

---

## 1. Executive summary for the implementer

- A dsh plugin is a **Cordis plugin**: a function `(ctx, config)`, a class
  `new (ctx, config)`, or an object `{ apply(ctx, config) }`, optionally with a
  `Config` schema, an `inject` dependency list, a `name`, and `provide`/`intercept`
  metadata. (`cordis/lib/types/registry.d.ts:48-93`)
- The runtime `ctx` exposes services as properties. Relevant injected services for
  rolebox's adapters: **`ctx.tools`** (register tools), **`ctx.sessions`**
  (session lifecycle), **`ctx.agents`** (agent registry), **`ctx.subagents`**
  (subagent spawn seam). All four services are `Service` subclasses mounted by
  loading the corresponding `@deepseek-ai/dsh-*` package as a plugin.
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
- **Installability verdict (§6): the `0.1.0-rc.6` versions of every needed
  `@deepseek-ai/dsh-*` package are publicly installable.** The npm `latest`
  dist-tag for most of these packages still points at `0.0.1-rc.1`, which was
  published with `publishConfig.access: restricted` and 404s for unauthenticated
  installs — so rolebox **must pin exact `0.1.0-rc.6` versions** (or a range
  resolving to them) and must not rely on `npm install <pkg>` resolving `latest`.
  A live unpinned install of `@deepseek-ai/dsh-tools` fails with `E404`; a pinned
  `@0.1.0-rc.6` (and `^0.1.0-rc.6`) install succeeds.

---

## 2. Cordis plugin conventions (`@deepseek-ai/cordis@4.0.1`)

### 2.1 What the package exports

`lib/types/index.d.ts:1-15` re-exports `context`, `events`, `fiber`, `logger`,
`registry`, `service`, `utils`. Live runtime export check:

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
**`EventsService`**, **`RegistryService`**. (`cordis/src/index.ts:1-14`,
`cordis/lib/types/index.d.ts:1-15`)

### 2.2 Plugin entrypoint shapes

`cordis/lib/types/registry.d.ts:48-93`:

```ts
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;

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
```

Live-verified all three shapes run: function plugin `(ctx, config)`, class
plugin `new (ctx, config)`, object plugin `{ apply(ctx, config) }` —
`live: ctx.plugin(fn, {..}); ctx.plugin(Cls, {..}); ctx.plugin({apply}, {..})`.

### 2.3 Loading plugins: `ctx.plugin()` and `ctx.inject()`

`cordis/lib/types/registry.d.ts:99-122` (module augmentation on `Context`):

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
interface, `cordis/lib/types/registry.d.ts:56`). The dsh packages use the
**`@deepseek-ai/schemastery` fork** (a republish of
[shigma/schemastery](https://github.com/shigma/schemastery)) as their schema
DSL. Verified from the fork tarball:

- `@deepseek-ai/schemastery@3.18.1` default-exports a callable `Schema` function.
  (`schemastery/lib/types/index.d.ts:198-199` — `export default Schema`)
- Factory methods: `string()`, `number()`, `natural()`, `percent()`, `boolean()`,
  `date()`, `regExp()`, `array(inner)`, `dict(inner, sKey?)`, `tuple([...])`,
  `object({...})`, `union([...])`, `intersect([...])`, `transform(inner, cb)`,
  `lazy(cb)`, `const(v)`, `from(v)`, `is(ctor)`, `any()`, `never()`, `extend(type, resolve)`.
  (`schemastery/lib/types/index.d.ts:30-87`)
- Instance chainables: `required()`, `default(v)`, `description()`, `comment()`,
  `pattern(re)`, `min/max/step`, `hidden()`, `disabled()`, `role()`, `link()`,
  `set()`, `push()`, `i18n()`, `extra()`. (`schemastery/lib/types/index.d.ts:148-188`)
- Schemas implement `'~standard'` (StandardSchemaV1). Verified:
  `live: obj['~standard'] → yes`, and a `z.object({...})` schema worked directly as
  a Cordis plugin `Config` (defaults applied + validation error surfaced, §2.3).
- The fork is a **fork of upstream schemastery** (`README.md:1` "Type Driven Schema
  Validator", upstream badges), published under the `@deepseek-ai` scope with
  `publishConfig.access: public` (registry metadata check).

Usage pattern in dsh-tools: `ToolRuntime.Config` is declared as `static Config: z<Config>`
(`dsh-tools/lib/types/index.d.ts:495`) where `z` is the schemastery default import
(`dsh-tools/lib/types/index.d.ts:7` — `import z from '@deepseek-ai/schemastery'`).

### 2.5 `Context` API

`cordis/lib/types/context.d.ts:15-32, 40-100`:

- `Context` is a **proxy**: property reads resolve services (`ctx.tools`,
  `ctx.sessions`, ...); `extend(meta)`, `isolate(name, label?)`, `intercept(name, config)`
  create scoped child contexts.
- Built-in services on every context: `ctx.events` (event bus), `ctx.logger`
  (logger factory), `ctx.reflect` (service resolver/proxy backing), `ctx.registry`
  (plugin registry). (`cordis/lib/types/context.d.ts:24-32`)
- `ctx.root` — the root context; `ctx.baseUrl` — base URL for relative module
  specifiers (set by the loader to the config directory, §5.4).
- Live-verified: `new Context()` boots with `root, baseUrl, fiber, reflect,
  registry, events, logger` present.

### 2.6 `Service` base class

`cordis/lib/types/service.d.ts:9-54`:

```ts
export declare abstract class Service<out T = never> {
    protected ctx: Context;
    name: string;
    constructor(ctx: Context, name: string);   // registers this as ctx[name]
    static readonly init / check / config / invoke / extend / tracker / resolveConfig: unique symbol;
}
```

- Subclass constructor `super(ctx, name)` registers the instance as `ctx[name]`,
  auto-removed when the owning fiber unloads. All dsh services follow this:
  `ToolRuntime`, `SessionStore`, `AgentRegistry`, `SubagentRuntime` all
  `extends Service` with `static inject` (dependency services) and
  `static Config` (config schema).

---

## 3. Tool registry: `ctx.tools` (`@deepseek-ai/dsh-tools@0.1.0-rc.6`)

### 3.1 Service mounting and interface

- Mounted by loading the package default export as a plugin:
  `await ctx.plugin(dshTools)`. The default export IS the `ToolRuntime` class
  (`dsh-tools/lib/index.js` tail — `ToolRuntime as default`).
- `static inject: ["systemPrompt"]` — **`ctx.tools` only mounts after a
  `systemPrompt` service exists** (`dsh-tools/lib/types/index.d.ts:494`).
  Live-verified: `ctx.plugin(dshTools)` alone leaves `ctx.tools` undefined;
  after mounting a stub `systemPrompt` service, `ctx.tools` is a `ToolRuntime`.
  In a full dsh profile this dependency is satisfied by the `@deepseek-ai/dsh-system-prompt`
  bundle row (see §5.5 example, `id: system-prompt`).
- Public API (`dsh-tools/lib/types/index.d.ts:493-817`):
  - `register(definition: ToolDefinition): () => void` — global or scope-local
    registration; returns the disposer. (`index.d.ts:603`)
  - `restrict(filter: ToolRestriction): () => void` — per-scope allow/deny mask. (`:611`)
  - `guard(guard: ToolGuard): () => void` — monotonic deny-after-pre-execute gate. (`:622`)
  - `get(name, scope?): ToolDefinition | undefined` — resolve as one scope sees it. (`:657`)
  - `schemas(scope?): ToolSchema[]` — model-facing schema projection (whitelists
    name/description/parameters only). (`:678`)
  - `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` — dispatch a
    call through the full pipeline. (`:732`)
  - `presentAs(mode: ToolPresentationMode): () => void` — per-scope presentation
    mode (`'native' | 'code' | 'both'`). (`:574`)
  - Config: `mode?: ToolPresentationMode` (default `native`), `maxParallelSubCalls?: number`
    (default 10). (`dsh-tools/lib/types/index.d.ts:449-469`)

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

`dsh-tools/lib/types/schema.d.ts:177-239`:

```ts
export declare function defineTool<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec
>(options: DefineToolOptions<S, O>): ToolDefinition;
```

`DefineToolOptions` (`schema.d.ts:178-231`):

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

**Parameter schema DSL** (`schema.d.ts:9-84`): the parameters object is an
implicit open object root; each property is a `ValueSchemaSpec` (one of
`type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json' | oneOf`)
plus optional `required: true`, `description`, `title`, `default`, `examples`,
`enum`, `const`, `items`, `additionalProperties`. Requiredness is per-property
(`required: true`), never a top-level `required` array.

- `ParameterPropertySpec = ValueSchemaSpec & { required?: true }` (`schema.d.ts:74-76`)
- `ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }` (`schema.d.ts:81-84`)
- Value schemas compile to raw JSON Schema via `valueSchemaSpecToJsonSchema` /
  `parameterSchemaSpecToJsonSchema` (`schema.d.ts:157-163`); args are validated
  with `validateArgs(spec, args): string[]` (`schema.d.ts:176`).

**Live-verified DSL boundary**: passing a raw JSON-Schema `required` array inside
`output.schema` throws
`JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL`
— i.e. the DSL rejects raw JSON Schema keywords; use the DSL types or the explicit
raw-schema functions in §3.3.

### 3.3 Raw JSON-schema tool support

`dsh-tools/lib/types/json-schema.d.ts` — an **enforced JSON Schema subset**:

```ts
interface JsonSchemaNode {              // json-schema.d.ts:24-49
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
  schema = unconstrained JSON. (`json-schema.d.ts:89`)
- `assertObjectJsonSchema(schema)` — subset + object root (used by subagent
  `outputSchema`, §4.3). (`json-schema.d.ts:96`)
- `validateJsonSchemaValue(schema, value, path?)` — path-qualified violations.
  (`json-schema.d.ts:105`)
- The subset is enforced: unsupported/misplaced keywords **reject** rather than
  pass through (`json-schema.d.ts:8-10`).
- Tool *output* declaration always uses the value-schema DSL (`output.schema: O`);
  the raw JSON-schema path is for **external inputs** (e.g.
  `SubagentStartRequest.outputSchema`), validated through `assertObjectJsonSchema`.

### 3.4 `output.render` contract

- `ToolOutputDefinition` (`dsh-tools/lib/types/index.d.ts:97-104`):
  `{ schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }`
  — "Pure projection from validated arguments and value to Native/model content."
- `ToolDefinition.output` is **mandatory** (`index.d.ts:106-108`). `execute`
  must return a JSON value matching `output.schema`; violations throw
  `ToolOutputError` (`index.d.ts:383-387`).
- `ContentBlock` comes from `@deepseek-ai/dsh-llm` (`dsh-tools/lib/types/index.d.ts:17`
  re-exports; `dsh-llm/lib/types/message.d.ts` + `types.d.ts:39-89`):
  `{type:'text', text}`, `{type:'reasoning', text}`,
  `{type:'image', attachment}`, `{type:'tool-call', id, name, arguments}`,
  `{type:'tool-result', toolCallId, content, isError?}` — merge-extensible
  `ContentBlockMap`.
- Result contract (`ToolExecutionResult`, `index.d.ts:389-411`):
  success `{isError:false, value: JsonValue, content: ContentBlock[], meta?, additionalContexts?, concludesTurn?}`;
  failure `{isError:true, error: {message, info?: {name, code}}, content, meta?, additionalContexts?}`.
- Failure codes: `TOOL_ABORTED = 'ABORTED'` (body invoked then cancelled) and
  `TOOL_ABORTED_BEFORE_DISPATCH` (cancelled before body started)
  (`index.d.ts:352-354`). Live-verified both paths (§3.5).
- Presentation intents (`dsh-tools/lib/types/presentation.d.ts:13-366`):
  `ToolCallView` = `generic | terminal | diff` cards; `ToolResultView` = adds
  `search | read | web` cards. Pure, replayable, side-effect-free.

### 3.5 `exec.signal` / `exec.agent` / `exec.token` semantics

`ToolRunContext` (`dsh-tools/lib/types/index.d.ts:283-300`):

```ts
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;   // attach context to this call's result
  concludeTurn(): void;                       // mark result as terminal for the agent turn
}
```

`ToolExecution` / `ToolExecutionInput` (`index.d.ts:196-220, 260-265`):

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
  cannot hard-kill same-process code (`index.d.ts:119-125`). Live-verified:
  aborting before the body starts → `{isError:true, code:'ABORTED_BEFORE_DISPATCH'}`;
  aborting after the body started (body observing `exec.signal`) →
  `{isError:true, code:'ABORTED'}`.
- **`exec.agent`** — optional `Agent` (from `@deepseek-ai/dsh-agent`); set by the
  agent loop; scope-filtered dispatch keys on it. The tool receives it in
  `ToolExecutionInput.agent`.
- **`exec.token`** — `ToolExecutionToken`, an opaque `symbol & { brand }`
  registry-assigned identity; callers do not choose it; nested calls see only the
  parent's token as `parent` (`index.d.ts:186-190, 263-264`).
- Events (for plugins that want to observe instead of dispatch): `tools/pre-execute`
  (allow/deny/ask waterfall), `tools/execute` (around-dispatch, may replace
  `exec.signal`), `tools/post-execute` (accept/replace/block), `tools/code-dispatch-log`,
  `tools/result` (frozen final outcome), `tools/change` (registry changed).
  (`index.d.ts:24-94`)

### 3.6 `ToolSchema` base (model-facing projection)

`dsh-llm/lib/types/types.d.ts:305-310` (installed artifact):

```ts
export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;   // JSON Schema object for arguments
}
```

`ToolDefinition extends ToolSchema` and adds `output`, `execute`,
`finalizeContent?`, `timeoutMs?`, `isConcurrencySafe?`, `presentCall?`,
`presentResult?` (`dsh-tools/lib/types/index.d.ts:106-172`). `schemas()` returns
only the `ToolSchema` projection (execution/presentation callbacks never
model-visible).

---

## 4. Sessions, agents, and subagents — public APIs needed by the adapters

### 4.1 `ctx.sessions` — session lifecycle (`@deepseek-ai/dsh-session@0.1.0-rc.6`)

Mounted by `await ctx.plugin(dshSession)` → `ctx.sessions` is a `SessionStore`
(`dsh-session/lib/types/index.d.ts:290-413`):

```ts
class SessionStore extends Service {
  create(id?: SessionId, options?: CreateSessionOptions): Session;          // :315
  prepare(id?, options?): Session;                                          // :336  (not yet in store)
  enter(session): () => void;                                               // :359  (attach hooks + store)
  announce(session): void;                                                  // :369  (emit session/created)
  flush(session): Promise<boolean>;                                         // :385  (durability checkpoint)
  get(id): Session | undefined;                                             // :393
  list(): Session[];                                                        // :398
  fork(source, boundary?, childSessionId?): Session;                        // :413
}
```

`Session` class (`index.d.ts:106-287`):

```ts
class Session {
  static create(id, seed?, header?): Session;      // detached create :154
  static fromRestore(id, seed, header): Session;   // :164
  get id(): SessionId;
  get seq(): number;                     // next seq == log length
  get events(): readonly SessionEvent[];
  get surface(): SessionSurface;
  readonly header: SessionHeader;        // format version, cwd, lineage, seed boundary
  append<T>(type, data, ...opts): SessionEvent<T>;   // :212 — message append
  deriveMessages(): Message[];           // :259 — LLM history from surface
  requestHeader(): EpochHeader | undefined;
  requestContext(): RequestContext | undefined;
}
```

**Message append** — `append(type, data, opts)` (`index.d.ts:212-253`):
- Surface event types (`dsh-session/lib/types/types.d.ts:362`):
  `'user/message' | 'assistant/message' | 'tool/result'` — these REQUIRE a
  `surfaceOp` in `opts`.
- `SurfaceOp` (`types.d.ts:388-394`): `'append'` or
  `{ op: 'replace', start, end }` (compaction).
- `SurfaceIntent = { surfaceOp, sourceEventSeqs?: number[] }` (`types.d.ts:397-405`).
- Log-only event types (no surfaceOp): `turn/start`, `turn/end`, `step/start`,
  `step/end`, `assistant/chunk`, `tool/call`, `todo/write`, `request/header`,
  `request/context`, `session/end-seed` (`types.d.ts:223-354`).
- Data must be lossless JSON; invalid data throws at the append site.
- `Message`/`UserMessage`/`AssistantMessage`/`ToolResultMessage` shapes come from
  `@deepseek-ai/dsh-llm` (`dsh-llm/lib/types/message.d.ts:76-131`): each message has
  `{ id: MessageId, role, content: ContentBlock[], source }`.

Live round-trip:

```
live: ctx.sessions.create() → session-1 (auto id), seq 0
live: s.append('user/message', {content:[{type:'text',text:'hello'}], source:{kind:'user'}}, {surfaceOp:'append'})
live: s.append('assistant/message', {turn, step, message:{role:'assistant', content, source:{kind:'model',provider,model}}}, {surfaceOp:'append'})
live: s.append('tool/result', {turn, step, callId, message:{role:'user', content:[{type:'tool-result',...}], source:{kind:'tool',callId}}, isError:false}, {surfaceOp:'append'})
live: s.deriveMessages() → 3 messages [user, assistant, tool]  (derived history correct)
live: ctx.sessions.get(s.id) === s → true; flush(s) → false (no persistence listener mounted)
```

Events (for persistence/telemetry plugins): `session/created`, `session/disposed`,
`session/event`, `session/flush` (`index.d.ts:31-100`). Persistence is a plugin
concern: subscribe `session/event`, drain on `session/flush`.

### 4.2 `ctx.agents` — agent registry (`@deepseek-ai/dsh-agent@0.1.0-rc.6`)

Mounted by `await ctx.plugin(dshAgent)` → `ctx.agents` is an `AgentRegistry`
(`dsh-agent/lib/types/index.d.ts:209-383`):

```ts
class AgentRegistry extends Service {
  setFactory(factory: AgentFactory): () => void;         // :276  — loop registers the creation factory
  create(options: CreateAgentOptions): Promise<AgentHandle>;  // :288
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;  // :296
  register(agent: Agent): () => void;                    // :315  — record already-constructed agent
  enter(agent, owner): () => void;                       // :331  — insert without announcing
  announce(agent): void;                                 // :342
  get(id: SessionId): Agent | undefined;                 // :349
  isOwnedBy(id, owner): boolean;                         // :358
  list(): Agent[];                                       // :363
  roots(): Agent[];                                      // :370
  currentInitiator(): Agent | undefined;                 // :228
  requireInitiator(): Agent;                             // :243
  withInitiator<T>(agent, operation): T;                 // :251
  withoutInitiator<T>(operation): T;                     // :260
}
```

- **`AgentFactory`** (`index.d.ts:166-198`): `{ createAgent(ownerCtx, options): Promise<AgentHandle>,
  resume(ownerCtx, options): Promise<AgentHandle> }` — the loop implementation
  (`@deepseek-ai/dsh-agent-loop`) provides it via `setFactory`. Creation is
  delegated; `create()` rejects if no factory is registered.
- `AgentHandle = { agent: Agent; dispose(): Promise<void> }` (`index.d.ts:143-158`).
- `Agent` (`dsh-agent/lib/types/runtime-types.d.ts:60-134`): `{ id: SessionId,
  options: AgentOptions, session: Session, inbox: Inbox, status: 'idle'|'running',
  ctx: Context (agent-scoped), cancel(cause, opts?), whenIdle(), runMaintenance(task),
  send(msg, target, wakeup), followup(msg), steer(msg), inject(msg) }`.
- `AgentOptions = { provider?, model?, maxTokens? }` (`runtime-types.d.ts:21-27`).
- Events: `agent/created`, `agent/disposed`, `agent/status`, `agent/session-start`
  (`runtime-types.d.ts:139-215`, module augmentation).

Live-verified: `ctx.agents` mounts; `list()` empty; `currentInitiator()` undefined
outside an initiator boundary; `withInitiator` preserves the operation return;
`setFactory` returns a disposer.

### 4.3 `ctx.subagents` — subagent spawn seam (`@deepseek-ai/dsh-subagent@0.1.0-rc.6`)

Mounted by `await ctx.plugin(dshSubagent)` → `ctx.subagents` is a `SubagentRuntime`
(`dsh-subagent/lib/types/index.d.ts:99-315`). This is the **abstract seam**: the
concrete spawn providers (`@deepseek-ai/dsh-subagent-spawn-in-process`,
`-fork`, `-acp`) are separate packages that register providers into it.

```ts
class SubagentRuntime extends Service {
  registerProvider(provider: SubagentProvider): () => void;   // :237
  getProvider(name: string): SubagentProvider | undefined;    // :243
  list(): string[];                                           // :250
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;  // :261
  startContinuable(spec): Promise<ContinuableStart>;          // :120
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options): Promise<MessageId>; // :136
  interrupt(targetSessionId, authority): void;                // :152
  reportFrom(child: Agent, content, options): Promise<MessageId>;  // :164
  registerContinuableSetup(contribution): () => void;         // :179
  drainContinuableDescendants(parents): Promise<void>;        // :195
  listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>;      // :213
  listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>; // :229
}
```

**`SubagentProvider`** (`dsh-subagent/lib/types/types.d.ts:268-287`):

```ts
interface SubagentProvider {
  name: string;                       // unique registry name (e.g. 'spawn', 'fork', 'acp')
  capabilities: SubagentCapabilities; // start-time features: depthLimit, toolFilter, persona, ...
  inheritsParentContext: boolean;
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
  prepareContinuable?(request): Promise<ContinuableCreateSpec>;  // optional: continuable capability
}
```

**`SubagentStartRequest`** (`types.d.ts:91-145`):
`{ label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, agentOptions?,
outputSchema?: ObjectJsonSchema, maxDepth?, toolFilter?: ToolRestriction, persona? }`.

**`SubagentRun`** (`types.d.ts:233-262`):
`{ id: SessionId, localAgent: Agent | undefined, result: Promise<SubagentResult>,
dispose(): Promise<void> }` — `result` resolves (never rejects on child failure)
with `{ output: ContentBlock[], structured?: unknown, stopReason }` where
`stopReason ∈ { completed, aborted, error, 'max-tokens', refusal }`
(`types.d.ts:187-222`).

Live-verified: `ctx.subagents` mounts; `registerProvider({name:'mock', capabilities:{},
inheritsParentContext:false, start: async()=>{throw ...}})` → `getProvider('mock')` resolves;
disposer removes it.

Events: `subagent/provider-added`, `subagent/provider-removed`, `subagent/start`,
`subagent/end` (`index.d.ts:53-92`).

### 4.4 Web-UI extension: host route + browser slot plugin (verified at `0.1.0-rc.6`)

The role-switch UI ships as two halves: a **host route** on dsh's own web server
(the `/rolebox` REST API) and a **browser slot plugin** (`dsh.client` bundle that
mounts the dock into the web app). Both surfaces were verified against the
`0.1.0-rc.6` artifacts (unpacked tarballs under `/tmp/dsh-inspect/`).

#### 4.4.1 Host webserver: `ctx.webServer.register` WebRoute shape

`dsh-host-webserver/lib/types/index.d.ts:19-28`:

```ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;
    path: string;                  // absolute pathname, no trailing slash
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
```

`register(route)` returns the disposer that unmounts the route; duplicate
`(kind, path)` registrations throw (composition-level contract)
(`dsh-host-webserver/lib/types/index.d.ts:67-72`). rolebox consumes this surface
structurally (duck typing — never imports `@deepseek-ai/*`,
`src/platform/adapters/dsh/web-role-switch-route.ts:12-13`) and registers one
`{ kind: 'prefix', path: '/rolebox', handler }` route
(`web-role-switch-route.ts:163-169`). The service is optional: `apply()` probes
`ctx.get("webServer")` and skips route registration when absent (headless
profiles) (`src/dsh-plugin.ts:280-297, 400-421`).

#### 4.4.2 `dsh.client` roster contract (node half)

`dsh-client-modules` is the node half that collects browser plugins: it scans the
enabled Loader entries for packages declaring `dsh.client`, resolves each
`exports["./client"]`, hashes the built bundle into the boot graph, and serves it
with its source map under `/plugins` (`dsh-client-modules/README.md:5-11`). The
registry service (`ClientModuleRegistry`, `static inject = ["webServer",
"loader"]`) recomposes on entry changes and registers the `/plugins` bundle route
plus an index tap that injects the boot manifest
(`dsh-client-modules/lib/index.js:115-170`). The per-package parse reads
`pkg.dsh.client`, accepts only `platform: "web"`, resolves the `./client` export,
and records `inject` / `immediately`
(`dsh-client-modules/lib/index.js:250-270`). rolebox's declaration
(`package.json:70-82`):

```json
"dsh": {
  "bundle": { "patch": "./dsh/cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-runtime",
               "@deepseek-ai/dsh-client-ui-conversation",
               "@deepseek-ai/dsh-client-locale"]
  }
}
```

**Resolution precondition (the missing link this integration tripped on).** Before
parsing `dsh.client`, the registry resolves the package by the loader entry's
**name** (`fiber.entry.options.name`, `lib/index.js:141/153`) through
`require.resolve('<name>/package.json')` from the host context
(`createRequire(ctx.baseUrl)`, `lib/index.js:138-139`); an unresolvable name is
cached as a permanent "not a client package" verdict (`resolveMeta`,
`lib/index.js:238-247`) and the entry silently never reaches the boot graph.
dsh's own roster rows use plain package names (`@deepseek-ai/dsh-client-ui-goal`),
so `<name>/package.json` resolves naturally. rolebox's cordis plugin lives at the
scoped sub-path export `./dsh`, making its entry name `rolebox/dsh` — which is
NOT a resolvable package spec on its own. The packaging must therefore export
`"./dsh/package.json"` → `"./package.json"` (package.json:38), so
`require.resolve('rolebox/dsh/package.json')` lands on the root manifest carrying
the `dsh.client` declaration. And the browser half requires the bundle envelope
id to EQUAL the boot-graph row id (the entry name): `arrive()` rejects a bundle
that loads without registering its row id (`lib/client.js:84`). The client
bundle is therefore wrapped with `id: "rolebox/dsh"` (scripts/build-dsh-web-client.ts)
to match the row — dsh's own bundles satisfy this trivially because their row
name IS their package name. Both sides of this contract are pinned by
`tests/dsh-plugin.test.ts` ("dsh packaging exposes the dsh-client-modules resolution seam").

#### 4.4.3 Slot registry + `ctx.slots.inject` pattern

`dsh-client-ui-slots/lib/types/index.d.ts:468-600` documents the slot registry:
`SlotCore.register(options, component)` (list/keyed/chain validation,
load-time throws, unload cascade) and the inject-bearing overload that joins the
registrant's business face into the component's composed props. The runtime
`SlotRegistry` service wraps it with cordis lifecycle — disposal through
`ctx.effect`, store-instance minting, the registrant stamp — and adds the
declaration-wait API:

```ts
// dsh-client-runtime/lib/types/client/slots.d.ts:90
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
```

`inject` installs one effect per declaration lifetime of a slot (runs
synchronously when the declaration already exists, otherwise inside the declaring
`register()` call); the controller belongs to the caller's fiber, so plugin
unload cancels pending waits and removes active contributions
(`slots.d.ts:82-91`). The canonical registrant posture — the one rolebox's client
entry mirrors (`src/platform/adapters/dsh/web-ui/client.ts:176-189`) — is
dsh-client-ui-conversation's TodoDock entry: `ctx.slots.inject(key, () =>
ctx.slots.register({name, id, order, locale}, Component))`
(`dsh-client-ui-conversation/lib/client.js:6303-6312`).

#### 4.4.4 Declared seats

The conversation UI declares the input-zone region seats
(`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:190-232`):

```ts
'conversation.input.dock': {        // :190 — full-width row above the composer
    kind: 'list'; scope: 'session'; owner: InputZone;
};
'conversation.composer.dock': {     // :203 — band under the composer card
    kind: 'list'; scope: 'session'; owner: InputZone;
};
'conversation.input.left' / 'conversation.input.right':  // :216 / :228 — tool row ends
```

The broader roster also declares `conversation.session.header` /
`conversation.session.header.actions` / `conversation.session.header.utilities`
(`slots.d.ts:43-66`). rolebox mounts into `conversation.input.dock`
(`client.ts:77`); the `scope: 'session'` slot makes the inject factory resolve
the definite session id (`(sessionId) => ({ sessionId })`, `client.ts:184`).

#### 4.4.5 Client bundle format

Browser bundles are registered through the loader's global:

```js
// dsh-client-ui-commands/lib/client.js:1-3
window.__ModuleLoader__.load({
    id: "@deepseek-ai/dsh-client-ui-commands",
    factory: (require) => { var module = { exports: {} }; ... return module.exports; },
});
```

The factory-form CJS model: executing the bundle only **registers** the factory;
module body side effects run at materialization (`factory(require)` → exports,
memoized in `loadCache`) — so require cycles throw and load order needs no
external sequencing (`dsh-client-modules/README.md:5-11`). rolebox's build
(`scripts/build-dsh-web-client.ts`) bundles `web-ui/client.ts` with Bun
(`format: "cjs"`, `react` / `react/jsx-runtime` / `@deepseek-ai/*` external) and
wraps the output in this exact envelope with `id: "rolebox"`.

### 4.5 Session-level system-prompt registration (`rolebox:role` / `rolebox:context`)

The model-facing system prompt is composed EXCLUSIVELY by the mounted
`systemPrompt` service — the `@deepseek-ai/dsh-system-prompt` registry that
`ctx.tools` waits for (`static inject: ["systemPrompt"]`, §3.1; mounted in a
full profile by the `system-prompt` bundle row). rolebox's session-level role
injection registers two contributions into it via `DshSystemPromptAdapter`
(`src/platform/adapters/dsh/system-prompt.ts`, wired by
`src/dsh-plugin.ts:519-542`):

- **Section `rolebox:role` — `order: 50`** — renders the ACTIVE role's full
  `systemPrompt` for the current session (`resolveActiveRolePrompt`). The
  provider resolves PER-SESSION through the render context: `context.agent.id`
  (the model-facing agent) must be present, then the session id (dsh spelling
  `sessionID`, rolebox spelling `sessionId`, or — on the real harness assembly
  context `{ agent, scope }`, where the agent is the session — the agent's own
  `id`), then the shared per-session `ActiveRoleRef` (`activeRole.get(sessionId)`
  — the same holder the role switcher writes and the registrar reads at spawn),
  then the registrar's definition lookup. Returns `''` when no role is active;
  the registry's
  `renderPrompt` drops empty sections, so the base agent's prompt is
  unchanged.
- **Context entry `rolebox:context` — `order: 0`** — renders the active role's
  available-functions block (`buildAvailableFunctionsBlock`), the
  session-level analog of the registrar's spawn-time context provider
  (agent-registrar.ts, §4.3). Also `''` when nothing applies, dropped the
  same way.

Ordering mirrors the spawn-time `composePrompt` convention (context leads,
role prompt follows): the context entry (order 0) renders AHEAD of the role
section (order 50).

**Graceful degradation** — the `systemPrompt` service is OPTIONAL. `apply()`
probes it structurally (`probeSystemPrompt`, `src/dsh-plugin.ts:331-352` —
`ctx.systemPrompt` property or `ctx.get("systemPrompt")`, both duck-typed)
and registers the contributions only when the service is present. Full
profiles mount it; headless profiles have no model-facing prompt assembly, so
the probe returns absent, `apply()` logs a warning ("No systemPrompt service
on ctx — role prompt injection disabled") and keeps booting — the same
degradation shape as the `webServer` seam (§4.4.1). The service is
deliberately NOT in the `inject` roster, so it can never gate plugin
activation. Each `section()` / `context()` call returns a disposer; the
adapter collects them and releases them on fiber unload (`dispose()`).

---

## 5. Profile bundle contract for a NON-workspace package (`@deepseek-ai/dsh` + `dsh-app-boot`)

### 5.1 Layout: `$DSH_HOME` and profiles

- `DSH_HOME_ENV = 'DSH_HOME'`; default home is `join(homedir(), '.dsh')`; display
  form `~/.dsh`. (`dsh-home-paths/lib/types/index.d.ts:10-15`, `lib/index.js:49-50`)
- `resolveDshHome(configured?, env?)` precedence: explicit configured path >
  `$DSH_HOME` (non-blank) > `~/.dsh`; blank env treated as unset.
  (`dsh-home-paths/lib/types/index.d.ts:42-59`, `lib/index.js:73-76`)
- Profiles live under `$DSH_HOME/profiles/<name>` (`PROFILES_DIR = 'profiles'`,
  `dsh-app-boot/lib/types/profile.d.ts:27`, `lib/index.js:309-320`).
- Profile directory contains: `package.json` (deps + `dsh.profile.bundles` list),
  `cordis.patch.yml` (user's own patch layer), and a pnpm workspace
  (`pnpm-workspace.yaml`: `nodeLinker: hoisted`, `autoInstallPeers: false`).
  (`dsh-app-boot/lib/types/profile.d.ts:5-23`; `initProfile` writes manifest +
  patch template + workspace, `dsh-app-boot/lib/index.js:340-400`)

### 5.2 Bundle package contract (`dsh.bundle`)

A **bundle** is any npm package whose `package.json` declares
(`dsh-app-boot/lib/types/profile.d.ts:30-34`):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

- `patch` is a **relative path** (from the package root) to the bundle's patch file.
- Resolution: bundle name resolves **installation-anchor first, then the profile
  directory** (`resolveBundleDir`, `dsh-app-boot/lib/types/profile.d.ts:133-145`;
  live code `lib/index.js:510-530`). So an in-box bundle always comes from the
  same dsh installation; an out-of-tree (profile-installed) bundle resolves from
  the profile's `node_modules` (pnpm-managed).
- Loading (`loadProfile`, `dsh-app-boot/lib/index.js:530-575`): for each name in
  `dsh.profile.bundles`, read the package's `dsh.bundle.patch`, join to the
  package dir, parse that patch file; a listed bundle **without** `dsh.bundle`
  fails loud ("declares no dsh.bundle in its package.json").
- **Reference bundle**: `@deepseek-ai/dsh-base@0.1.0-rc.6` ships
  `cordis.patch.yml` and declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` in its package.json
  (verified in tarball).

### 5.3 `cordis.patch.yml` entry shapes

Patch files are YAML arrays of loader patch entries (the `cordis-plugin-include`
`PatchOptions`, `cordis-plugin-include/lib/types/index.d.ts:28-39`):

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

- `EntryOptions` (what a row becomes after patching), `cordis-plugin-loader/lib/types/config/entry.d.ts:6-19`:
  `{ id: string, name: string, config?: any, group?: boolean|null, disabled?: boolean|null, inject?: Inject|null }`.
- `!!js <expression>` scalars are evaluated by the loader at activation time
  (e.g. `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
  `!!js dshHomePath('sessions')`, `!!js process.platform === 'win32'`) — the
  entry-list YAML dialect is `entryListSchema` from
  `cordis-plugin-include/lib/types/index.d.ts:10`.
- Patch semantics (`applyEntryPatches`, include `index.d.ts:26`): patches apply in
  order over the entry list; an `id`-targeted patch replaces the row's config
  **per-key, with no deep merge** — the override object is assigned field-by-field
  onto the row, so a `config:` override replaces the ENTIRE config object (any
  bundle-provided keys not re-declared in the override are lost); a patch matching
  nothing warns and is skipped; inserted rows can be targeted by later patches.
  Live-verified with `applyEntryPatches` directly (config replaced, insert
  appended, unknown-id warned).
- A `name` can be a **bare package name** (`@deepseek-ai/dsh-tools`),
  a scoped sub-path (`@deepseek-ai/dsh-tool-subagent-control/list-agents`), or a
  relative module (`./foo.js`) resolved against `ctx.baseUrl` (the profile
  directory). (`dsh-base/cordis.patch.yml` rows; loader `EntryTree.import`)

### 5.4 How the tree composes (boot order)

The profile tree is composed **over an empty root** `[]` (written to
`cordis.yml` as `# ... an empty entry list ...`), in this layer order
(`dsh/lib/profile-boot-DG5t9aNs.js:147-198`, README `@deepseek-ai/dsh/README.md:32-39`):

1. each bundle's patch list, in `dsh.profile.bundles` order;
2. the profile's own `cordis.patch.yml`;
3. the home-level `$DSH_HOME/cordis.patch.yml` (applies to every profile);
4. `--patch <path>` overlays (argv order);
5. the telemetry switch patch (`DSH_TELEMETRY_DISABLED` → disable the
   `session-telemetry-otel` row).

Mechanics: `composeEntries(layers)` = `applyEntryPatches([], layers.flat())`
(`dsh-app-boot/lib/index.js:575-583`); `boot()` creates a root `Context`, sets
`ctx.baseUrl` to the config dir, provides `ctx.dshHomePath`, loads the
`Loader` plugin, mounts a root include (`cordis:include` with the patch list),
and awaits the tree (`dsh-app-boot/lib/index.js:1166-1195`). Live-verified
end-to-end with the real CLI:

```
live: DSH_HOME=/tmp/... dsh --profile headless --dump-default-config
live: → "# == @deepseek-ai/dsh-base" ... rows; hmr disabled by @deepseek-ai/dsh-headless overlay
live: dsh plugin --profile testp add /tmp/dsh-contract/test-bundle   (local bundle declaring dsh.bundle)
live: → profile auto-initialized, pnpm install ran, dsh.profile.bundles now:
live:   ["@deepseek-ai/dsh-base", "@dsh-contract-test/test-bundle"]
live: dsh --profile testp --dump-default-config
live: → "# == @dsh-contract-test/test-bundle" with the bundle's insert rows composed
```

### 5.5 `dsh plugin add` reconcile behavior

`dsh plugin` is a **thin pnpm forwarder** (`dsh/lib/plugin-9h8shc4d.js:1-129`):

1. `runPlugin(profile, args)` resolves the profile dir; if no `package.json`,
   `initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)`
   (`plugin-9h8shc4d.js:101-106`). Templates: `web` → `[dsh-base, dsh-web-app]`,
   `headless` → `[dsh-base, dsh-headless]`; default → `[dsh-base]`
   (`dsh-app-boot/lib/index.js:323-334`).
2. Forwards args verbatim to `pnpm` with cwd = profile dir
   (`spawnSync('pnpm', args, {cwd: dir})`, `plugin-9h8shc4d.js:108-112`). Relative
   path specs (`.`, `../x`) are anchored to the invoking directory
   (`anchorPathSpec`, `:90-94`). `dsh plugin --profile <name> add <pkg>` ==
   `pnpm add <pkg>` in the profile.
3. On pnpm exit 0: **`reconcilePlugins(before, dir)`** (`:46-78`): reads the
   updated manifest, and for each dependency that **now resolves to a package
   declaring `dsh.bundle.patch`**, appends it to `dsh.profile.bundles` (dependency
   order); removes names that stopped being bundles; warns once per
   newly-added bundle-less dependency. Reconciliation is by **installed state**,
   not dependency diff — so `update` activates a package that gained its bundle
   declaration in a newer version.
4. pnpm missing → exit 127 with "install pnpm to manage profile plugins" (`:113-117`).

Live-verified: `dsh plugin --profile testp add /tmp/dsh-contract/test-bundle`
created the profile, ran pnpm (link install), and appended the bundle to
`dsh.profile.bundles`.

### 5.6 CLI surface (`@deepseek-ai/dsh` bin)

`dsh/lib/bin.js:74-114` (commander grammar):

```
dsh --profile <name> [args...]          # boot a profile
dsh web [args...]                       # alias of --profile web
dsh plugin --profile <name> <pnpm args> # forward to pnpm + reconcile (§5.5)
dsh --profile <name> --patch <path>...  # extra patch overlays
dsh --profile <name> --dump-config      # print composed tree (with user layer)
dsh --profile <name> --dump-default-config  # print bundle layers only
```

- Launcher parses only its own flags; everything after the first unknown token is
  handed to the booted app via `ctx.cmdlineArgs` (`profile-boot-DG5t9aNs.js:247-254`,
  `provideCmdline`). App plugins inject their own flag families
  (`@deepseek-ai/dsh-cmdline`).
- Live-verified: `dsh --version` → `0.1.0-rc.6`; `--help` shows the grammar above.

---

## 6. Installability verdict per `@deepseek-ai/dsh-*` dependency

### 6.1 What the registry says

Checked `registry.npmjs.org` metadata for every package relevant to rolebox.
The critical nuance: **`publishConfig.access` is per-version**, and the npm
`latest` dist-tag for most dsh packages is stale:

| Package | `latest` tag → version | that version's access | `0.1.0-rc.6` access |
|---|---|---|---|
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | public | **public** |
| `@deepseek-ai/cordis` | `4.0.1` | public | — |
| `@deepseek-ai/schemastery` | `3.18.1` | public | — |
| `@deepseek-ai/dsh-tools` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-session` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-subagent` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.6` | public | **public** |
| `@deepseek-ai/dsh-home-paths` | `0.0.1-rc.3` | **restricted** | **public** |
| `@deepseek-ai/dsh-app-boot` | `0.1.0-rc.6` | public | **public** |
| `@deepseek-ai/dsh-base` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-llm` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-scope` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-brand` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-invariants` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-system-prompt` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-code-runtime` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-user-approval` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-sandbox-policy` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-sandbox` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-agent-presets` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-session-persistence` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-session-projection` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-session-projection-cache` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-jobs` | `0.0.1-rc.3` | **restricted** | **public** |
| `@deepseek-ai/dsh-typert-protocol` | `0.1.0-rc.6` | public | **public** |
| `@deepseek-ai/dsh-launch-environment` | `0.0.1-rc.3` | **restricted** | **public** |
| `@deepseek-ai/dsh-cmdline` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-web-app` | `0.0.1-rc.1` | **restricted** | **public** |
| `@deepseek-ai/dsh-headless` | `0.0.1-rc.1` | **restricted** | **public** |

### 6.2 Live install tests

- **Unpinned install FAILS**: `npm install @deepseek-ai/dsh-tools @deepseek-ai/dsh-session
  @deepseek-ai/dsh-subagent @deepseek-ai/dsh-home-paths @deepseek-ai/dsh-base`
  (no version) resolves the stale `latest` (restricted) versions and fails:
  `npm error 404 Not Found - GET https://registry.npmjs.org/@deepseek-ai/dsh-bash`
  (a transitive dep of the restricted `0.0.1-rc.1` tree). Confirms restricted
  packages are NOT third-party installable.
- **Pinned rc.6 install SUCCEEDS**: `npm install @deepseek-ai/dsh-tools@0.1.0-rc.6
  @deepseek-ai/dsh-session@0.1.0-rc.6 @deepseek-ai/dsh-subagent@0.1.0-rc.6
  @deepseek-ai/dsh-home-paths@0.1.0-rc.6 @deepseek-ai/cordis@4.0.1
  @deepseek-ai/schemastery@3.18.1` → "added 20 packages".
- **Range resolves to rc.6**: `"@deepseek-ai/dsh-tools@^0.1.0-rc.6"` etc. install
  `0.1.0-rc.6` (verified `require(pkg/package.json).version`).
- **Peer closure installs**: the full peer set of dsh-tools/subagent/session/agent
  pinned at rc.6 installs cleanly (`@deepseek-ai/dsh-llm`, `-scope`, `-brand`,
  `-invariants`, `-system-prompt`, `-code-runtime`, `-user-approval` + cordis +
  schemastery → "added 20 packages").
- **Full dsh CLI installs**: `npm install @deepseek-ai/dsh@0.1.0-rc.6` (with
  `--ignore-scripts` due to native build deps on this machine) → 529 packages;
  `./node_modules/.bin/dsh --version` → `0.1.0-rc.6`.

### 6.3 Verdict for rolebox

- **All packages rolebox needs are installable at `0.1.0-rc.6` (public).** There
  is no need to restrict rolebox to `@deepseek-ai/cordis` + injected ctx services
  only — depending on `@deepseek-ai/dsh-tools`, `-session`, `-subagent`,
  `-agent`, `-home-paths` at pinned rc.6 is viable.
- **Constraint**: rolebox must pin **exact `0.1.0-rc.6` versions** (or a range that
  resolves to them, e.g. `^0.1.0-rc.6`), and must **not** install these packages
  unpinned / via the `latest` dist-tag — the stale `latest` points at restricted
  `0.0.1-rc.*` versions that 404 for third parties.
- The restricted packages are inaccessible to third-party installs (E404 proven),
  but the current rc.6 line is fully public — the "restricted" flag in the
  strategy applies only to the abandoned `0.0.1-rc.*` versions still tagged
  `latest`.

---

## 7. Risks / flags

- **`[UNVERIFIED]`** — Behavior of `ctx.agents.create()` with a real
  `AgentFactory` (requires `@deepseek-ai/dsh-agent-loop`, a heavyweight package
  not part of this contract verification). The `AgentRegistry` surface and
  `AgentFactory` interface are verified from types; the loop's concrete
  create/resume behavior is not exercised here.
- **`[UNVERIFIED]`** — `ctx.subagents.start()` with a real provider
  (`-spawn-in-process` / `-fork` / `-acp`). The seam (`SubagentRuntime`,
  `SubagentProvider`, `SubagentRun`) is verified from types + a stub provider
  registration; actual child-agent spawn requires the provider packages, which
  depend on the agent loop.
- **`[UNVERIFIED]`** — `dsh plugin add` against a **registry-published** (not
  local-path) bundle; the live test used a local directory spec. The reconcile
  code path is identical (installed-state based), so risk is low.
- **`[UNVERIFIED]`** — `!!js` expression evaluation details beyond the examples
  seen in `dsh-base/cordis.patch.yml` (the loader's `evaluate` uses a
  context; exact available bindings are loader-internal). Documented examples:
  `process.env.X`, `process.cwd()`, `process.platform`, `dshHomePath(...)`.
- **API stability**: `0.1.0-rc.6` is a release candidate; all signatures above
  are pinned to that version. Cross-version drift is possible and re-verification
  is required before upgrading.

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
