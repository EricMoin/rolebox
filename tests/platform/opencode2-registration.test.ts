/// <reference types="bun-types" />

/**
 * opencode v2 registration surfaces — agents, skills and the loop-stop command.
 *
 * Every case drives the adapter's own structural host views
 * (src/platform/adapters/opencode2/{agents,skills,commands}.ts), whose
 * compile-time guards prove the REAL `Plugin.Context["agent" | "skill" | "command"]`
 * satisfies them — so the fakes below stand in for the 2.0.18 host shapes, not
 * for local inventions. The v2 declarations the fixtures reproduce are cited
 * inline.
 *
 * No case touches the filesystem (the skill body reader is injected), so the
 * working tree stays clean.
 */

import { describe, it, expect } from "bun:test";
import {
  applyOpencode2AgentPatch,
  applyOpencode2Agents,
  collectOpencode2AgentModels,
  collectOpencode2AgentRegistrations,
  mapPermissionRuleset,
  mapResolvedRoleToAgent,
  mapResolvedSubAgentToAgent,
  mapToolRuleset,
  registerOpencode2Agents,
} from "../../src/platform/adapters/opencode2/agents.ts";
import type {
  Opencode2AgentDomain,
  Opencode2AgentEditor,
  Opencode2HostMutableAgentInfo,
  Opencode2MutableAgentInfo,
  Opencode2PermissionRule,
} from "../../src/platform/adapters/opencode2/agents.ts";
import {
  MAX_OPENCODE2_SKILL_CONTENT_CHARS,
  collectOpencode2Skills,
  registerOpencode2Skills,
} from "../../src/platform/adapters/opencode2/skills.ts";
import type { Opencode2SkillDomain } from "../../src/platform/adapters/opencode2/skills.ts";
import {
  STOP_LOOP_COMMAND_DESCRIPTION,
  createStopLoopCommand,
  registerOpencode2Commands,
} from "../../src/platform/adapters/opencode2/commands.ts";
import type {
  Opencode2CommandDomain,
  Opencode2CommandPromptInput,
} from "../../src/platform/adapters/opencode2/commands.ts";
import { STOP_LOOP_COMMAND, STOP_LOOP_SIGNAL } from "../../src/loop/constants.ts";
import { SkillScope } from "../../src/constants.ts";
import type {
  PermissionConfig,
  ResolvedRole,
  ResolvedSkill,
  ResolvedSubAgent,
} from "../../src/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A resolved role with only the required shape filled in. */
function roleFixture(
  config: Partial<ResolvedRole["config"]> = {},
  resolved: Partial<ResolvedRole> = {},
): ResolvedRole {
  return {
    id: "emperor",
    config: {
      name: "Emperor",
      description: "The ruler",
      prompt: "You are the emperor.",
      ...config,
    },
    prompt: "You are the emperor.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...resolved,
  };
}

/** A resolved sub-agent (a `SubAgentConfig` + prompt + lineage). */
function subAgentFixture(
  id: string,
  config: Partial<ResolvedSubAgent["config"]> = {},
  subagents: ResolvedSubAgent[] = [],
): ResolvedSubAgent {
  return {
    id,
    config: {
      name: id,
      description: `${id} description`,
      prompt: `You are ${id}.`,
      ...config,
    },
    prompt: `You are ${id}.`,
    skills: [],
    functions: [],
    references: [],
    subagents,
    parentId: "emperor",
    inheritedFrom: {},
  };
}

/** A resolved role-local skill. */
function skillFixture(name: string, overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name,
    description: `${name} description`,
    scope: SkillScope.Rolebox,
    filePath: `/roles/emperor/skills/${name}/SKILL.md`,
    references: [],
    ...overrides,
  };
}

/**
 * The `Agent.Info` members a host entry starts with — the literal
 * `Agent.Info.default(id)` returns (…/schema/dist/agent.js, `Agent.Info.default`).
 * `overrides` seeds host state the way another plugin could have left it.
 */
function hostDefaultAgent(
  id: string,
  overrides: Record<string, unknown> = {},
): Opencode2HostMutableAgentInfo {
  // The host creates a missing entry from `Agent.Info.default(id)`
  // (…/schema/dist/agent.d.ts, `Info.default`) and hands the mutable object to
  // the plugin's updater. `DeepMutable` maps the branded string fields
  // (`Agent.ID`, `Agent.Name`, `Model.ID`) into object types, so a fixture
  // cannot be built by plain assignment; the runtime value is an ordinary
  // object, which is what this literal is.
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    // The five rules `Agent.Info.default(id)` seeds: a catch-all allow first,
    // then the specific asks (…/schema/dist/agent.js, `Info.default`).
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ],
    ...overrides,
  } as unknown as Opencode2HostMutableAgentInfo;
}

/**
 * A host entry read through the plain field view, with `request` widened to the
 * whole `Provider.Request` triple (…/schema/dist/provider.d.ts:61-65) so a
 * preserved `settings`/`headers` entry is assertable.
 */
type PlainAgentView = Opencode2MutableAgentInfo & {
  request: {
    settings: Record<string, unknown>;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
};

/**
 * Read a host entry through the plain field view. `DeepMutable` maps the
 * branded string fields (`Agent.Name`, `Model.ID`, …) into object types, and
 * bun's matchers take the received type as the expected type, so a mapped
 * field cannot be compared with a plain string directly.
 */
function view(agent: Opencode2HostMutableAgentInfo | undefined): PlainAgentView | undefined {
  return agent as unknown as PlainAgentView | undefined;
}

interface FakeAgentEditor {
  editor: Opencode2AgentEditor;
  /** Ids passed to `update`, in call order. */
  updated: string[];
  /** `add` does not exist on the real editor — recorded so a call can be proven absent. */
  added: unknown[];
  /** The mutable host entries after every updater ran. */
  agents: Map<string, Opencode2HostMutableAgentInfo>;
}

/**
 * An `AgentEditor` double: an upserting `update`, exactly like the host's
 * (`Editor.update` seeds a missing id from `Agent.Info.default(id)`), plus the
 * editor's other members so the "never add" contract is observable.
 */
function makeAgentEditor(seed: Opencode2HostMutableAgentInfo[] = []): FakeAgentEditor {
  // Keyed by `Agent.ID`, exactly as the host editor keys its state: `name` is
  // the display name (and rolebox overwrites it), so seeding by name would make
  // a seeded entry invisible to `update(id, …)`.
  const agents = new Map(seed.map((agent) => [agent.id as unknown as string, agent]));
  const updated: string[] = [];
  const added: unknown[] = [];
  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: (_id: string | undefined) => undefined,
    update: (id: string, update: (agent: Opencode2HostMutableAgentInfo) => void) => {
      updated.push(id);
      const agent = agents.get(id) ?? hostDefaultAgent(id);
      update(agent);
      agents.set(id, agent);
    },
    remove: (id: string) => {
      agents.delete(id);
    },
    add: (agent: unknown) => {
      added.push(agent);
    },
  } as Opencode2AgentEditor & { add(agent: unknown): void };
  return { editor, updated, added, agents };
}

/** A `Transform` double returning a host-shaped registration (…/promise/registration.d.ts:1-3). */
function makeTransformDomain<TEditor>(createEditor: () => TEditor): {
  domain: { transform(callback: (editor: TEditor) => void): Promise<{ dispose: () => Promise<void> }> };
  editors: TEditor[];
  disposed: number;
} {
  const editors: TEditor[] = [];
  let disposed = 0;
  const registration = { dispose: async () => { disposed += 1; } };
  return {
    domain: {
      transform: async (callback: (editor: TEditor) => void) => {
        const editor = createEditor();
        editors.push(editor);
        callback(editor);
        return registration;
      },
    },
    editors,
    get disposed() {
      return disposed;
    },
  };
}

// ── Pure role mapping ──────────────────────────────────────────────────────

describe("opencode2 agent mapping — ResolvedRole → Agent.Info patch", () => {
  it("maps a role with no model, sampling options or permissions (no extra field is written)", () => {
    const { id, patch } = mapResolvedRoleToAgent(roleFixture());

    expect(id).toBe("emperor");
    // Exact equality: no `model`, `requestBody`, `permissions` or `hidden` key
    // is written when rolebox resolved no value for it, so the host defaults
    // stay in place.
    expect(patch).toEqual({
      name: "Emperor",
      mode: "primary",
      system: "You are the emperor.",
      description: "The ruler",
    });
  });

  it("maps the resolved prompt, description, color and mode", () => {
    const role = roleFixture(
      { name: "Chancellor", description: "Keeper of the seal", color: "#ff0000", mode: "all" },
      { prompt: "You are the chancellor." },
    );

    const { patch } = mapResolvedRoleToAgent(role);

    expect(patch.name).toBe("Chancellor");
    expect(patch.system).toBe("You are the chancellor.");
    expect(patch.description).toBe("Keeper of the seal");
    expect(patch.color).toBe("#ff0000");
    expect(patch.mode).toBe("all");
  });

  it("splits a provider/model id into Model.Ref and carries the variant", () => {
    const { patch } = mapResolvedRoleToAgent(
      roleFixture({ model: "openrouter-anthropic/anthropic/claude-opus-4.8", variant: "fast" }),
    );

    // Split on the first slash: the multi-segment model id survives
    // (src/platform/model-ref.ts:32-40).
    expect(patch.model).toEqual({
      providerID: "openrouter-anthropic",
      id: "anthropic/claude-opus-4.8",
      variant: "fast",
    });
  });

  it("leaves the model unset for a bare, default or missing model", () => {
    for (const model of [undefined, "default", "bare-model", "/leading", "trailing/"]) {
      const { patch } = mapResolvedRoleToAgent(roleFixture({ model }));
      expect(patch.model).toBeUndefined();
      expect(patch.requestBody).toBeUndefined();
    }
  });

  it("puts temperature and top_p into the provider request body", () => {
    const { patch } = mapResolvedRoleToAgent(roleFixture({ temperature: 0.3, top_p: 0.9 }));

    expect(patch.requestBody).toEqual({ temperature: 0.3, top_p: 0.9 });
  });

  it("maps rolebox allow/deny permissions onto a v2 ruleset", () => {
    const { patch } = mapResolvedRoleToAgent(
      roleFixture({ permission: { allow: ["Read", "Grep"], deny: ["Bash"] } }),
    );

    // transformPermission lowercases the tool names (src/prompt/agent-config.ts:39-62).
    expect(patch.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
    ]);
  });

  it("maps the tools map onto explicit rules and appends them after the permissions", () => {
    const { patch } = mapResolvedRoleToAgent(
      roleFixture({ permission: { deny: ["webfetch"] }, tools: { bash: false, write: true } }),
    );

    expect(patch.permissions).toEqual([
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "allow" },
    ]);
  });

  it("skips a permission entry whose effect v2 cannot express", () => {
    // The hand-written per-tool form is passed through by transformPermission;
    // an effect outside allow|deny|ask must not reach the host ruleset.
    const permission = { read: "maybe" } as unknown as PermissionConfig;

    expect(mapPermissionRuleset(permission)).toEqual([]);
    expect(mapPermissionRuleset({ allow: ["read"], deny: ["bash"] })).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
    ] as Opencode2PermissionRule[]);
    expect(mapToolRuleset(undefined)).toEqual([]);
  });

  it("names a role by its id when the config name is empty", () => {
    const { patch } = mapResolvedRoleToAgent(roleFixture({ name: "" }));

    expect(patch.name).toBe("emperor");
  });
});

// ── Pure sub-agent mapping ─────────────────────────────────────────────────

describe("opencode2 agent mapping — ResolvedSubAgent → Agent.Info patch", () => {
  it("registers a sub-agent as hidden with mode subagent", () => {
    const { id, patch } = mapResolvedSubAgentToAgent(
      subAgentFixture("chancellor", { description: "Keeps the seal", color: "#00ff00" }),
    );

    expect(id).toBe("chancellor");
    expect(patch).toEqual({
      name: "chancellor",
      mode: "subagent",
      system: "You are chancellor.",
      description: "Keeps the seal",
      color: "#00ff00",
      hidden: true,
    });
  });

  it("carries the sub-agent's own model, sampling options and permissions", () => {
    const { patch } = mapResolvedSubAgentToAgent(
      subAgentFixture("scribe", {
        model: "provider-1/model-1",
        variant: "mini",
        temperature: 0.1,
        top_p: 0.2,
        permission: { deny: ["write"] },
        tools: { bash: false },
      }),
    );

    expect(patch.model).toEqual({ providerID: "provider-1", id: "model-1", variant: "mini" });
    expect(patch.requestBody).toEqual({ temperature: 0.1, top_p: 0.2 });
    expect(patch.permissions).toEqual([
      { action: "write", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
    ]);
  });

  it("collects roles, their sub-agents and nested sub-agents in order", () => {
    const nested = subAgentFixture("herald");
    const sub = subAgentFixture("chancellor", {}, [nested]);
    const role = roleFixture({}, { subagents: [sub] });

    expect(collectOpencode2AgentRegistrations([role]).map((r) => r.id)).toEqual([
      "emperor",
      "chancellor",
      "herald",
    ]);
  });
});

// ── Collected agent models ────────────────────────────────────────────────

/**
 * The map a v2 session is created from (src/platform/adapters/opencode2/session.ts
 * `create()`): a v2 session does not inherit its agent's model, so the entry
 * hands the adapter the model of every registered agent.
 */
describe("opencode2 agent models", () => {
  it("keys roles and recursively nested sub-agents by their agent ids", () => {
    const nested = subAgentFixture("herald", { model: "provider-2/model-2" });
    const sub = subAgentFixture("chancellor", { model: "provider-1/model-1", variant: "fast" }, [
      nested,
    ]);
    const role = roleFixture({ model: "provider-0/model-0" }, { subagents: [sub] });

    const models = collectOpencode2AgentModels([role]);

    // Same order and same ids the registrations carry.
    expect([...models.keys()]).toEqual(["emperor", "chancellor", "herald"]);
    expect(models.get("emperor")).toEqual({ providerID: "provider-0", id: "model-0" });
    // The role's own variant rides along.
    expect(models.get("chancellor")).toEqual({
      providerID: "provider-1",
      id: "model-1",
      variant: "fast",
    });
    expect(models.get("herald")).toEqual({ providerID: "provider-2", id: "model-2" });
  });

  it("agrees with the patch the same registrations produce", () => {
    const role = roleFixture({ model: "provider-1/model-1", variant: "mini" });

    const models = collectOpencode2AgentModels([role]);

    expect(models.get(role.id)).toEqual(mapResolvedRoleToAgent(role).patch.model);
  });

  it("omits a config with no resolvable model instead of storing an undefined value", () => {
    const withoutModel = subAgentFixture("chancellor");
    const unresolvable = roleFixture({ model: "default" }, { id: "regent" });
    const mapped = roleFixture({ model: "provider-1/model-1" }, { subagents: [withoutModel] });

    const models = collectOpencode2AgentModels([mapped, unresolvable]);

    expect([...models.keys()]).toEqual(["emperor"]);
    expect(models.get("emperor")).toEqual({ providerID: "provider-1", id: "model-1" });
    // ABSENT, not present-with-undefined: `has` is the contract a create() reads.
    expect(models.has("chancellor")).toBe(false);
    expect(models.has("regent")).toBe(false);
  });

  it("is empty for no roles at all", () => {
    expect(collectOpencode2AgentModels([]).size).toBe(0);
  });
});

// ── Registration against a fake host editor ────────────────────────────────

describe("opencode2 agent registration", () => {
  it("registers every role and sub-agent through update and never through add", () => {
    const role = roleFixture({}, { subagents: [subAgentFixture("chancellor")] });
    const host = makeAgentEditor();

    applyOpencode2Agents(host.editor, [role]);

    expect(host.updated).toEqual(["emperor", "chancellor"]);
    expect(host.added).toEqual([]);
    expect(view(host.agents.get("emperor"))?.name).toBe("Emperor");
    expect(view(host.agents.get("emperor"))?.system).toBe("You are the emperor.");
    expect(view(host.agents.get("chancellor"))?.hidden).toBe(true);
    expect(view(host.agents.get("chancellor"))?.mode).toBe("subagent");
  });

  it("upserts a missing id from the host default and preserves host defaults", () => {
    const host = makeAgentEditor();
    // Host state as another plugin (or the host itself) left it.
    const existing = hostDefaultAgent("emperor", {
      steps: 12,
      color: "#123456",
      model: { id: "host-model", providerID: "host-provider", variant: "host-variant" },
      request: { settings: { timeout: 5 }, headers: { "x-host": "1" }, body: { existing: true } },
    });
    host.agents.set("emperor", existing);

    applyOpencode2Agents(host.editor, [roleFixture({ temperature: 0.4, model: "provider-1/model-1" })]);

    const agent = view(host.agents.get("emperor"));
    expect(agent?.request.settings["timeout"]).toBe(5);
    expect(agent?.request.headers["x-host"]).toBe("1");
    // Merged, never replaced: the host's own body entry survives ours.
    expect(agent?.request.body).toEqual({ existing: true, temperature: 0.4 });
    // The host model keeps its variant when rolebox sets none.
    expect(agent?.model).toEqual({ providerID: "provider-1", id: "model-1", variant: "host-variant" });
    // Host-owned fields rolebox has no source for stay untouched: `steps` is
    // never mapped (role.yaml has no steps field) and `color` only when the
    // role declares one.
    expect(agent?.steps).toBe(12);
    expect(agent?.color).toBe("#123456");
    expect(agent?.hidden).toBe(false);
    // rolebox DOES own description, and the role's value wins.
    expect(agent?.description).toBe("The ruler");
  });

  it("targets the host entry by Agent.ID, not by its display name", () => {
    // Seeded through the editor's own store: the host keys agent state by
    // `Agent.ID`, while `name` is display only. An entry whose name differs from
    // its id must still be the one `update` mutates — registering a second entry
    // for the same role would be a host-state leak.
    const host = makeAgentEditor([hostDefaultAgent("emperor", { name: "Host Display Name" })]);

    applyOpencode2Agents(host.editor, [roleFixture()]);

    expect(host.updated).toEqual(["emperor"]);
    expect(host.agents.size).toBe(1);
    // rolebox owns the display name for the agents it registers.
    expect(view(host.agents.get("emperor"))?.name).toBe("Emperor");
  });

  it("leaves hidden alone for a role but sets it for a sub-agent", () => {
    const hiddenHost = makeAgentEditor([hostDefaultAgent("emperor", { hidden: true })]);

    applyOpencode2Agents(hiddenHost.editor, [roleFixture()]);

    expect(view(hiddenHost.agents.get("emperor"))?.hidden).toBe(true);
  });

  it("owns the permission ruleset only when rolebox resolved rules", () => {
    // rolebox resolved rules: the resolved ruleset is written (the `permissions`
    // field is rolebox's when it has something to say), everything else the role
    // does not name is left to the host.
    const host = makeAgentEditor();
    applyOpencode2Agents(host.editor, [roleFixture({ permission: { deny: ["bash"] } })]);

    expect(view(host.agents.get("emperor"))?.permissions).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
    ]);

    // No resolved rules: the host's own default ruleset is untouched — proven
    // against the real `Agent.Info.default(id)` rules, catch-all included.
    const untouched = makeAgentEditor();
    applyOpencode2Agents(untouched.editor, [roleFixture()]);

    expect(view(untouched.agents.get("emperor"))?.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]);
  });

  it("returns the registration the host transform handed back", async () => {
    const domain: { transform(callback: (editor: Opencode2AgentEditor) => void): Promise<{ dispose: () => Promise<void> }> } = {
      transform: async () => ({ dispose: async () => undefined }),
    };

    const registration = await registerOpencode2Agents(domain as Opencode2AgentDomain, [roleFixture()]);

    expect(typeof registration.dispose).toBe("function");
  });

  it("applies one patch in place rather than replacing the agent object", () => {
    const agent = hostDefaultAgent("emperor");
    const identity = agent;

    applyOpencode2AgentPatch(agent, {
      name: "Emperor",
      mode: "primary",
      system: "prompt",
      requestBody: { top_p: 0.5 },
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
      hidden: false,
    });

    expect(agent).toBe(identity);
    expect(view(agent)?.system).toBe("prompt");
    expect(view(agent)?.request.body).toEqual({ top_p: 0.5 });
    expect(view(agent)?.permissions).toEqual([{ action: "read", resource: "*", effect: "allow" }]);
  });
});

// ── Skills ─────────────────────────────────────────────────────────────────

describe("opencode2 skill registration", () => {
  it("registers role-local skills with the resolver's own ids and their bodies", async () => {
    const role = roleFixture({}, { skills: [skillFixture("alpha-skill"), skillFixture("beta-skill")] });

    const skills = await collectOpencode2Skills([role], {
      loadContent: async (skill) => `body of ${skill.name}`,
    });

    expect(skills).toEqual([
      {
        id: "alpha-skill",
        name: "alpha-skill",
        description: "alpha-skill description",
        path: "/roles/emperor/skills/alpha-skill/SKILL.md",
        content: "body of alpha-skill",
      },
      {
        id: "beta-skill",
        name: "beta-skill",
        description: "beta-skill description",
        path: "/roles/emperor/skills/beta-skill/SKILL.md",
        content: "body of beta-skill",
      },
    ]);
  });

  it("collects sub-agent skills recursively and skips harness-resolved global skills", async () => {
    const nested = subAgentFixture("herald", {}, []);
    nested.skills = [skillFixture("gamma-skill")];
    const sub = subAgentFixture("chancellor", {}, [nested]);
    sub.skills = [skillFixture("global-skill", { scope: SkillScope.Global, filePath: "/global/skills/global-skill/SKILL.md" })];
    const role = roleFixture({}, { subagents: [sub] });

    const skills = await collectOpencode2Skills([role], { loadContent: async () => "body" });

    expect(skills.map((skill) => skill.id)).toEqual(["gamma-skill"]);
  });

  it("deduplicates by id with the first loadable occurrence winning", async () => {
    const first = roleFixture({}, { skills: [skillFixture("alpha-skill", { description: "first" })] });
    const second = roleFixture({}, { id: "consul", skills: [skillFixture("alpha-skill", { description: "second" })] });

    const skills = await collectOpencode2Skills([first, second], {
      loadContent: async () => "body",
    });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("first");
    expect(skills[0]?.path).toBe("/roles/emperor/skills/alpha-skill/SKILL.md");
  });

  it("skips an unreadable body without throwing and without shadowing a later duplicate", async () => {
    const broken = roleFixture({}, { skills: [skillFixture("alpha-skill"), skillFixture("beta-skill")] });
    const good = roleFixture({}, {
      id: "consul",
      skills: [skillFixture("alpha-skill", { filePath: "/roles/consul/skills/alpha-skill/SKILL.md" })],
    });

    const skills = await collectOpencode2Skills([broken, good], {
      loadContent: async (skill) => {
        if (skill.filePath.startsWith("/roles/emperor")) throw new Error("ENOENT");
        return "body";
      },
    });

    expect(skills.map((skill) => skill.id)).toEqual(["alpha-skill"]);
    expect(skills[0]?.path).toBe("/roles/consul/skills/alpha-skill/SKILL.md");
  });

  it("bounds a skill body at the documented cap", async () => {
    const role = roleFixture({}, { skills: [skillFixture("big-skill")] });

    const skills = await collectOpencode2Skills([role], {
      loadContent: async () => "x".repeat(MAX_OPENCODE2_SKILL_CONTENT_CHARS + 10),
    });

    expect(skills[0]?.content).toHaveLength(MAX_OPENCODE2_SKILL_CONTENT_CHARS);
  });

  it("adds every collected skill to the host editor", async () => {
    const added: unknown[] = [];
    const registry = {
      transform: async (callback: (editor: { add(skill: unknown): void }) => void) => {
        callback({ add: (skill: unknown) => { added.push(skill); } });
        return { dispose: async () => undefined };
      },
    };
    const role = roleFixture({}, { skills: [skillFixture("alpha-skill")] });

    const registration = await registerOpencode2Skills(
      registry as unknown as Opencode2SkillDomain,
      [role],
      { loadContent: async () => "body" },
    );

    expect(added).toEqual([
      {
        id: "alpha-skill",
        name: "alpha-skill",
        description: "alpha-skill description",
        path: "/roles/emperor/skills/alpha-skill/SKILL.md",
        content: "body",
      },
    ]);
    expect(typeof registration.dispose).toBe("function");
  });

  it("registers nothing when a role has no role-local skills", async () => {
    expect(await collectOpencode2Skills([roleFixture()], { loadContent: async () => "body" })).toEqual([]);
  });
});

// ── Commands ───────────────────────────────────────────────────────────────

describe("opencode2 loop-stop command", () => {
  it("registers the v1 command name and description", () => {
    const command = createStopLoopCommand({ prompt: async () => undefined });

    expect(command.name).toBe(STOP_LOOP_COMMAND);
    expect(command.name).toBe("stop-loop");
    expect(command.description).toBe(STOP_LOOP_COMMAND_DESCRIPTION);
    expect(command.description).toBe("Stop the active loop");
  });

  it("delivers the stop signal into the invoking session with the invocation's delivery", async () => {
    const calls: Opencode2CommandPromptInput[] = [];
    const command = createStopLoopCommand({
      prompt: async (input) => {
        calls.push(input);
        return { id: "inbox_1" };
      },
    });

    await command.execute({
      sessionID: "ses_42",
      prompt: { text: "" },
      delivery: "queue",
    });

    expect(calls).toEqual([
      { sessionID: "ses_42", text: STOP_LOOP_SIGNAL, delivery: "queue" },
    ]);
    expect(calls[0]?.text).toBe("[rolebox:stop-loop]");
  });

  it("propagates a delivery failure instead of swallowing it", async () => {
    const command = createStopLoopCommand({
      prompt: async () => {
        throw new Error("inbox closed");
      },
    });

    await expect(
      command.execute({ sessionID: "ses_42", prompt: { text: "" }, delivery: "steer" }),
    ).rejects.toThrow("inbox closed");
  });

  it("adds exactly one definition through the host transform", async () => {
    const added: Array<{ name: string; description?: string }> = [];
    const domain = {
      transform: async (callback: (editor: { add(definition: never): void }) => void) => {
        callback({ add: (definition: never) => { added.push(definition); } });
        return { dispose: async () => undefined };
      },
    };

    const registration = await registerOpencode2Commands(
      domain as unknown as Opencode2CommandDomain,
      { prompt: async () => undefined },
    );

    expect(added.map((definition) => definition.name)).toEqual(["stop-loop"]);
    expect(added[0]?.description).toBe("Stop the active loop");
    expect(typeof registration.dispose).toBe("function");
  });
});

// ── Transform domains ──────────────────────────────────────────────────────

describe("opencode2 transform helpers", () => {
  it("hands the editor to the caller and returns the host registration", async () => {
    const fake = makeTransformDomain<Opencode2AgentEditor>(() => makeAgentEditor().editor);

    const registration = await registerOpencode2Agents(
      fake.domain as Opencode2AgentDomain,
      [roleFixture()],
    );

    expect(fake.editors).toHaveLength(1);
    await registration.dispose();
    expect(fake.disposed).toBe(1);
  });
});
