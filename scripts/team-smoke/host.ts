import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { parseDocument, visit } from "yaml";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session";

const adapterPackages = new Set([
  "@deepseek-ai/dsh-llm-deepseek-api-key",
  "@deepseek-ai/dsh-llm-pi-ai",
]);
const defaultModelPackage = "@deepseek-ai/dsh-agent-default-model";
const corePackages = [
  "cordis", "dsh-session-persistence-jsonl", "dsh-session", "dsh-session-projection",
  "dsh-session-query-sqlite", "dsh-agent", "dsh-agent-default-model", "dsh-llm", "dsh-system-prompt",
  "dsh-subagent", "dsh-skill", "dsh-fs-sandbox", "dsh-working-directory",
  "dsh-sandbox-local", "dsh-sandbox-policy", "dsh-subprocess-local",
  "dsh-bash-sandbox", "dsh-shell-env", "dsh-tool-bash",
  "dsh-tools", "dsh-agent-loop", "dsh-subagent-spawn-in-process", "dsh-tool-skill",
  "dsh-fs-observation-policy", "dsh-tool-fs", "dsh-credentials-local", "dsh-launch-environment",
] as const;

export interface SmokeHostOptions {
  root: string;
  /** Project directory; defaults to root/workspace when present, otherwise root. */
  workspace?: string;
  /** CLI executable, package.json, or package directory; defaults to dsh on PATH. */
  hostAnchor?: string;
  /** Ordered profile patch layers. Only model and supported adapter rows are consumed. */
  profileConfigPaths?: string[];
  dshHome?: string;
  profile?: string;
}

export interface SmokeHost {
  ctx: Context;
  dispose(): Promise<void>;
  /** These values are private runtime inputs and must not be included in reports. */
  agentOptions: AgentOptions & { provider: string; model: string };
  modelRoute: string;
  providerCount: number;
}

interface PluginRow {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
  tagged?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestOf(entry: string): string {
  let directory = statSync(entry).isDirectory() ? entry : dirname(entry);
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) return manifest;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("The DSH installation has no package manifest.");
    directory = parent;
  }
}

export function resolveSmokeHostAnchor(explicit?: string): string {
  if (explicit) return manifestOf(realpathSync(resolve(explicit)));
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return manifestOf(realpathSync(candidate));
    }
  }
  throw new Error("No DSH CLI was found; pass hostAnchor explicitly.");
}

function tagged(node: unknown): boolean {
  let found = false;
  visit(node as Parameters<typeof visit>[0], (_key, current) => {
    if (current && typeof current === "object" && "tag" in current && typeof current.tag === "string" && ![
      "tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:float",
      "tag:yaml.org,2002:bool", "tag:yaml.org,2002:null", "tag:yaml.org,2002:map", "tag:yaml.org,2002:seq",
    ].includes(current.tag)) found = true;
  });
  return found;
}

export function readSmokeModelConfig(paths: readonly string[]): {
  adapters: Array<{ name: string; config: Record<string, unknown> }>;
  agentOptions: SmokeHost["agentOptions"];
} {
  const rows = new Map<string, PluginRow>();
  for (const path of paths) {
    let document: ReturnType<typeof parseDocument>;
    try {
      document = parseDocument(readFileSync(path, "utf8"), { logLevel: "silent", uniqueKeys: true });
      if (document.errors.length) throw new Error();
    } catch { throw new Error("A smoke profile configuration could not be parsed."); }
    const walk = (value: unknown, trail: Array<string | number>): void => {
      if (Array.isArray(value)) { value.forEach((child, index) => walk(child, [...trail, index])); return; }
      if (!object(value)) return;
      if (typeof value.id === "string" || typeof value.name === "string") {
        const key = typeof value.id === "string" ? value.id : value.name as string;
        const previous = rows.get(key) ?? {};
        const row = { ...previous, ...value } as PluginRow;
        if ("config" in value) row.tagged = tagged(document.getIn([...trail, "config"], true));
        if ("disabled" in value && typeof value.disabled !== "boolean") row.disabled = true;
        rows.set(key, row);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "config") walk(child, [...trail, key]);
      }
    };
    try { walk(document.toJS(), []); }
    catch { throw new Error("A smoke profile configuration contains unsupported data."); }
  }
  const selected = [...rows.values()].filter(row => !row.disabled &&
    (row.name === defaultModelPackage || adapterPackages.has(row.name ?? "")));
  if (selected.some(row => row.tagged || (row.config !== undefined && !object(row.config)))) {
    throw new Error("Smoke model configuration must contain plain YAML values without executable tags.");
  }
  const model = selected.filter(row => row.name === defaultModelPackage).at(-1)?.config;
  if (!model || typeof model.provider !== "string" || !model.provider || typeof model.model !== "string" || !model.model) {
    throw new Error("The smoke profile needs an explicit default provider and model.");
  }
  if (model.reasoningEffort !== undefined && typeof model.reasoningEffort !== "string") {
    throw new Error("The smoke profile has an invalid reasoning selection.");
  }
  const adapters = selected.filter(row => adapterPackages.has(row.name ?? "") &&
    (row.name !== "@deepseek-ai/dsh-llm-pi-ai" ||
      (object(row.config?.providers) && Object.keys(row.config.providers).length > 0)))
    .map(row => ({ name: row.name!, config: row.config ?? {} }));
  if (!adapters.length) throw new Error("The smoke profile has no supported API-key or pi-ai adapter.");
  return {
    adapters,
    agentOptions: {
      provider: model.provider, model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as AgentOptions["reasoningEffort"] }),
    },
  };
}

export async function createSmokeHost(options: SmokeHostOptions): Promise<SmokeHost> {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = resolve(options.workspace ?? (existsSync(join(root, "workspace")) ? join(root, "workspace") : root));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  const anchor = resolveSmokeHostAnchor(options.hostAnchor);
  const hostRequire = createRequire(anchor);
  const modulePath = (name: string): string => hostRequire.resolve(name.startsWith("@") ? name : `@deepseek-ai/${name}`);
  let profileConfigPaths = options.profileConfigPaths;
  if (!profileConfigPaths) {
    const baseManifest = manifestOf(modulePath("dsh-base"));
    const profile = options.profile ?? "web";
    profileConfigPaths = [join(dirname(baseManifest), "cordis.patch.yml"), join(dshHome, "profiles", profile, "cordis.patch.yml"), join(dshHome, "cordis.patch.yml")]
      .filter(path => existsSync(path));
  }
  const config = readSmokeModelConfig(profileConfigPaths);
  const version = JSON.parse(readFileSync(manifestOf(modulePath("dsh-agent-loop")), "utf8")).version;
  const names = [...corePackages.map(name => `@deepseek-ai/${name}`), ...config.adapters.map(row => row.name)];
  for (const name of names) {
    if (name === "@deepseek-ai/cordis") continue;
    if (JSON.parse(readFileSync(manifestOf(modulePath(name)), "utf8")).version !== version) {
      throw new Error("The DSH smoke host resolves mixed package versions; choose one complete host installation.");
    }
  }
  const modules = new Map(await Promise.all(names.map(async name => [name, await import(pathToFileURL(modulePath(name)).href)] as const)));
  const ctx = new (modules.get("@deepseek-ai/cordis")!.Context)() as Context;
  const fibers: Array<{ await(): Promise<unknown>; dispose(): void | Promise<void> }> = [];
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const fiber of [...fibers].reverse()) {
      try { await fiber.dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error("One or more smoke host services did not dispose cleanly.");
  };
  const mount = (name: string, settings?: unknown): void => {
    const module = modules.get(name.startsWith("@") ? name : `@deepseek-ai/${name}`)!;
    fibers.push(ctx.plugin(module.default ?? module, settings as never));
  };
  const ready = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(fibers.map(fiber => fiber.await())), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DSH smoke host services did not become ready.")), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const environment = modules.get("@deepseek-ai/dsh-launch-environment")!;
    const layers: Array<{ source: string; path?: string; values: Record<string, string> }> = [
      { source: "process", values: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
    ];
    for (const [source, path] of [["user-env", join(dshHome, ".env")], ["project-env", join(workspace, ".env")]]) {
      if (existsSync(path!)) layers.push({ source: source!, path,
        values: Object.fromEntries(Object.entries(parseEnv(readFileSync(path!, "utf8")))
          .filter((entry): entry is [string, string] => entry[1] !== undefined)) });
    }
    ctx.provide(environment.DSH_LAUNCH_ENVIRONMENT_KEY, environment.createLaunchEnvironmentSnapshot(layers));
    mount("dsh-session-persistence-jsonl", { root: join(root, "sessions"), compression: "none" });
    for (const name of ["dsh-session", "dsh-session-projection", "dsh-agent", "dsh-llm", "dsh-system-prompt", "dsh-subagent", "dsh-skill"]) mount(name);
    mount("dsh-agent-default-model", config.agentOptions);
    mount("dsh-session-query-sqlite", { path: join(root, "session-query.sqlite"), openAt: "never" });
    mount("dsh-credentials-local", { dshHome, watch: false });
    mount("dsh-sandbox-local");
    mount("dsh-sandbox-policy", { mode: "workspace-write", workspaceRoot: workspace });
    mount("dsh-fs-sandbox", { cwd: workspace });
    mount("dsh-working-directory", { defaultDirectory: workspace });
    mount("dsh-subprocess-local");
    mount("dsh-bash-sandbox", { cwd: workspace });
    mount("dsh-shell-env", { dshHome });
    mount("dsh-tool-bash", { enableRunInBackground: false, promoteOnTimeout: false });
    mount("dsh-tools", { mode: "native" });
    mount("dsh-fs-observation-policy");
    mount("dsh-tool-fs");
    mount("dsh-agent-loop", { agents: [], maxParallelToolCalls: 1 });
    mount("dsh-subagent-spawn-in-process", { providerName: "spawn" });
    mount("dsh-tool-skill", {});
    await ready();
    for (const adapter of config.adapters) mount(adapter.name, adapter.config);
    await ready();
    const providers = ctx.llm.listProviders();
    if (!providers.some(provider => provider.id === config.agentOptions.provider)) {
      throw new Error("The default model route has no supported adapter in the smoke profile.");
    }
    return { ctx, dispose, agentOptions: config.agentOptions,
      modelRoute: `${config.agentOptions.provider}/${config.agentOptions.model}`, providerCount: providers.length };
  } catch {
    await dispose().catch(() => {});
    throw new Error("The DSH smoke host could not be initialized; verify its packages, profile, and credential store.");
  }
}
