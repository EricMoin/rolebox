import { load } from "js-yaml";
import type {
  RegistryManifest,
  RegistryManifestRole,
  RoleboxConfig,
  LockFile,
  LockEntry,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Upper bound on the roles one registry manifest may declare. */
const MAX_MANIFEST_ROLES = 10_000;

export function parseRegistryManifest(data: unknown): RegistryManifest {
  if (!isRecord(data)) {
    throw new Error("Registry manifest must be a non-null object");
  }

  if (!isString(data.name)) {
    throw new Error("Registry manifest: 'name' must be a string");
  }

  if (!isString(data.description)) {
    throw new Error("Registry manifest: 'description' must be a string");
  }

  if (!isString(data.url)) {
    throw new Error("Registry manifest: 'url' must be a string");
  }

  if (!isRecord(data.roles)) {
    throw new Error("Registry manifest: 'roles' must be an object");
  }

  // The byte cap on the manifest body is the first bound on a hostile
  // manifest; this is the second, so a huge role table is refused before the
  // client copies it entry by entry.
  const roleIds = Object.keys(data.roles);
  if (roleIds.length > MAX_MANIFEST_ROLES) {
    throw new Error(
      `Registry manifest: 'roles' declares ${roleIds.length} roles, more than the ${MAX_MANIFEST_ROLES}-role limit; refusing to parse it`,
    );
  }

  // A null-prototype map: an own key like `__proto__` on a normal object
  // literal would replace the map's prototype instead of adding an entry, and
  // a lookup like `roles["toString"]` would find Object.prototype. Reserved
  // prototype keys are refused up front so the shape is explicit.
  const roles = Object.create(null) as Record<string, RegistryManifestRole>;

  for (const [roleId, roleEntry] of Object.entries(data.roles)) {
    if (roleId === "__proto__" || roleId === "constructor" || roleId === "prototype") {
      throw new Error(
        `Registry manifest: role id '${roleId}' is reserved; refusing to publish a role under a prototype key`,
      );
    }
    if (!isRecord(roleEntry)) {
      throw new Error(`Registry manifest: role '${roleId}' must be an object`);
    }

    if (!isString(roleEntry.version)) {
      throw new Error(`Registry manifest: role '${roleId}' must have a string 'version'`);
    }

    if (!isString(roleEntry.description)) {
      throw new Error(`Registry manifest: role '${roleId}' must have a string 'description'`);
    }

    if (!isStringArray(roleEntry.tags)) {
      throw new Error(`Registry manifest: role '${roleId}' must have an array of strings 'tags'`);
    }

    // Optional manifest-declared integrity digest (e.g. "sha256-<hex>"). When
    // present, install/update verify the computed digest against it; when
    // absent, the computed digest is surfaced and recorded without a check.
    const role: RegistryManifestRole = {
      version: roleEntry.version,
      description: roleEntry.description,
      tags: roleEntry.tags,
    };
    if (roleEntry.integrity !== undefined) {
      if (!isString(roleEntry.integrity)) {
        throw new Error(`Registry manifest: role '${roleId}' 'integrity' must be a string if present`);
      }
      role.integrity = roleEntry.integrity;
    }

    // Optional per-role archive location: `http` sources read the role from it
    // (absolute, else relative to the manifest URL) instead of the conventional
    // `roles/<roleId>@<version>.tar.gz` path.
    if (roleEntry.archive !== undefined) {
      if (!isString(roleEntry.archive)) {
        throw new Error(`Registry manifest: role '${roleId}' 'archive' must be a string if present`);
      }
      role.archive = roleEntry.archive;
    }

    roles[roleId] = role;
  }

  return { name: data.name, description: data.description, url: data.url, roles };
}

export function parseConfig(data: unknown): RoleboxConfig {
  if (!isRecord(data)) {
    throw new Error("Config must be a non-null object");
  }

  if (!Array.isArray(data.registries)) {
    throw new Error("Config: 'registries' must be an array");
  }

  const registries = data.registries.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new Error(`Config: registries[${index}] must be an object`);
    }

    if (!isString(entry.name)) {
      throw new Error(`Config: registries[${index}] must have a string 'name'`);
    }

    if (!isString(entry.url)) {
      throw new Error(`Config: registries[${index}] must have a string 'url'`);
    }

    const result: { name: string; url: string; ref?: string; default?: boolean } = {
      name: entry.name,
      url: entry.url,
    };

    // `kind` was an explicit override; the source kind is detected from `url`
    // now, so a leftover key is refused with the migration rather than ignored.
    if (entry.kind !== undefined) {
      throw new Error(
        `Config: registries[${index}].kind is no longer supported — the source kind is detected from 'url' (a GitLab project URL with '/-/', or a .yaml manifest URL)`,
      );
    }

    if (entry.ref !== undefined) {
      if (!isString(entry.ref)) {
        throw new Error(`Config: registries[${index}].ref must be a string`);
      }
      result.ref = entry.ref;
    }

    if (entry.default !== undefined) {
      if (!isBoolean(entry.default)) {
        throw new Error(`Config: registries[${index}].default must be a boolean`);
      }
      result.default = entry.default;
    }

    return result;
  });

  return { registries };
}

export function parseLockFile(data: unknown): LockFile {
  if (!isRecord(data)) {
    throw new Error("Lock file must be a non-null object");
  }

  if (data.version !== 1) {
    throw new Error("Lock file: 'version' must be 1");
  }

  if (!Array.isArray(data.roles)) {
    throw new Error("Lock file: 'roles' must be an array");
  }

  const roles: LockEntry[] = data.roles.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new Error(`Lock file: roles[${index}] must be an object`);
    }

    const requiredFields: Array<{ field: string; label: string }> = [
      { field: "role", label: "role" },
      { field: "registry", label: "registry" },
      { field: "version", label: "version" },
      { field: "installedAt", label: "installedAt" },
      { field: "integrity", label: "integrity" },
    ];

    for (const { field, label } of requiredFields) {
      if (!isString(entry[field])) {
        throw new Error(`Lock file: roles[${index}] must have a string '${label}'`);
      }
    }

    return {
      role: entry.role as string,
      registry: entry.registry as string,
      version: entry.version as string,
      installedAt: entry.installedAt as string,
      integrity: entry.integrity as string,
    };
  });

  return { version: 1, roles };
}

export function parseRegistryManifestFromYaml(yaml: string): RegistryManifest {
  const data = load(yaml);
  return parseRegistryManifest(data);
}

export function parseConfigFromYaml(yaml: string): RoleboxConfig {
  const data = load(yaml);
  return parseConfig(data);
}

export function parseLockFileFromYaml(yaml: string): LockFile {
  const data = load(yaml);
  return parseLockFile(data);
}
