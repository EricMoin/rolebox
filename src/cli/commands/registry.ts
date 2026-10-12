import { defineCommand } from "citty";
import { loadConfig, saveConfig, loadLock } from "../config.ts";
import { fetchRegistryManifest, redactUrlForDisplay, escapeForDisplay } from "../registry-client.ts";
import { assertSafePathSegment } from "../paths.ts";
import { effectiveRegistries, isBuiltinName } from "../sources.ts";
import { defaultRegistryName, parseRegistryUrl } from "../source-url.ts";
import type { SourceKind } from "../source-url.ts";
import type { RegistryEntry, RegistryManifest } from "../types.ts";

const NAME_COLUMN = 18;

/** `git@host:path` — the scp-like form, which `new URL` cannot parse. */
const SCP_SOURCE_RE = /^git@[^/:\s]+:.+$/;

/** `scheme://` — a URL scheme, including one `new URL` itself cannot finish parsing (`https://`). */
const SCHEME_URL_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\//;

/**
 * Whether the value is shaped like a source URL at all — ANY scheme, not just
 * http(s), plus the scp-like `git@host:path` form. This is a well-formedness
 * predicate, not the detector's verdict, so the detector describes every value
 * that at least looks like a URL: `new URL` parses `ssh://`, `ftp://`,
 * `file://` and `mailto:` (and the detector rejects them by scheme), while
 * `https://` carries a scheme yet fails to parse and must reach the detector
 * too. Only input that is not a source URL in any recognizable form
 * (`not-a-url`, `registry.yaml`, an empty value) keeps the historical
 * `Invalid GitHub URL` message, which is otherwise false about both the host
 * and the problem.
 */
function isSourceUrlShape(url: string): boolean {
  if (typeof url !== "string") return false;
  const raw = url.trim();
  if (SCP_SOURCE_RE.test(raw)) return true;
  if (SCHEME_URL_RE.test(raw)) return true;
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

export function registryListFn(json = false): void {
  const config = loadConfig();
  const registries = effectiveRegistries(config);

  if (json) {
    console.log(JSON.stringify(registries, null, 2));
    return;
  }

  if (registries.length === 0) {
    console.log("No role sources configured. Add one with 'rolebox registry add <url>'.");
    return;
  }

  console.log("Registries:");
  for (const reg of registries) {
    // GitHub is the default kind, so only a non-github source is marked — the
    // GitHub line stays byte-identical to before.
    const kind = sourceKindOf(reg);
    const markers = [
      kind && kind !== "github" ? ` (${kind})` : "",
      reg.ref ? ` (ref: ${reg.ref})` : "",
      reg.default ? " (default)" : "",
      reg.builtin ? " (built-in)" : "",
    ].join("");
    console.log(`  ${reg.name.padEnd(NAME_COLUMN)} ${reg.url}${markers}`);
  }
}

/** The effective kind of a configured source, or `undefined` when its URL is unreadable. */
function sourceKindOf(reg: RegistryEntry): SourceKind | undefined {
  try {
    return parseRegistryUrl(reg.url).kind;
  } catch {
    return undefined;
  }
}

export interface RegistryAddOptions {
  /** Source name; defaults to the repository basename. */
  name?: string;
  /** Git branch or tag the manifest and tarball are read from. */
  ref?: string;
  /** Make the new source the default one for unprefixed role specs. */
  makeDefault?: boolean;
}

export async function registryAddFn(url: string, opts: RegistryAddOptions = {}): Promise<void> {
  // The URL alone decides the source kind. Anything shaped like a source URL —
  // any scheme, including one the URL parser cannot finish (`https://`), or the
  // scp-like form — keeps the detector's own, actionable error (`unsupported
  // scheme "ssh"`, a hostname that is not a hostname, `expected an absolute
  // http(s) URL`). Only input that is not a source URL in any recognizable form
  // (for example `not-a-url`, `registry.yaml`, empty) keeps the historical
  // message, which would otherwise be false about both the host and the problem.
  let nameFromUrl: string;
  try {
    nameFromUrl = defaultRegistryName(url);
  } catch (err) {
    if (!isSourceUrlShape(url)) {
      throw new Error("Invalid GitHub URL. Expected: https://github.com/owner/repo");
    }
    throw err;
  }

  const providedName = opts.name?.trim();
  // A blank --name is rejected instead of silently falling back to the repo
  // basename; the validator owns the message.
  if (providedName === "") assertSafePathSegment(providedName, "registry name");
  const name = providedName || nameFromUrl;
  assertSafePathSegment(name, "registry name");

  const ref = opts.ref?.trim() || undefined;

  const config = loadConfig();
  if (effectiveRegistries(config).some((r) => r.name === name)) {
    throw new Error(`Registry '${name}' is already configured`);
  }

  const entry: RegistryEntry = { name, url };
  if (ref) entry.ref = ref;

  // Validated with exactly one fetch: the manifest proves the repo publishes a
  // registry.yaml at this ref before anything is written to the config.
  let manifest: RegistryManifest;
  try {
    manifest = await fetchRegistryManifest(entry, ref, { noCache: true });
  } catch (err) {
    throw new Error(
      `Could not validate registry at ${redactUrlForDisplay(url)}: ${(err as Error).message}`,
    );
  }

  if (manifest.name !== name) {
    console.warn(
      `Warning: the registry at ${redactUrlForDisplay(url)} declares the name '${escapeForDisplay(manifest.name)}', not '${escapeForDisplay(name)}'; keeping '${escapeForDisplay(name)}'. Pass --name to choose a different one.`,
    );
  }
  if (effectiveRegistries(config).some((r) => r.url === url)) {
    console.warn(
      `Warning: another source already uses ${url}; adding '${name}' anyway (pin a branch with --ref to tell them apart).`,
    );
  }

  if (opts.makeDefault) {
    for (const existing of config.registries) delete existing.default;
    entry.default = true;
  }
  config.registries.push(entry);
  saveConfig(config);
  console.log(
    `✓ Added registry '${name}' (${redactUrlForDisplay(url)})${opts.makeDefault ? " as the default source" : ""}`,
  );
}

export function registryRemoveFn(name: string): void {
  // The built-in source stays available even when it is not written in the
  // file, so removing it is refused before the not-found lookup.
  if (isBuiltinName(name)) {
    throw new Error(
      `Cannot remove default registry '${name}' — it is the built-in role source and stays available; add your own with 'rolebox registry add <url>'`,
    );
  }

  const config = loadConfig();
  const index = config.registries.findIndex((r) => r.name === name);

  if (index === -1) {
    throw new Error(`Registry '${name}' not found`);
  }

  config.registries.splice(index, 1);
  saveConfig(config);
  console.log(`✓ Removed registry '${name}'`);

  const lock = loadLock();
  const affected = lock.roles.filter((r) => r.registry === name);
  if (affected.length > 0) {
    console.warn(
      `Warning: ${affected.length} role(s) from '${name}' are still installed. Use 'rolebox uninstall ${name}:<role>' to remove them.`,
    );
  }
}

export function registryDefaultFn(name: string): void {
  const config = loadConfig();
  if (!effectiveRegistries(config).some((r) => r.name === name)) {
    throw new Error(`Registry '${name}' not found`);
  }

  const entry = config.registries.find((r) => r.name === name);
  for (const existing of config.registries) delete existing.default;
  // The built-in is not necessarily in the file: clearing every file-level
  // default is what makes it the effective default again.
  if (entry) entry.default = true;

  saveConfig(config);
  console.log(`✓ '${name}' is now the default source`);
}

const registryList = defineCommand({
  meta: { name: "list", description: "Show all configured role sources" },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) { registryListFn(args.json ?? false); },
});

const registryAdd = defineCommand({
  meta: { name: "add", description: "Add a role source" },
  args: {
    url: { type: "positional", description: "GitHub/GitLab project URL or registry.yaml URL", required: true },
    name: { type: "string", description: "Source name (defaults to the repository name)" },
    ref: { type: "string", description: "Git branch or tag to read the registry from" },
    default: { type: "boolean", description: "Make this the default source" },
  },
  async run({ args }) {
    await registryAddFn(args.url, {
      name: args.name,
      ref: args.ref,
      makeDefault: args.default,
    });
  },
});

const registryRemove = defineCommand({
  meta: { name: "remove", description: "Remove a role source" },
  args: {
    name: { type: "positional", description: "Source name to remove", required: true },
  },
  run({ args }) { registryRemoveFn(args.name); },
});

const registryDefault = defineCommand({
  meta: { name: "default", description: "Set the default role source" },
  args: {
    name: { type: "positional", description: "Source name to make the default", required: true },
  },
  run({ args }) { registryDefaultFn(args.name); },
});

export default defineCommand({
  meta: {
    name: "registry",
    description: "Manage role sources (list, add, remove, default)",
  },
  subCommands: {
    list: registryList,
    add: registryAdd,
    remove: registryRemove,
    default: registryDefault,
  },
  default: "list",
});
