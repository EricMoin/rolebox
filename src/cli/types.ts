export interface RegistryManifest {
  name: string;
  description: string;
  url: string;
  roles: Record<string, {
    version: string;
    description: string;
    tags: string[];
  }>;
}

export interface RegistryEntry {
  name: string;
  url: string;
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
