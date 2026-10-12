/** One role published by a registry manifest. */
export interface RegistryManifestRole {
  version: string;
  description: string;
  tags: string[];
  /** Optional digest (e.g. "sha256-<hex>") the installed tree is verified against. */
  integrity?: string;
  /**
   * Optional archive location for this role. Absolute http(s) URLs are used
   * as-is; a relative path resolves against the manifest URL. Honored by
   * `http` sources, which have no hosting API to fall back on.
   */
  archive?: string;
}

export interface RegistryManifest {
  name: string;
  description: string;
  url: string;
  roles: Record<string, RegistryManifestRole>;
}

export interface RegistryEntry {
  name: string;
  url: string;
  /** Git branch or tag the manifest and tarball are read from. Defaults to DEFAULT_GIT_BRANCH. */
  ref?: string;
  default?: boolean;
}

export interface RoleboxConfig {
  registries: RegistryEntry[];
}

export interface LockEntry {
  role: string;
  registry: string;
  version: string;
  installedAt: string;
  integrity: string;
}

export interface LockFile {
  version: number;
  roles: LockEntry[];
}
