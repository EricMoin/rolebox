import { describe, it, expect } from "bun:test";
import {
  parseRegistryManifest,
  parseConfig,
  parseLockFile,
  parseRegistryManifestFromYaml,
  parseConfigFromYaml,
  parseLockFileFromYaml,
} from "../../src/cli/schemas";

// ── parseRegistryManifest ─────────────────────────────────────────

describe("parseRegistryManifest", () => {
  it("parses a valid registry manifest", () => {
    const input = {
      name: "community",
      description: "Community roles",
      url: "https://example.com/registry.yaml",
      roles: {
        "code-reviewer": {
          version: "1.0.0",
          description: "Reviews code",
          tags: ["review", "qa"],
        },
        "writer": {
          version: "2.1.0",
          description: "Writes docs",
          tags: ["documentation"],
        },
      },
    };

    const result = parseRegistryManifest(input);
    expect(result.name).toBe("community");
    expect(result.description).toBe("Community roles");
    expect(result.url).toBe("https://example.com/registry.yaml");
    expect(Object.keys(result.roles)).toEqual(["code-reviewer", "writer"]);
    expect(result.roles["code-reviewer"].version).toBe("1.0.0");
    expect(result.roles["code-reviewer"].tags).toEqual(["review", "qa"]);
    expect(result.roles["writer"].version).toBe("2.1.0");
    expect(result.roles["writer"].tags).toEqual(["documentation"]);
  });

  it("throws on non-object input", () => {
    expect(() => parseRegistryManifest("string")).toThrow("must be a non-null object");
    expect(() => parseRegistryManifest(null)).toThrow("must be a non-null object");
    expect(() => parseRegistryManifest(42)).toThrow("must be a non-null object");
    expect(() => parseRegistryManifest([])).toThrow("must be a non-null object");
  });

  it("throws when required string fields are missing", () => {
    expect(() => parseRegistryManifest({})).toThrow("'name' must be a string");
    expect(() => parseRegistryManifest({ name: "x" })).toThrow("'description' must be a string");
    expect(() => parseRegistryManifest({ name: "x", description: "y" })).toThrow("'url' must be a string");
    expect(() => parseRegistryManifest({ name: "x", description: "y", url: "z" })).toThrow("'roles' must be an object");
  });

  it("throws when a role entry is malformed", () => {
    const input = {
      name: "test",
      description: "test",
      url: "https://example.com",
      roles: {
        bad: "not an object",
      },
    };
    expect(() => parseRegistryManifest(input)).toThrow("role 'bad' must be an object");
  });

  it("throws when a role entry has missing fields", () => {
    const input = {
      name: "test",
      description: "test",
      url: "https://example.com",
      roles: {
        bad: { version: "1.0.0" },
      },
    };
    expect(() => parseRegistryManifest(input)).toThrow("role 'bad' must have a string 'description'");
  });
});

// ── parseConfig ───────────────────────────────────────────────────

describe("parseConfig", () => {
  it("parses a valid config with one registry", () => {
    const input = {
      registries: [
        { name: "default", url: "https://default.example.com" },
      ],
    };

    const result = parseConfig(input);
    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].name).toBe("default");
    expect(result.registries[0].url).toBe("https://default.example.com");
  });

  it("parses a config with multiple registries", () => {
    const input = {
      registries: [
        { name: "primary", url: "https://primary.example.com", default: true },
        { name: "secondary", url: "https://secondary.example.com" },
      ],
    };

    const result = parseConfig(input);
    expect(result.registries).toHaveLength(2);
    expect(result.registries[0].name).toBe("primary");
    expect(result.registries[0].default).toBe(true);
    expect(result.registries[1].default).toBeUndefined();
  });

  it("throws on non-object input", () => {
    expect(() => parseConfig(null)).toThrow("must be a non-null object");
    expect(() => parseConfig(undefined)).toThrow("must be a non-null object");
  });

  it("throws when registries is not an array", () => {
    expect(() => parseConfig({ registries: "not-array" })).toThrow("'registries' must be an array");
  });

  it("throws when a registry entry is invalid", () => {
    expect(() => parseConfig({ registries: [{}] })).toThrow("registries[0] must have a string 'name'");
    expect(() => parseConfig({ registries: [{ name: "x" }] })).toThrow("registries[0] must have a string 'url'");
  });

  it("throws when default field is not boolean", () => {
    expect(() =>
      parseConfig({ registries: [{ name: "x", url: "https://x", default: "yes" }] })
    ).toThrow("registries[0].default must be a boolean");
  });
});

// ── parseLockFile ─────────────────────────────────────────────────

describe("parseLockFile", () => {
  it("parses a valid lock file", () => {
    const input = {
      version: 1,
      roles: [
        {
          role: "code-reviewer",
          registry: "community",
          version: "1.0.0",
          installedAt: "2025-01-15T10:00:00Z",
          integrity: "sha256-abc123",
        },
      ],
    };

    const result = parseLockFile(input);
    expect(result.version).toBe(1);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe("code-reviewer");
    expect(result.roles[0].registry).toBe("community");
    expect(result.roles[0].version).toBe("1.0.0");
    expect(result.roles[0].installedAt).toBe("2025-01-15T10:00:00Z");
    expect(result.roles[0].integrity).toBe("sha256-abc123");
  });

  it("parses a lock file with multiple roles", () => {
    const input = {
      version: 1,
      roles: [
        {
          role: "alpha",
          registry: "hub",
          version: "0.1.0",
          installedAt: "2025-06-01T00:00:00Z",
          integrity: "sha256-x",
        },
        {
          role: "beta",
          registry: "hub",
          version: "0.2.0",
          installedAt: "2025-06-02T00:00:00Z",
          integrity: "sha256-y",
        },
      ],
    };

    const result = parseLockFile(input);
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].role).toBe("alpha");
    expect(result.roles[1].role).toBe("beta");
  });

  it("throws on non-object input", () => {
    expect(() => parseLockFile("x")).toThrow("must be a non-null object");
  });

  it("throws when version is not 1", () => {
    expect(() => parseLockFile({ version: 2, roles: [] })).toThrow("'version' must be 1");
    expect(() => parseLockFile({ roles: [] })).toThrow("'version' must be 1");
  });

  it("throws when roles is not an array", () => {
    expect(() => parseLockFile({ version: 1, roles: "x" })).toThrow("'roles' must be an array");
  });

  it("throws when a lock entry has missing fields", () => {
    const input = {
      version: 1,
      roles: [{}],
    };
    expect(() => parseLockFile(input)).toThrow("roles[0] must have a string 'role'");
  });

  it("throws when a lock entry field has wrong type", () => {
    const input = {
      version: 1,
      roles: [
        {
          role: "test",
          registry: "hub",
          version: "1.0.0",
          installedAt: "now",
          integrity: 123, // should be string
        },
      ],
    };
    expect(() => parseLockFile(input)).toThrow("roles[0] must have a string 'integrity'");
  });
});

// ── YAML convenience wrappers ─────────────────────────────────────

describe("YAML convenience wrappers", () => {
  it("parseRegistryManifestFromYaml parses valid YAML", () => {
    const yaml = `
name: test
description: Test registry
url: https://example.com
roles:
  my-role:
    version: "1.0.0"
    description: A test role
    tags:
      - test
`;
    const result = parseRegistryManifestFromYaml(yaml);
    expect(result.name).toBe("test");
    expect(result.roles["my-role"].version).toBe("1.0.0");
  });

  it("parseConfigFromYaml parses valid YAML", () => {
    const yaml = `
registries:
  - name: hub
    url: https://hub.example.com
    default: true
`;
    const result = parseConfigFromYaml(yaml);
    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].name).toBe("hub");
    expect(result.registries[0].default).toBe(true);
  });

  it("parseLockFileFromYaml parses valid YAML", () => {
    const yaml = `
version: 1
roles:
  - role: my-role
    registry: hub
    version: "1.0.0"
    installedAt: "2025-01-01T00:00:00Z"
    integrity: sha256-abc
`;
    const result = parseLockFileFromYaml(yaml);
    expect(result.version).toBe(1);
    expect(result.roles).toHaveLength(1);
  });

  it("propagates parse errors from YAML input", () => {
    const yaml = `name: 123`; // name should be a string but YAML still loads
    expect(() => parseRegistryManifestFromYaml(yaml)).toThrow();
  });
});
