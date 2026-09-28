/**
 * opencode v2 agent registration — maps rolebox's resolved roles and
 * subagents onto the v2 `ctx.agent.transform` editor.
 *
 * Two verified v2 properties shape this file:
 *
 *  1. The agent editor has NO `add` — `list/get/default/update/remove` only
 *     (node_modules/@opencode/plugin/dist/promise/agent.d.ts:5-11).
 *     `update(id, fn)` UPSERTS: when the id is unknown the host creates the
 *     entry from `Agent.Info.default(id)` (…/schema/dist/agent.d.ts:89, the
 *     `default` member of the `Info` struct: mode "primary", hidden false, an
 *     empty `request`, the default allow/ask ruleset). Every role and
 *     sub-agent therefore registers through `update`, and the updater assigns
 *     only the fields rolebox owns, so host defaults — and any other plugin's
 *     transform — survive.
 *
 *  2. `Agent.Info` is
 *       { id, name, model?: Model.Ref, request: Provider.Request, system?,
 *         description?, mode: "subagent" | "primary" | "all", hidden: boolean,
 *         color?, steps?, permissions: Permission.Ruleset }
 *     (…/schema/dist/agent.d.ts:11-88). `Provider.Request` is
 *     `{ settings, headers, body }` (…/schema/dist/provider.d.ts:146-163) and
 *     `Permission.Rule` is `{ action, resource, effect }`
 *     (…/schema/dist/permission.d.ts:306-310).
 *
 * The VALUES come from the same assembly the v1 path uses instead of being
 * re-derived: `buildAgentConfig` (src/prompt/agent-config.ts:68) supplies
 * prompt/mode/model/description/color/variant/temperature/top_p/tools/permission,
 * `transformPermission` (src/prompt/agent-config.ts:39) normalizes rolebox's
 * `{allow, deny}` permission block, and `splitModel` (src/platform/model-ref.ts:32)
 * splits the resolved `"<provider>/<model-id>"` string.
 *
 * No SDK value is imported at runtime: the editor/domain types below are the
 * structural view the entry hands over, and the type-level guards at the end
 * of the host-surface section prove the REAL `Plugin.Context["agent"]` (and
 * its updater parameter) satisfies them.
 */

import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import type {
  PermissionConfig,
  ResolvedRole,
  ResolvedSubAgent,
} from "../../../types.ts";
import { RoleMode } from "../../../constants.ts";
import {
  buildAgentConfig,
  transformPermission,
} from "../../../prompt/agent-config.ts";
import type { RoleboxAgentConfig } from "../../../prompt/agent-config.ts";
import { splitModel } from "../../model-ref.ts";
import { createSubLogger } from "../../../logger.ts";

const log = createSubLogger("opencode2-agents");

// ── Host surface (structural view of ctx.agent / AgentEditor) ──────────────

/** `Agent.Info.mode` — the same three literals as rolebox's `RoleMode`. */
export type Opencode2AgentMode = "subagent" | "primary" | "all";

/** `Permission.Effect` (…/schema/dist/permission.d.ts:297). */
export type Opencode2PermissionEffect = "allow" | "deny" | "ask";

/** `Permission.Rule` (…/schema/dist/permission.d.ts:301-305). */
export interface Opencode2PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: Opencode2PermissionEffect;
}

/** `Model.Ref` projected onto the fields rolebox sets (…/schema/dist/agent.d.ts, the `model`
 * member: id, providerID, variant). */
export interface Opencode2AgentModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/**
 * `Provider.Request` projected onto the part rolebox writes: the provider
 * request body, where `Agent.Info.request.body` (`Record<string, any>`,
 * …/schema/dist/provider.d.ts:146-163) carries generation options such as
 * temperature and top_p.
 */
export interface Opencode2AgentProviderRequestBody {
  body: Record<string, unknown>;
}

/**
 * The agent fields rolebox reads and writes. Guarded below against the host's
 * own mutable agent type: every key here must exist on `DeepMutable<Agent.Info>`
 * (the updater's parameter), so a host rename fails `bun run typecheck` here
 * instead of silently writing nothing at runtime.
 */
export interface Opencode2MutableAgentInfo {
  id: string;
  name: string;
  model?: Opencode2AgentModelRef;
  request: Opencode2AgentProviderRequestBody;
  system?: string;
  description?: string;
  mode: Opencode2AgentMode;
  hidden: boolean;
  color?: string;
  steps?: number;
  permissions: Opencode2PermissionRule[];
}

/**
 * The updater's real parameter type — `DeepMutable<Agent.Info>`
 * (…/promise/agent.d.ts:9, …/promise/types.d.ts:1-3), derived from the
 * installed host declarations instead of re-declared by hand.
 */
export type Opencode2HostMutableAgentInfo = Parameters<
  Parameters<Opencode2Plugin.Context["agent"]["transform"]>[0]
>[0] extends { update(id: string, update: (agent: infer A) => void): void }
  ? A
  : never;

/**
 * `AgentEditor` projected onto what registration uses. The updater parameter is
 * the host's own mutable agent type: `DeepMutable` maps effect's branded string
 * fields (`Agent.ID`, `Agent.Name`, `Model.ID`) into object types, so a
 * hand-written plain view cannot be the callback parameter (the compiler is
 * right to reject it). `add` is deliberately absent — v2 has none
 * (…/promise/agent.d.ts:5-11).
 */
export interface Opencode2AgentEditor {
  update(id: string, update: (agent: Opencode2HostMutableAgentInfo) => void): void;
}

/** `AgentDomain` projected onto what registration uses. */
export interface Opencode2AgentDomain {
  transform(
    callback: (editor: Opencode2AgentEditor) => void,
  ): Promise<{ dispose: () => Promise<void> }>;
}

// ── Compile-time guards ────────────────────────────────────────────────────

type _IsTrue<T extends true> = T;

/**
 * `DeepMutable` (…/promise/types.d.ts:1-3) maps effect's branded string types
 * (`Agent.ID`, `Agent.Name`, `Model.ID`) into object types, so a plain string
 * cannot be assigned to those fields even though the brand is erased at
 * runtime. The editor therefore hands the updater the host's own parameter
 * type, and the patch is applied through the plain field view above — this
 * guard proves that view names only fields the host type actually has.
 */
type _AgentFieldsExist = _IsTrue<
  keyof Opencode2MutableAgentInfo extends keyof Opencode2HostMutableAgentInfo
    ? true
    : false
>;

/** The real editor satisfies the `update`-only view used here. */
type _AgentEditorSatisfiesView = _IsTrue<
  Parameters<Parameters<Opencode2Plugin.Context["agent"]["transform"]>[0]>[0] extends Opencode2AgentEditor
    ? true
    : false
>;

/** The real `ctx.agent` can be handed to {@link registerOpencode2Agents} unchanged. */
type _AgentDomainSatisfiesView = _IsTrue<
  Opencode2Plugin.Context["agent"] extends Opencode2AgentDomain ? true : false
>;

// ── Mapping (pure — no host, no I/O) ───────────────────────────────────────

/**
 * The agent fields rolebox owns, as applied to one host agent entry.
 *
 * `mode` and `system` are always written (rolebox defines the agent);
 * everything else is written only when rolebox resolved a value for it, so
 * the host's defaults stay in place otherwise. `hidden` is set for
 * sub-agents only — a role keeps whatever the host (or another plugin)
 * decided.
 */
export interface Opencode2AgentPatch {
  name: string;
  mode: Opencode2AgentMode;
  system: string;
  description?: string;
  color?: string;
  model?: Opencode2AgentModelRef;
  /** Entries merged into `Agent.Info.request.body` (never replacing sibling keys). */
  requestBody?: Record<string, unknown>;
  permissions?: readonly Opencode2PermissionRule[];
  hidden?: boolean;
}

/** One `editor.update(id, …)` call: the host agent id and the fields to write. */
export interface Opencode2AgentRegistration {
  id: string;
  patch: Opencode2AgentPatch;
}

function isPermissionEffect(value: string): value is Opencode2PermissionEffect {
  return value === "allow" || value === "deny" || value === "ask";
}

/**
 * Map rolebox's permission block onto a v2 `Permission.Ruleset`.
 *
 * `transformPermission` (src/prompt/agent-config.ts:39) already normalizes the
 * rolebox `{allow: [...], deny: [...]}` form into opencode's per-tool
 * `{ read: "allow", bash: "deny" }` record (and passes an already-per-tool
 * config through untouched), so the ruleset is derived from that record rather
 * than from the raw config.
 *
 * `resource` is `"*"` for every rule: rolebox's config has no per-resource
 * pattern, and v2's rule is `{ action, resource, effect }` — the v1 ruleset's
 * `{ permission, pattern, action }` renamed one-for-one
 * (…/schema/dist/v1/permission.d.ts:8-14), i.e. tool name → `action`, pattern →
 * `resource`, allow/deny/ask → `effect`.
 */
export function mapPermissionRuleset(
  permission: PermissionConfig | undefined,
): Opencode2PermissionRule[] {
  const record = transformPermission(permission);
  const rules: Opencode2PermissionRule[] = [];
  for (const [action, effect] of Object.entries(record ?? {})) {
    if (!isPermissionEffect(effect)) {
      // A hand-written per-tool config can carry an effect v2 does not know
      // (the pass-through branch of transformPermission). Skip it loudly
      // instead of writing an invalid rule into the host ruleset.
      log.debug("skipping permission rule with unknown effect", { action, effect });
      continue;
    }
    rules.push({ action, resource: "*", effect });
  }
  return rules;
}

/**
 * Map rolebox's `tools: { bash: false }` map onto permission rules.
 *
 * `Agent.Info` has no `tools` member (…/schema/dist/agent.d.ts:11-88), so the
 * only v2 expression of "this agent may not call tool X" is a deny rule.
 * `false` therefore becomes `{ action: <tool>, resource: "*", effect: "deny" }`
 * and `true` an explicit allow. Written after the permission rules, so an
 * explicit per-tool entry is the last word on that tool.
 */
export function mapToolRuleset(
  tools: Record<string, boolean> | undefined,
): Opencode2PermissionRule[] {
  const rules: Opencode2PermissionRule[] = [];
  for (const [action, enabled] of Object.entries(tools ?? {})) {
    rules.push({ action, resource: "*", effect: enabled ? "allow" : "deny" });
  }
  return rules;
}

/**
 * `Agent.Info.request.body` entries for the generation options rolebox
 * resolves. `RoleConfig`/`SubAgentConfig` declare no provider-option bag
 * (src/types.core.ts:88-153), so temperature and top_p are the whole body.
 */
function resolveRequestBody(
  config: RoleboxAgentConfig,
): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  if (config.temperature !== undefined) body["temperature"] = config.temperature;
  if (config.top_p !== undefined) body["top_p"] = config.top_p;
  return Object.keys(body).length > 0 ? body : undefined;
}

/** Split the resolved `"<provider>/<model-id>"` into a v2 `Model.Ref`. */
function resolveModel(
  config: RoleboxAgentConfig,
): Opencode2AgentModelRef | undefined {
  const ref = splitModel(config.model);
  if (ref === null) {
    if (config.model !== undefined && config.model !== "") {
      log.debug("model is not a resolvable provider/model id — not set on the v2 agent", {
        model: config.model,
      });
    }
    return undefined;
  }
  return {
    id: ref.id,
    providerID: ref.provider,
    ...(config.variant !== undefined ? { variant: config.variant } : {}),
  };
}

function resolvePermissions(
  config: RoleboxAgentConfig,
): Opencode2PermissionRule[] | undefined {
  const rules = [
    ...mapPermissionRuleset(config.permission),
    ...mapToolRuleset(config.tools),
  ];
  return rules.length > 0 ? rules : undefined;
}

function assignDefined(
  patch: Opencode2AgentPatch,
  extra: {
    description?: string;
    color?: string;
    model?: Opencode2AgentModelRef;
    requestBody?: Record<string, unknown>;
    permissions?: readonly Opencode2PermissionRule[];
    hidden?: boolean;
  },
): Opencode2AgentPatch {
  if (extra.description !== undefined) patch.description = extra.description;
  if (extra.color !== undefined) patch.color = extra.color;
  if (extra.model !== undefined) patch.model = extra.model;
  if (extra.requestBody !== undefined) patch.requestBody = extra.requestBody;
  if (extra.permissions !== undefined) patch.permissions = extra.permissions;
  if (extra.hidden !== undefined) patch.hidden = extra.hidden;
  return patch;
}

/**
 * Pure `ResolvedRole` → agent patch mapping.
 *
 * `name` follows the platform-neutral definition the existing registrars build
 * (src/sync/agent-files.ts:35-43: `id` = role id, `name` = `config.name`), and
 * `system` is the role's fully resolved prompt — the same value
 * `buildAgentConfig().prompt` hands the v1 config hook
 * (src/core/services/hook-service.ts:222-224).
 */
export function mapResolvedRoleToAgent(role: ResolvedRole): Opencode2AgentRegistration {
  const config = buildAgentConfig(role);
  const patch = assignDefined(
    {
      name: role.config.name !== "" ? role.config.name : role.id,
      mode: config.mode,
      system: config.prompt,
    },
    {
      description: config.description,
      color: config.color,
      model: resolveModel(config),
      requestBody: resolveRequestBody(config),
      permissions: resolvePermissions(config),
    },
  );
  return { id: role.id, patch };
}

/**
 * Pure `ResolvedSubAgent` → agent patch mapping.
 *
 * Mirrors the v1 sub-agent registration (src/core/services/hook-service.ts:199-216):
 * mode is always "subagent" and the agent is hidden, while the per-sub-agent
 * overrides ride the same `buildAgentConfig` assembly as a role — a
 * `ResolvedSubAgent` carries the same `prompt` + `config` pair, with the mode
 * forced to subagent.
 */
export function mapResolvedSubAgentToAgent(
  sub: ResolvedSubAgent,
): Opencode2AgentRegistration {
  const config = buildAgentConfig({
    ...sub,
    config: { ...sub.config, mode: RoleMode.Subagent },
  } as ResolvedRole);
  const patch = assignDefined(
    {
      name: sub.config.name !== "" ? sub.config.name : sub.id,
      mode: RoleMode.Subagent,
      system: sub.prompt,
      hidden: true,
    },
    {
      description: config.description,
      color: config.color,
      model: resolveModel(config),
      requestBody: resolveRequestBody(config),
      permissions: resolvePermissions(config),
    },
  );
  return { id: sub.id, patch };
}

/**
 * Every role and every (recursively nested) sub-agent, in registration order.
 * Collection mirrors the platform-neutral registrar
 * (src/sync/agent-files.ts:13-53): roles first, then their sub-agents.
 */
export function collectOpencode2AgentRegistrations(
  roles: readonly ResolvedRole[],
): Opencode2AgentRegistration[] {
  const registrations: Opencode2AgentRegistration[] = [];

  function collectSubAgents(subagents: readonly ResolvedSubAgent[]): void {
    for (const sub of subagents) {
      registrations.push(mapResolvedSubAgentToAgent(sub));
      collectSubAgents(sub.subagents);
    }
  }

  for (const role of roles) {
    registrations.push(mapResolvedRoleToAgent(role));
    collectSubAgents(role.subagents);
  }
  return registrations;
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Write one patch onto the host's mutable agent entry, in place.
 *
 * The host type's branded string fields are mapped into object types by
 * `DeepMutable` (see `_AgentFieldsExist`), so the update is written through
 * the plain field view. The brand is erased at runtime — the values written
 * are plain strings — and the view is proven to name only real host fields.
 */
export function applyOpencode2AgentPatch(
  agent: Opencode2HostMutableAgentInfo,
  patch: Opencode2AgentPatch,
): void {
  const target = agent as unknown as Opencode2MutableAgentInfo;
  target.name = patch.name;
  target.mode = patch.mode;
  target.system = patch.system;
  if (patch.description !== undefined) target.description = patch.description;
  if (patch.color !== undefined) target.color = patch.color;
  if (patch.hidden !== undefined) target.hidden = patch.hidden;
  if (patch.model !== undefined) target.model = { ...target.model, ...patch.model };
  // Merge, never replace: the host's default body (or another plugin's
  // entries) keeps every sibling key.
  if (patch.requestBody !== undefined) {
    Object.assign(target.request.body, patch.requestBody);
  }
  if (patch.permissions !== undefined) target.permissions = [...patch.permissions];
}

/**
 * Register every resolved role and sub-agent through `editor.update` — never
 * `add`, which v2's agent editor does not have.
 */
export function applyOpencode2Agents(
  editor: Opencode2AgentEditor,
  roles: readonly ResolvedRole[],
): void {
  for (const { id, patch } of collectOpencode2AgentRegistrations(roles)) {
    editor.update(id, (agent) => {
      applyOpencode2AgentPatch(agent, patch);
    });
  }
}

/**
 * Register the roles inside a v2 agent transform. The returned registration is
 * owned by the plugin scope and disposed with it (…/promise/registration.d.ts:1-3).
 */
export async function registerOpencode2Agents(
  domain: Opencode2AgentDomain,
  roles: readonly ResolvedRole[],
): Promise<{ dispose: () => Promise<void> }> {
  return domain.transform((editor) => {
    applyOpencode2Agents(editor, roles);
  });
}
