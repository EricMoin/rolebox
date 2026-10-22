import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA, load } from "js-yaml";
import { z } from "zod";
import type { BenchmarkCase, BenchmarkSuite, LoadedBenchmarkSuite } from "./types.ts";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const nonempty = z.string().trim().min(1).max(4_096);
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const suiteSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  target: z.object({
    host: z.literal("dsh"),
    role: nonempty,
    provider: nonempty,
    model: nonempty,
  }).strict(),
  host: z.object({
    moduleRoot: nonempty.optional(),
    plugins: z.array(z.object({
      module: nonempty,
      config: z.record(z.string(), z.unknown()).default({}),
    }).strict()).max(64).default([]),
    env: z.array(environmentName).max(64).default([]),
  }).strict().default({ plugins: [], env: [] }),
  dataset: nonempty.default("cases.jsonl"),
  run: z.object({
    repetitions: z.number().int().min(1).max(20).default(1),
    concurrency: z.number().int().min(1).max(8).default(1),
    timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
  }).strict().default({ repetitions: 1, concurrency: 1, timeoutMs: 120_000 }),
}).strict();

const caseSchema = z.object({
  id: identifier,
  prompt: z.string().min(1).max(131_072).refine((value) => value.trim().length > 0),
  assertions: z.array(z.object({
    kind: z.enum(["equals", "contains"]),
    value: z.string().max(16_384),
  }).strict()).min(1).max(64),
}).strict();

const reservedEnvironment = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PATH|PWD|OLDPWD|TMPDIR|TMP|TEMP|NODE_.*|BUN_.*|XDG_.*|DSH_.*|ROLEBOX_.*|LD_.*|DYLD_.*)$/i;
const secretField = /(?:apikey|token$|password|passwd|secret|privatekey|authorization|credential|accesskey|cookie$|^key$)/i;

export class BenchmarkSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkSpecError";
  }
}

function fail(message: string): never {
  throw new BenchmarkSpecError(message);
}

async function readBounded(path: string, limit: number, label: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) fail(`${label} must be a file no larger than ${limit} bytes`);
    const bytes = await readFile(path);
    if (bytes.length > limit) fail(`${label} exceeds ${limit} bytes`);
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof BenchmarkSpecError) throw error;
    fail(`${label} could not be read`);
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    // Zod's rendered error can include submitted values; report only field locations.
    const locations = result.error.issues.map((issue) => issue.path.join(".") || "root");
    fail(`${label} has invalid or unsupported fields: ${[...new Set(locations)].join(", ")}`);
  }
  return result.data;
}

function isSecretField(key: string): boolean {
  return secretField.test(key.replace(/[-_\s]/g, ""));
}

function validateConfig(value: unknown, allowed: ReadonlySet<string>, label: string, depth = 0, ancestors = new Set<object>(), budget = { nodes: 0 }): void {
  if (++budget.nodes > 10_000) fail(`${label} exceeds the configuration node limit`);
  if (depth > 24) fail(`${label} exceeds the configuration nesting limit`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain finite numbers`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 65_536) fail(`${label} exceeds the configuration string limit`);
    if (/^https?:\/\//i.test(value)) {
      let url: URL;
      try { url = new URL(value); } catch { fail(`${label} contains an invalid URL`); }
      if (url.username || url.password || [...url.searchParams.keys()].some(isSecretField)) {
        fail(`${label} must use an environment reference for credential-bearing URLs`);
      }
    }
    return;
  }
  if (typeof value !== "object") fail(`${label} must contain JSON-compatible values`);
  if (ancestors.has(value)) fail(`${label} must not contain cyclic aliases`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1_024) fail(`${label} exceeds the configuration array limit`);
      value.forEach((item, index) => validateConfig(item, allowed, `${label}[${index}]`, depth + 1, ancestors, budget));
      return;
    }
    const fields = Object.entries(value);
    if (fields.length > 1_024) fail(`${label} exceeds the configuration field limit`);
    if (Object.hasOwn(value, "$env")) {
      const env = (value as Record<string, unknown>).$env;
      if (fields.length !== 1 || typeof env !== "string" || !allowed.has(env)) {
        fail(`${label} must reference one environment variable declared in host.env`);
      }
      return;
    }
    for (const [key, child] of fields) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail(`${label} contains a reserved field`);
      if (isSecretField(key) && !(typeof child === "object" && child !== null && Object.hasOwn(child, "$env"))) {
        fail(`${label} credential fields must use { $env: NAME } references`);
      }
      validateConfig(child, allowed, `${label}.${key}`, depth + 1, ancestors, budget);
    }
  } finally {
    ancestors.delete(value);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localModule(specifier: string): boolean {
  return isAbsolute(specifier) || specifier.startsWith(".") || specifier.startsWith("file:");
}

export async function loadBenchmarkSuite(path: string): Promise<LoadedBenchmarkSuite> {
  const inputPath = resolve(path);
  let suitePath: string;
  try { suitePath = (await stat(inputPath)).isDirectory() ? join(inputPath, "suite.yaml") : inputPath; }
  catch { fail("Benchmark suite does not exist"); }
  const directory = dirname(suitePath);
  const source = await readBounded(suitePath, 262_144, "Suite configuration");
  let raw: unknown;
  try { raw = load(source, { schema: JSON_SCHEMA }); }
  catch { fail("Suite configuration is not valid YAML"); }
  const suite: BenchmarkSuite = parse(suiteSchema, raw, "Suite configuration");
  if (new Set(suite.host.env).size !== suite.host.env.length) fail("host.env must not contain duplicate names");
  if (suite.host.env.some((name) => reservedEnvironment.test(name))) fail("host.env must not override execution isolation variables");
  const allowed = new Set(suite.host.env);
  for (const [index, plugin] of suite.host.plugins.entries()) {
    validateConfig(plugin.config, allowed, `host.plugins[${index}].config`);
  }

  const roleDirectory = resolve(directory, suite.target.role);
  await readBounded(join(roleDirectory, "role.yaml"), 1_048_576, "Target role.yaml");
  const dataset = await readBounded(resolve(directory, suite.dataset), 16_777_216, "Case dataset");
  const cases: BenchmarkCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of dataset.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (line.length > 262_144) fail(`Case line ${index + 1} exceeds the line length limit`);
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { fail(`Case line ${index + 1} is not valid JSON`); }
    const item = parse(caseSchema, value, `Case line ${index + 1}`);
    if (ids.has(item.id)) fail(`Case line ${index + 1} has a duplicate ID`);
    for (const assertion of item.assertions) {
      if (assertion.kind === "contains" && !assertion.value.length) fail(`Case line ${index + 1} has an empty contains assertion`);
    }
    ids.add(item.id);
    cases.push(item);
    if (cases.length > 1_000) fail("Case dataset exceeds the 1000-case limit");
  }
  if (!cases.length) fail("Case dataset must contain at least one case");

  let moduleRootDigest: string | null = null;
  if (suite.host.moduleRoot) {
    suite.host.moduleRoot = resolve(directory, suite.host.moduleRoot);
    try { if (!(await stat(suite.host.moduleRoot)).isDirectory()) fail("host.moduleRoot must be a directory"); }
    catch { fail("host.moduleRoot must be an existing directory"); }
    try { moduleRootDigest = digest(await readBounded(join(suite.host.moduleRoot, "package.json"), 1_048_576, "Host package manifest")); }
    catch { moduleRootDigest = "explicit-module-root"; }
  }
  const plugins = [];
  for (const plugin of suite.host.plugins) {
    if (localModule(plugin.module)) {
      let modulePath: string;
      try { modulePath = plugin.module.startsWith("file:") ? fileURLToPath(plugin.module) : resolve(directory, plugin.module); }
      catch { fail("Local plugin has an invalid file URL"); }
      const content = await readBounded(modulePath, 16_777_216, "Local host plugin");
      plugin.module = modulePath;
      plugin.sourceDigest = digest(content);
      plugins.push({ module: `local:${plugin.sourceDigest}`, config: plugin.config });
    } else {
      if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(plugin.module)) {
        fail("Host plugins must name packages or local files");
      }
      plugins.push(plugin);
    }
  }
  const suiteDigest = digest(canonical({
    schemaVersion: suite.schemaVersion,
    id: suite.id,
    target: { host: suite.target.host, provider: suite.target.provider, model: suite.target.model },
    host: { moduleRootDigest, plugins, env: [...suite.host.env].sort() },
    cases,
    run: suite.run,
  }));
  return { suite, directory, roleDirectory, cases, digest: suiteDigest };
}
