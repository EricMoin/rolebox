export interface RegistryManifest {
  name: string;
  description: string;
  url: string;
  roles: Record<string, {
    version: string;
    description: string;
    tags: string[];
    integrity?: string;
  }>;
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
