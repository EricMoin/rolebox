# dsh provider configuration — findings note (subtask 1)

**Status:** read-only verification, no `src/` changes.
**Date:** 2026-09-09
**Scope:** dsh provider/model vocabulary relevant to the "dsh provider config gap".
**Source of truth:** `/path/to/harness-checkout` (source checkout, version `0.1.5-rc.1`).
**Secondary (installed):** `node_modules/@deepseek-ai/*` — the installed packages are the `0.1.5-rc.1` line (`@deepseek-ai/cordis@4.0.2`, `@deepseek-ai/schemastery@3.18.2`); see caveat §6.
**Out of bounds (not read):** `~/.dsh/settings.yaml`.

This note is intended to be referenced by later subtasks. All claims carry `path:line` citations.

---

## 1. `agent-default-model` settings schema and key path

| Fact | Evidence |
|---|---|
| Settings namespace is the literal string `agent-default-model`. | `packages/core/agent-default-model/src/index.ts` — `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'` |
| The settings namespace grammar is `^[a-z][a-z0-9-]*$` and the literal string is used **unchanged** as the section key (no prefixing). | `packages/settings/settings/src/index.ts` — `NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/` |
| The settings document's top-level key **is** the namespace string. | `packages/settings/settings-file/src/index.ts` — `new Document({ [ns]: section })`; parse side requires "a map of namespace sections" |
| Schema is exactly `{ provider: string (required), model: string (required), reasoningEffort?: string }`. | `packages/core/agent-default-model/src/index.ts` |
| Composition `Config` is `{ provider, model }` (both required). | source |
| `provider`/`model` are plain strings — **no enum, no pattern, no route-existence check in the schema**. | `z.string().required()` |
| The stored YAML key path is therefore `agent-default-model.provider`, `agent-default-model.model`, `agent-default-model.reasoningEffort`. | derived from the two facts above |
| Selection is read via `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }`; written via `saveSelection()`. | `packages/core/agent-default-model/src/index.ts` |
| Host seed for create/resume uses exactly that pair. | `packages/api/session-controller/src/agent.ts` — `const { provider, model } = this.ctx.agentDefaultModel.currentSelection(); return { provider, model }` |

*From `packages/core/agent-default-model/src/index.ts` — the namespace literal, `AgentDefaultModelSettings`, and `AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA`:*

```ts
/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})
```

The settings document read above lives at `$DSH_HOME/settings.yaml`, where
`$DSH_HOME` is resolved by `resolveDshHome()` (`packages/util/home-paths/src/index.ts`;
the env var name is `DSH_HOME`; the default is `~/.dsh`).

**Key-path shape (illustrative only — actual values are user-owned and were not read):**

```yaml
agent-default-model:
  provider: <route-key>
  model: <provider-owned model id>
  # reasoningEffort: <adapter-owned effort id>   # optional
```

---

## 2. How provider routes are registered and listed

| Fact | Evidence |
|---|---|
| Adapters register one or more **provider routes** (arbitrary strings). | `packages/llm/llm/src/index.ts` — `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` |
| Registered routes are listed with `listProviders(): LlmProviderInfo[]`. | source |
| `LlmProviderInfo` is `{ id: string; name: string }`; `id` is documented as "Provider route key used by `GenerateOptions.provider`". | `packages/llm/llm/src/types.ts` |
| Configurable (live or dormant) routes are listed with `listConfigurableProviders(): LlmConfigurableProvider[]`. | `packages/llm/llm/src/index.ts`; type `types.ts` (`provider`, `displayName`, `settingsNs`, `settingsPath`, `declared?`) |
| Configurable (live or dormant) routes are listed with `listConfigurableProviders(): LlmConfigurableProvider[]`. | `packages/llm/llm/src/index.ts`; type `types.ts` (`provider`, `displayName`, `settingsNs`, `settingsPath`, `declared?`) |
| The configurable-provider directory entry is `LlmConfigurableProvider` = `{ provider, displayName, settingsNs, settingsPath, declared? }`. | `packages/llm/llm/src/types.ts` |
| Turn-start gate checks the selection against registered routes. | `packages/api/session-controller/src/commands.ts` — `ctx.llm.listProviders().some(entry => entry.id === provider)` |

*From `packages/llm/llm/src/index.ts` — the `registerAdapter` signature:*

```ts
  /**
   * Register an adapter for the given provider routes. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that streams calls for those providers.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
```

*From `packages/llm/llm/src/types.ts` — `LlmProviderInfo`:*

```ts
/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}
```

*From `packages/llm/llm/src/types.ts` — `LlmConfigurableProvider` (body through `declared?`; `error?` and the closing brace follow):*

```ts
export interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string
  /** Human-readable provider name for configuration surfaces. */
  displayName: string
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[]
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean
```

---

## 3. Concrete route-name vocabulary

### 3a. Shipped route from `llm-deepseek`

- Route key: **`openai`** — `packages/llm/llm-deepseek/src/index.ts` (`const PROVIDER = 'openai'`).
- Configurable declaration: settings namespace `llm-deepseek`, `settingsPath: []` (`const NS = 'llm-deepseek'`).
- This is the only hard-coded route name in the harness.

*From `packages/llm/llm-deepseek/src/index.ts` — `NS` and the `PROVIDER` route constant:*

```ts
const NS = 'llm-deepseek'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'openai'
```

### 3b. Routes from `llm-pi-ai` (arbitrary / user-declared)

- **The `providers` dict key IS the route name.** — `packages/llm/llm-pi-ai/src/config.ts` ("the `providers` dict key IS the route").
- Config shape: `providers?: Record<string, PiAiProviderProfile>` — `config.ts`; schema `z.dict(profile).default({})` — `config.ts`.
- Registration uses the profile keys verbatim: `const routes = [...profiles().keys()]; registration = ctx.llm.registerAdapter(routes, adapter)` — `packages/llm/llm-pi-ai/src/index.ts`.
- The **only** route-key validation is non-empty: `if (provider.length === 0) throw ... 'provider names must be non-empty'` — `config.ts`. There is no charset pattern, no catalog-membership requirement, and no reserved-name list.
- Settings key path per route: `llm-pi-ai.providers.<route>` — `index.ts` (`settingsPath: ['providers', provider]`); namespace `NS = 'llm-pi-ai'` at `index.ts`.
- A route that the installed pi-ai catalog ships inherits its endpoint/protocol/models; a route pi-ai does **not** ship is "declared outright" and **must name a protocol** (`api`). — module doc `index.ts` (hand-declared example `acme-gateway`); `config.ts` ("a route the catalog does not ship must name one" for `api`).
- Supported hand-declared protocols: **`openai-completions`, `openai-responses`, `anthropic-messages`** — `packages/llm/llm-pi-ai/src/provider.ts`.
- Built-in catalog ids are dynamic, sourced from `@earendil-works/pi-ai@0.85.1` via `catalogProviderIds()` → `getBuiltinProviders()`. — `packages/llm/llm-pi-ai/src/catalog.ts`; dep at `packages/llm/llm-pi-ai/package.json`. **Not enumerable in this environment**: neither the clone nor rolebox has `node_modules/@earendil-works/pi-ai` installed (verified absent).
- Configurable-directory union: every catalog id plus every declared route — `index.ts`.

*From `packages/llm/llm-pi-ai/src/config.ts` — `PiAiProviderProfile` (the `providers` dict key IS the route):*

```ts
/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
```

*From `packages/llm/llm-pi-ai/src/config.ts` — the non-empty route-key validation:*

```ts
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source)
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
```

*From `packages/llm/llm-pi-ai/src/index.ts` — `registerAdapter(routes, adapter)`:*

```ts
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
```

---

## 4. Can route names match opencode provider keys (`openrouter` / `openrouter-anthropic` / `openrouter-dev`)?

**Name feasibility: YES.** These are valid `llm-pi-ai` route keys — arbitrary non-empty strings with no pattern constraint (`config.ts`).

Direct evidence that `openrouter` is already used this way by the harness's own client code:

- `packages/client/ui-settings-models/tests/readiness.client.spec.ts` — `provider: 'openrouter'`
- `settingsNs: 'llm-pi-ai'`
- `settingsPath: ['providers', 'openrouter']`
- `apiKeyEnv: 'OPENROUTER_API_KEY'`

Also, the default-model test drives `agent-default-model` with an arbitrary route: `provider: 'acme-gateway'` — `packages/core/agent-default-model/tests/agent-default-model.spec.ts` (save/read round-trip).

**Sufficiency caveat (name match ≠ working route):**

1. The route must actually be **registered** before it can start a turn; otherwise dispatch fails `NO_ADAPTER` (`llm/src/index.ts`). `agent-default-model` itself does not validate existence (`z.string().required()`).
2. If a key equals a built-in pi-ai catalog id, the catalog supplies endpoint/protocol/models. If it does not — the likely case for `openrouter`, `openrouter-anthropic`, `openrouter-dev` — the profile must be declared with `api` (one of the three protocols), `baseURL`, and `models` (`config.ts`; `index.ts`).
3. `openrouter-anthropic` maps naturally to protocol `anthropic-messages`; `openrouter` / `openrouter-dev` most likely `openai-completions` (protocol choice is deployment data, not verified here).

**Conclusion:** the dsh provider vocabulary is open — route keys are user-chosen dict keys, so opencode provider keys can be mirrored 1:1. The gap is not naming; it is that each mirrored key needs a matching `llm-pi-ai.providers.<key>` profile (or catalog hit) registered for it.

---

## 5. End-to-end shape (what a later subtask can rely on)

```
settings.yaml
├── agent-default-model:            # namespace key (literal)
│     provider: openrouter                # must equal a registered route id
│     model: anthropic/claude-sonnet-4
└── llm-pi-ai:                      # namespace key (literal)
      providers:
        openrouter:                       # route key = dict key (arbitrary)
          api: openai-completions   # required when not a built-in catalog id
          baseURL: https://.../v1
          apiKeyEnv: OPENROUTER_API_KEY
          models: [ { id: ..., name: ..., contextWindow: ..., maxTokens: ... } ]
        openrouter-anthropic:
          api: anthropic-messages
          baseURL: https://.../v1
          ...
```

`ctx.agentDefaultModel.currentSelection()` → `{ provider: 'openrouter', model: '...' }` is passed as the create/resume seed (`packages/api/session-controller/src/agent.ts`); `ctx.llm.listProviders()` reports active routes; the configurable-provider directory is `listConfigurableProviders()` (`packages/llm/llm/src/index.ts`, type `packages/llm/llm/src/types.ts`).

---

## 6. Version caveat (must be honored by later subtasks)

- Source checkout = **`0.1.5-rc.1`**; installed `node_modules/@deepseek-ai/*` are the **`0.1.5-rc.1`** line (verified: `dsh-skill`, `dsh-session`, `dsh-llm`, … at `0.1.5-rc.1`; `@deepseek-ai/cordis@4.0.2`, `@deepseek-ai/schemastery@3.18.2`).
- The provider adapter packages `@deepseek-ai/dsh-llm-pi-ai` and `@deepseek-ai/dsh-llm-deepseek` are **not installed** in rolebox `node_modules` (the installed `@deepseek-ai/*` set is the pinned runtime subset). Route vocabulary therefore comes from the source checkout, not from `node_modules`.
- The superseded `0.1.0-rc.6`-installed skew claims — the `@deepseek-ai/dsh-host-apiproxy` and dist `node_modules/@deepseek-ai/*` citations that formerly appeared in §1/§2/§7 — have been **replaced** with `0.1.5-rc.1` source citations. `@deepseek-ai/dsh-host-apiproxy` is not present in the source checkout, so its old "host-facing provider view"/"host seed" claims now cite the real source locations: `packages/api/session-controller/src/{agent.ts,commands.ts}` and the `LlmConfigurableProvider` type in `packages/llm/llm/src/types.ts`. The provider vocabulary itself is verified from the `0.1.5-rc.1` source checkout (`packages/core/agent-default-model/src/index.ts`, `packages/llm/llm/src/index.ts` + `types.ts`, `packages/llm/llm-pi-ai/src/*`, `packages/llm/llm-deepseek/src/index.ts`).
- The `agent-default-model` and `dsh-llm` shapes cited here are read from the `0.1.5-rc.1` source checkout; exact line numbers are source line numbers and move with the checkout.

---

## 7. Evidence index (quick lookup)

| Claim | Citation |
|---|---|
| Namespace literal + schema | `harness-source/packages/core/agent-default-model/src/index.ts` |
| Namespace grammar + YAML top-level key | `harness-source/packages/settings/settings/src/index.ts`; `harness-source/packages/settings/settings-file/src/index.ts` |
| registerAdapter / listProviders | `harness-source/packages/llm/llm/src/index.ts` |
| `LlmProviderInfo.id` = route key | `harness-source/packages/llm/llm/src/types.ts` |
| `NO_ADAPTER` dispatch failure | `harness-source/packages/llm/llm/src/index.ts` |
| `openai` route | `harness-source/packages/llm/llm-deepseek/src/index.ts` |
| pi-ai dict key = route; arbitrary; non-empty only | `harness-source/packages/llm/llm-pi-ai/src/config.ts`; `src/index.ts` |
| pi-ai settingsPath | `harness-source/packages/llm/llm-pi-ai/src/index.ts` |
| hand-declared route + required protocol | `harness-source/packages/llm/llm-pi-ai/src/index.ts`; `src/config.ts` |
| protocol vocabulary | `harness-source/packages/llm/llm-pi-ai/src/provider.ts` |
| `openrouter` already used as route | `harness-source/packages/client/ui-settings-models/tests/readiness.client.spec.ts` |
| arbitrary route as default model | `harness-source/packages/core/agent-default-model/tests/agent-default-model.spec.ts` (acme-gateway round-trip) |
| host seed / turn-start gate | `harness-source/packages/api/session-controller/src/agent.ts`; `harness-source/packages/api/session-controller/src/commands.ts` |
| installed vs clone version skew | `.rolebox/evidence/subtask1-clone-index.md` |
