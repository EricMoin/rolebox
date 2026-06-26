import { load } from "js-yaml";
import type { RegistryManifest, RoleboxConfig, LockFile, LockEntry } from "./types.ts";

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

  const roles: Record<string, { version: string; description: string; tags: string[] }> = {};

  for (const [roleId, roleEntry] of Object.entries(data.roles)) {
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

    roles[roleId] = {
      version: roleEntry.version,
      description: roleEntry.description,
      tags: roleEntry.tags,
    };
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

    const result: { name: string; url: string; default?: boolean } = {
      name: entry.name,
      url: entry.url,
    };

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
