// NOTE: Uses XDG_DATA_HOME env var to control paths instead of mock.module
// to avoid Bun v1.3.14's mock.module cross-file persistence issue.
import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setMockDataDir(dir: string) {
  process.env.XDG_DATA_HOME = dir;
}

import {
  parseGitHubUrl,
  resolveVersion,
  fetchRegistryManifest,
  downloadRole,
  computeIntegrity,
} from "../../src/cli/registry-client";

import type { RegistryManifest } from "../../src/cli/types";

const sampleManifest: RegistryManifest = {
  name: "community",
  description: "Community roles",
  url: "https://github.com/example/registry",
  roles: {
    "code-reviewer": {
      version: "1.0.0",
      description: "Reviews code",
      tags: ["review", "qa"],
    },
    writer: {
      version: "2.1.0",
      description: "Writes docs",
      tags: ["documentation"],
    },
  },
};

const validYaml = `
name: community
description: Community roles
url: https://github.com/example/registry
roles:
  code-reviewer:
    version: "1.0.0"
    description: Reviews code
    tags:
      - review
      - qa
`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

// ── parseGitHubUrl ─────────────────────────────────────────────────

describe("parseGitHubUrl", () => {
  it("parses https://github.com/owner/repo", () => {
    const result = parseGitHubUrl("https://github.com/myorg/myrepo");
    expect(result.owner).toBe("myorg");
    expect(result.repo).toBe("myrepo");
  });

  it("parses https://github.com/owner/repo.git", () => {
    const result = parseGitHubUrl("https://github.com/myorg/myrepo.git");
    expect(result.owner).toBe("myorg");
    expect(result.repo).toBe("myrepo");
  });

  it("parses git@github.com:owner/repo.git", () => {
    const result = parseGitHubUrl("git@github.com:myorg/myrepo.git");
    expect(result.owner).toBe("myorg");
    expect(result.repo).toBe("myrepo");
  });

  it("parses git@github.com:owner/repo (without .git)", () => {
    const result = parseGitHubUrl("git@github.com:myorg/myrepo");
    expect(result.owner).toBe("myorg");
    expect(result.repo).toBe("myrepo");
  });

  it("parses URL with repo containing dots and hyphens", () => {
    const result = parseGitHubUrl("https://github.com/my-org/my.repo-name");
    expect(result.owner).toBe("my-org");
    expect(result.repo).toBe("my.repo-name");
  });

  it("parses SSH URL with dots in repo name", () => {
    const result = parseGitHubUrl("git@github.com:myorg/my.repo.app.git");
    expect(result.owner).toBe("myorg");
    expect(result.repo).toBe("my.repo.app");
  });

  it("throws on non-GitHub URL", () => {
    expect(() => parseGitHubUrl("https://gitlab.com/owner/repo")).toThrow("invalid GitHub URL");
  });

  it("throws on malformed URL", () => {
    expect(() => parseGitHubUrl("not-a-url")).toThrow("invalid GitHub URL");
  });

  it("throws on empty string", () => {
    expect(() => parseGitHubUrl("")).toThrow("invalid GitHub URL");
  });
});

// ── resolveVersion ─────────────────────────────────────────────────

describe("resolveVersion", () => {
  it("returns version for a known role", () => {
    const version = resolveVersion(sampleManifest, "code-reviewer");
    expect(version).toBe("1.0.0");
  });

  it("returns version for another known role", () => {
    const version = resolveVersion(sampleManifest, "writer");
    expect(version).toBe("2.1.0");
  });

  it("throws for an unknown role", () => {
    expect(() => resolveVersion(sampleManifest, "nonexistent")).toThrow(
      'role "nonexistent" not found in registry "community"'
    );
  });
});

// ── fetchRegistryManifest ─────────────────────────────────────────

describe("fetchRegistryManifest", () => {
  it("fetches and parses a valid registry manifest", async () => {
    const mockResponse = new Response(validYaml, { status: 200 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    const result = await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" },
      "main",
      { noCache: true }
    );

    expect(result.name).toBe("community");
    expect(result.roles["code-reviewer"].version).toBe("1.0.0");
    expect(result.roles["code-reviewer"].tags).toEqual(["review", "qa"]);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws 404 error with 'not found' message", async () => {
    const mockResponse = new Response("Not Found", { status: 404 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await expect(
      fetchRegistryManifest(
        { name: "community", url: "https://github.com/example/registry" }
      )
    ).rejects.toThrow("not found");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws rate limit error for 403", async () => {
    const mockResponse = new Response("Rate limited", { status: 403 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await expect(
      fetchRegistryManifest(
        { name: "community", url: "https://github.com/example/registry" }
      )
    ).rejects.toThrow("GITHUB_TOKEN");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws network error on connection failure", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("network connection refused");
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await expect(
      fetchRegistryManifest(
        { name: "community", url: "https://github.com/example/registry" }
      )
    ).rejects.toThrow(/network error/i);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws parse error for invalid YAML", async () => {
    const mockResponse = new Response(": invalid: yaml: [[[]", { status: 200 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await expect(
      fetchRegistryManifest(
        { name: "community", url: "https://github.com/example/registry" }
      )
    ).rejects.toThrow("invalid registry.yaml");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches manifest and uses cache within TTL", async () => {
    const callCount = { value: 0 };
    const mockResponse = new Response(validYaml, { status: 200 });
    globalThis.fetch = mock(() => {
      callCount.value++;
      return Promise.resolve(mockResponse);
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    const result1 = await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" }
    );
    const result2 = await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" }
    );

    expect(result1.name).toBe("community");
    expect(result2.name).toBe("community");
    expect(callCount.value).toBe(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bypasses cache with noCache option", async () => {
    const callCount = { value: 0 };
    globalThis.fetch = mock(() => {
      callCount.value++;
      return Promise.resolve(new Response(validYaml, { status: 200 }));
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" },
      "main",
      { noCache: true }
    );
    await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" },
      "main",
      { noCache: true }
    );

    expect(callCount.value).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses custom ref for URL construction", async () => {
    let fetchedUrl = "";
    globalThis.fetch = mock((url: string) => {
      fetchedUrl = url;
      return Promise.resolve(new Response(validYaml, { status: 200 }));
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry" },
      "develop",
      { noCache: true }
    );

    expect(fetchedUrl).toContain("/develop/registry.yaml");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── downloadRole ──────────────────────────────────────────────────

describe("downloadRole", () => {
  it("throws network error on connection failure during download", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("connection reset");
    });

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow(/network error/i);
  });

  it("throws not found on 404 response", async () => {
    const mockResponse = new Response("Not Found", { status: 404 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow("not found");
  });

  it("throws on non-ok response", async () => {
    const mockResponse = new Response("Server Error", { status: 500 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow("HTTP 500");
  });

  it("downloads and extracts a role tarball successfully", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-download-test-"));
    const fixtureDir = join(tmpDir, "fixture");
    // GitHub tarballs have one top-level dir: owner-repo-commithash/
    // After --strip-components=1, we want: roles/{roleId}/role.yaml
    const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
    const roleDir = join(topDir, "roles", "code-reviewer");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: code-reviewer\ndescription: Reviews code\n");
    writeFileSync(join(topDir, "registry.yaml"), validYaml);

    const archivePath = join(tmpDir, "test.tar.gz");
    const tarProc = Bun.spawn(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
    const tarExit = await tarProc.exited;
    expect(tarExit).toBe(0);

    const archiveBytes = require("node:fs").readFileSync(archivePath);
    const mockResponse = new Response(archiveBytes, { status: 200 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse));

    const resultDir = await downloadRole(
      { name: "community", url: "https://github.com/example/myrepo" },
      "code-reviewer",
      "1.0.0"
    );

    expect(existsSync(resultDir)).toBe(true);
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── computeIntegrity ──────────────────────────────────────────────

describe("computeIntegrity", () => {
  it("computes SHA256 hash of a directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-integrity-test-"));
    mkdirSync(join(tmpDir, "subdir"), { recursive: true });
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    writeFileSync(join(tmpDir, "subdir", "b.txt"), "world");

    const hash = await computeIntegrity(tmpDir);
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns consistent hash for same content", async () => {
    const tmpDir1 = mkdtempSync(join(tmpdir(), "rolebox-int-1-"));
    const tmpDir2 = mkdtempSync(join(tmpdir(), "rolebox-int-2-"));
    writeFileSync(join(tmpDir1, "x.txt"), "same");
    writeFileSync(join(tmpDir2, "x.txt"), "same");

    const hash1 = await computeIntegrity(tmpDir1);
    const hash2 = await computeIntegrity(tmpDir2);

    expect(hash1).toBe(hash2);

    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("returns different hash for different content", async () => {
    const tmpDir1 = mkdtempSync(join(tmpdir(), "rolebox-int-3-"));
    const tmpDir2 = mkdtempSync(join(tmpdir(), "rolebox-int-4-"));
    writeFileSync(join(tmpDir1, "x.txt"), "alpha");
    writeFileSync(join(tmpDir2, "x.txt"), "beta");

    const hash1 = await computeIntegrity(tmpDir1);
    const hash2 = await computeIntegrity(tmpDir2);

    expect(hash1).not.toBe(hash2);

    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("returns empty hash for empty directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-int-empty-"));
    const hash = await computeIntegrity(tmpDir);
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles non-existent directory", async () => {
    const hash = await computeIntegrity("/tmp/does-not-exist-anywhere-rolebox");
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});

// ── Integration test (skipped by default) ─────────────────────────

describe("integration", () => {
  it.skip("fetches a real registry manifest from GitHub", async () => {
    // This test makes real network calls; only run manually
    const result = await fetchRegistryManifest(
      { name: "rolebox", url: "https://github.com/EricMoin/rolebox" },
      "main",
      { noCache: true }
    );
    expect(result.name).toBeTruthy();
    expect(Object.keys(result.roles).length).toBeGreaterThan(0);
  });
});


