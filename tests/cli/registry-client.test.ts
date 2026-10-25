import { spawnProcess } from "../../scripts/node-process.ts";
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, readdirSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasTar } from "../helpers/tar.ts";

function setMockDataDir(dir: string) {
  process.env.XDG_DATA_HOME = dir;
  // ROLEBOX_DATA_DIR is honored with the highest precedence in getDataDir() on
  // every platform (src/cli/paths.ts), so pointing it at the fresh per-test dir
  // gives belt-and-braces isolation that does not depend on XDG handling.
  process.env.ROLEBOX_DATA_DIR = dir;
}

import {
  resolveVersion,
  fetchRegistryManifest,
  downloadRole,
  computeIntegrity,
  escapeForDisplay,
} from "../../src/cli/registry-client.ts";

import type { RegistryManifest } from "../../src/cli/types.ts";
import { install } from "../../src/cli/commands/install.ts";

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
  delete process.env.ROLEBOX_DATA_DIR;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITLAB_TOKEN;
});

/** Capture the URL and init of every fetch call, answering with `respond`. */
function capturingFetch(
  respond: (url: string) => Response,
): { urls: string[]; inits: Array<Parameters<typeof fetch>[1]> } {
  const urls: string[] = [];
  const inits: Array<Parameters<typeof fetch>[1]> = [];
  globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      inits.push(init);
      return Promise.resolve(respond(url));
    });
  return { urls, inits };
}

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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

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
    globalThis.fetch = vi.fn(() => {
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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

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
    // Build a fresh Response per fetch call — a Response body can only be
    // consumed once, so a single hoisted Response would fail this test for the
    // wrong reason if the cache ever missed on the second call.
    globalThis.fetch = vi.fn(() => {
      callCount.value++;
      return Promise.resolve(new Response(validYaml, { status: 200 }));
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
    globalThis.fetch = vi.fn(() => {
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
    globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0]) => {
      fetchedUrl = input instanceof Request ? input.url : String(input);
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
    globalThis.fetch = vi.fn(() => {
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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

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
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow("HTTP 500");
  });

  it.skipIf(!hasTar())("downloads and extracts a role tarball successfully", async () => {
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
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
    const tarExit = await tarProc.exited;
    expect(tarExit).toBe(0);

    const archiveBytes = require("node:fs").readFileSync(archivePath);
    const mockResponse = new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 });
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

    const resultDir = await downloadRole(
      { name: "community", url: "https://github.com/example/myrepo" },
      "code-reviewer",
      "1.0.0"
    );

    // Verify extraction output exists at the correct path
    expect(existsSync(resultDir)).toBe(true);
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    // Verify the result uses the stable output directory pattern
    expect(resultDir).toMatch(/rolebox-out-/);

    // Clean up all test artifacts
    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTar())("invokes tar without --include flag during extraction", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-args-test-"));
    const fixtureDir = join(tmpDir, "fixture");
    const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
    const roleDir = join(topDir, "roles", "code-reviewer");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: code-reviewer\ndescription: Reviews code\n");
    writeFileSync(join(topDir, "registry.yaml"), validYaml);

    const archivePath = join(tmpDir, "test.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
    const tarExit = await tarProc.exited;
    expect(tarExit).toBe(0);

    const archiveBytes = require("node:fs").readFileSync(archivePath);
    const mockResponse = new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 });
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

    // Spy on the spawn dependency passed to downloadRole to capture the tar
    // extraction args while still delegating to the real spawn, so real
    // extraction happens (verifying the output dir below). downloadRole
    // accepts injected spawn/spawnSync (defaults to node:child_process).
    const { spawn: realSpawn, spawnSync: realSpawnSync } = await import("node:child_process");
    const extractionArgs: string[] = [];
    const resultDir = await downloadRole(
      { name: "community", url: "https://github.com/example/myrepo" },
      "code-reviewer",
      "1.0.0",
      undefined,
      {
        spawnSync: realSpawnSync,
        spawn: (command: any, args?: any, options?: any) => {
          // node:child_process spawn is spawn(command, args, options).
          if (command === "tar" && args && args.includes("xzf")) {
            extractionArgs.push(command, ...args);
          }
          return realSpawn(command, args, options) as any;
        },
      }
    );

    // Verify tar is invoked WITHOUT --include flag
    expect(extractionArgs.length).toBeGreaterThan(0);
    expect(extractionArgs).not.toContain("--include");

    // Verify expected flags are still present
    expect(extractionArgs).toContain("xzf");
    expect(extractionArgs).toContain("--strip-components=1");

    // Verify extraction still works
    expect(existsSync(resultDir)).toBe(true);
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTar())("throws when tar binary is not found", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-notar-test-"));
    const fixtureDir = join(tmpDir, "fixture");
    const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
    const roleDir = join(topDir, "roles", "code-reviewer");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: code-reviewer\ndescription: Reviews code\n");
    writeFileSync(join(topDir, "registry.yaml"), validYaml);

    const archivePath = join(tmpDir, "test.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
    const tarExit = await tarProc.exited;
    expect(tarExit).toBe(0);

    const archiveBytes = require("node:fs").readFileSync(archivePath);
    const mockResponse = new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 });
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

    // downloadRole detects a missing tar via spawnSync("tar", ["--version"]).
    // Inject a spawnSync that reports a failure so the tar check throws.
    const { spawn: realSpawn } = await import("node:child_process");
    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0",
        undefined,
        {
          spawn: realSpawn,
          spawnSync: () => ({ status: -1, error: new Error("ENOENT: tar not found") }) as any,
        }
      )
      ).rejects.toThrow("tar binary not found");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts the download with a timeout error when the fetch stalls", async () => {
    // A fetch that never resolves, but rejects when the AbortController fires.
    globalThis.fetch = vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0",
        undefined,
        undefined,
        { timeoutMs: 50, maxRetries: 0 }
      )
    ).rejects.toThrow(/timed out downloading role/);
  });

  it("treats a truncated body as an explicit error (bytes read < Content-Length)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        controller.close();
      },
    });
    // 10 actual bytes, but the header claims 1000 — a truncated/partial body.
    const mockResponse: any = {
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "1000" : null) },
      body: stream,
    };
    globalThis.fetch = vi.fn(() => Promise.resolve(mockResponse));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow(/truncated download/);
  });

  it("cleans up the rolebox-out-* temp dir on download failure", async () => {
    const t = tmpdir();
    const before = new Set(readdirSync(t).filter((d) => d.startsWith("rolebox-out-")));
    globalThis.fetch = vi.fn(() => { throw new Error("connection reset"); });

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0",
        undefined,
        undefined,
        { maxRetries: 0 }
      )
    ).rejects.toThrow(/network error/i);

    const leaked = readdirSync(t).filter((d) => d.startsWith("rolebox-out-") && !before.has(d));
    expect(leaked).toHaveLength(0);
  });

  it.skipIf(!hasTar() || process.platform === "win32")("rejects archives whose entries escape the extract directory (zip-slip)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-zipslip-"));
    const fixtureDir = join(tmpDir, "fixture");
    const topDir = join(fixtureDir, "top");
    mkdirSync(join(topDir, "roles", "code-reviewer"), { recursive: true });
    writeFileSync(join(topDir, "roles", "code-reviewer", "role.yaml"), "name: code-reviewer\n");
    // A symlink that escapes the extraction tree — realpath must catch it.
    symlinkSync("/etc/passwd", join(topDir, "evil-link"));

    const archivePath = join(tmpDir, "test.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", fixtureDir, "top"]);
    expect(await tarProc.exited).toBe(0);

    const archiveBytes = readFileSync(archivePath);
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 })));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/myrepo" },
        "code-reviewer",
        "1.0.0"
      )
    ).rejects.toThrow(/zip-slip|path traversal|resolves outside/);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── computeIntegrity ──────────────────────────────────────────────

describe("credential and URL sanitizing", () => {
  it("strips control characters from a token read out of the environment", async () => {
    process.env.GITLAB_TOKEN = "glpat-example-token\n";
    const seen = capturingFetch(() => new Response(validYaml, { status: 200 }));
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-token-sanitize-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest({ name: "gl", url: "https://gitlab.com/group/repo" }, undefined, {
      noCache: true,
    });

    const headers = seen.inits[0]?.headers as Record<string, string>;
    expect(headers["PRIVATE-TOKEN"]).toBe("glpat-example-token");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redacts a password embedded in a source URL", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-url-redact-"));
    setMockDataDir(tmpDir);
    capturingFetch(() => new Response("nope", { status: 404 }));

    const err = await fetchRegistryManifest(
      { name: "plain", url: "https://user:s3cret@roles.example.com/acme/registry.yaml" },
      undefined,
      { noCache: true },
    ).catch((e: Error) => e);

    const message = (err as Error).message;
    expect(message).not.toContain("s3cret");
    expect(message).toContain("***@roles.example.com");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

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

  it("distinguishes a symlink from the file it points at", async () => {
    const real = mkdtempSync(join(tmpdir(), "rolebox-int-link-real-"));
    writeFileSync(join(real, "target.txt"), "payload");
    const linked = mkdtempSync(join(tmpdir(), "rolebox-int-link-"));
    symlinkSync(join(real, "target.txt"), join(linked, "entry.txt"));

    // Same visible bytes, different tree: the digest must differ.
    expect(await computeIntegrity(linked)).not.toBe(await computeIntegrity(real));

    rmSync(real, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  });

  it("cannot be forged by concatenating names and contents", async () => {
    // {a: "X", b: "Y"} and {a: "Xb\0Y"} used to hash to the same stream.
    const split = mkdtempSync(join(tmpdir(), "rolebox-int-split-"));
    writeFileSync(join(split, "a"), "X");
    writeFileSync(join(split, "b"), "Y");
    const merged = mkdtempSync(join(tmpdir(), "rolebox-int-merged-"));
    writeFileSync(join(merged, "a"), "Xb\0Y");

    expect(await computeIntegrity(split)).not.toBe(await computeIntegrity(merged));

    rmSync(split, { recursive: true, force: true });
    rmSync(merged, { recursive: true, force: true });
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

// ── ref resolution and cache isolation ────────────────────────────

describe("registry-client ref resolution", () => {
  function captureFetchUrl(response: Response): { url: () => string } {
    let fetchedUrl = "";
    globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0]) => {
        fetchedUrl = input instanceof Request ? input.url : String(input);
        return Promise.resolve(response);
      });
    return { url: () => fetchedUrl };
  }

  it("uses the entry's ref when no explicit ref is passed", async () => {
    const seen = captureFetchUrl(new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    const result = await fetchRegistryManifest({
      name: "community",
      url: "https://github.com/example/registry",
      ref: "develop",
    });

    expect(result.name).toBe("community");
    expect(seen.url()).toContain("/develop/registry.yaml");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lets an explicit ref win over the entry's ref", async () => {
    const seen = captureFetchUrl(new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest(
      { name: "community", url: "https://github.com/example/registry", ref: "main" },
      "release",
      { noCache: true },
    );

    expect(seen.url()).toContain("/release/registry.yaml");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("downloads the entry's ref when no explicit ref is passed", async () => {
    const seen = captureFetchUrl(new Response("Not Found", { status: 404 }));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry", ref: "develop" },
        "code-reviewer",
        "1.0.0",
      ),
    ).rejects.toThrow(/not found/);

    expect(seen.url()).toContain("/tarball/develop");
  });

  it("lets an explicit ref win when downloading", async () => {
    const seen = captureFetchUrl(new Response("Not Found", { status: 404 }));

    await expect(
      downloadRole(
        { name: "community", url: "https://github.com/example/registry", ref: "main" },
        "code-reviewer",
        "1.0.0",
        "release",
      ),
    ).rejects.toThrow(/not found/);

    expect(seen.url()).toContain("/tarball/release");
  });

  it("keeps sources that share a name but differ in url or ref in separate cache dirs", async () => {
    const callCount = { value: 0 };
    globalThis.fetch = vi.fn(() => {
        callCount.value++;
        return Promise.resolve(new Response(validYaml, { status: 200 }));
      });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    // Same url and resolved branch, spelled with and without an explicit ref:
    // one cache entry, one fetch.
    await fetchRegistryManifest({ name: "community", url: "https://github.com/example/registry" });
    await fetchRegistryManifest({
      name: "community",
      url: "https://github.com/example/registry",
      ref: "main",
    });
    expect(callCount.value).toBe(1);

    // A different branch and a different repo are different sources: two more
    // fetches, two more cache dirs.
    await fetchRegistryManifest({
      name: "community",
      url: "https://github.com/example/registry",
      ref: "next",
    });
    await fetchRegistryManifest({ name: "community", url: "https://github.com/other/registry" });

    expect(callCount.value).toBe(3);
    const dirs = readdirSync(join(tmpDir, "cache"));
    expect(dirs).toHaveLength(3);
    expect(dirs.every((dir) => dir.startsWith("community-"))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sanitizes the name and suffixes a url+ref digest", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(validYaml, { status: 200 })));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest(
      { name: "my registry/bad", url: "https://github.com/example/registry" },
      undefined,
      { noCache: true },
    );

    const dirs = readdirSync(join(tmpDir, "cache"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^my_registry_bad-[0-9a-f]{8}$/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates an over-long name to a safe prefix", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(validYaml, { status: 200 })));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest(
      { name: "x".repeat(120), url: "https://github.com/example/registry" },
      undefined,
      { noCache: true },
    );

    const dirs = readdirSync(join(tmpDir, "cache"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^x{40}-[0-9a-f]{8}$/);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── GitLab and plain HTTP sources ─────────────────────────────────

describe("fetchRegistryManifest for GitLab and HTTP sources", () => {
  it("fetches a GitLab manifest from the -/raw URL with PRIVATE-TOKEN", async () => {
    process.env.GITLAB_TOKEN = "glpat-example-token";
    process.env.GITHUB_TOKEN = "ghp-example-token";
    const seen = capturingFetch(() => new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-cache-"));
    setMockDataDir(tmpDir);

    const result = await fetchRegistryManifest(
      { name: "gl", url: "https://gitlab.com/group/sub/repo", ref: "feature/x" },
      undefined,
      { noCache: true },
    );

    expect(result.name).toBe("community");
    expect(seen.urls).toEqual(["https://gitlab.com/group/sub/repo/-/raw/feature%2Fx/registry.yaml"]);
    const headers = seen.inits[0]?.headers as Record<string, string>;
    expect(headers["PRIVATE-TOKEN"]).toBe("glpat-example-token");
    // A GitHub token is never sent to GitLab.
    expect(headers["Authorization"]).toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends no PRIVATE-TOKEN when GITLAB_TOKEN is unset", async () => {
    const seen = capturingFetch(() => new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest({ name: "gl", url: "https://gitlab.com/group/repo" }, undefined, {
      noCache: true,
    });

    expect(seen.urls).toEqual(["https://gitlab.com/group/repo/-/raw/main/registry.yaml"]);
    const headers = seen.inits[0]?.headers as Record<string, string>;
    expect(headers["PRIVATE-TOKEN"]).toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("names GITLAB_TOKEN on a GitLab 401 and 403", async () => {
    for (const status of [401, 403]) {
      const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-cache-"));
      setMockDataDir(tmpDir);
      capturingFetch(() => new Response("denied", { status }));

      await expect(
        fetchRegistryManifest({ name: "gl", url: "https://gitlab.com/group/repo" }, undefined, {
          noCache: true,
        }),
      ).rejects.toThrow(/HTTP (401|403)\. Set GITLAB_TOKEN if the project is private\./);

      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fetches an http manifest from a base URL with only an Accept header", async () => {
    process.env.GITHUB_TOKEN = "ghp-example-token";
    process.env.GITLAB_TOKEN = "glpat-example-token";
    const seen = capturingFetch(() => new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-cache-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest({ name: "plain", url: "https://roles.example.com/acme/registry.yaml" }, undefined, {
      noCache: true,
    });

    expect(seen.urls).toEqual(["https://roles.example.com/acme/registry.yaml"]);
    const headers = seen.inits[0]?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/yaml, text/yaml, text/plain, */*");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["PRIVATE-TOKEN"]).toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fetches a direct registry.yaml URL as-is (auto-detected)", async () => {
    const seen = capturingFetch(() => new Response(validYaml, { status: 200 }));

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-cache-"));
    setMockDataDir(tmpDir);

    const result = await fetchRegistryManifest(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      "ignored-ref",
      { noCache: true },
    );

    expect(result.name).toBe("community");
    expect(seen.urls).toEqual(["https://roles.example.com/acme/registry.yaml"]);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not advertise a token on a plain http 403", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-cache-"));
    setMockDataDir(tmpDir);
    capturingFetch(() => new Response("forbidden", { status: 403 }));

    const err = await fetchRegistryManifest(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      undefined,
      { noCache: true },
    ).catch((e: Error) => e);

    expect((err as Error).message).toBe('failed to fetch registry "plain": HTTP 403');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("downloadRole for plain HTTP sources", () => {
  /** Build a real tar.gz with the tar binary and return its bytes. */
  async function buildTarGz(tmpDir: string, entries: string[]): Promise<Uint8Array> {
    const archivePath = join(tmpDir, "fixture.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", join(tmpDir, "fixture"), ...entries]);
    expect(await tarProc.exited).toBe(0);
    return new Uint8Array(readFileSync(archivePath));
  }

  it.skipIf(!hasTar())("extracts a flat http tarball whose contents are the role files", async () => {
    process.env.GITHUB_TOKEN = "ghp-example-token";
    process.env.GITLAB_TOKEN = "glpat-example-token";
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-flat-"));
    const roleSource = join(tmpDir, "fixture", "role-src");
    mkdirSync(join(roleSource, "skills"), { recursive: true });
    writeFileSync(join(roleSource, "role.yaml"), "name: code-reviewer\ndescription: Reviews code\n");
    writeFileSync(join(roleSource, "skills", "review.md"), "# review\n");
    // `-C <role> .` is how a dumb file server publishes a role: the archive's
    // contents ARE the role files.
    const archiveBytes = await buildTarGz(tmpDir, ["role-src"]);

    const seen = capturingFetch(() => new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }));

    const resultDir = await downloadRole(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      "code-reviewer",
      "1.0.0",
    );

    // The wrapper directory is stripped; the role files land at the root.
    expect(seen.urls).toEqual(["https://roles.example.com/acme/roles/code-reviewer@1.0.0.tar.gz"]);
    const headers = seen.inits[0]?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/yaml, text/yaml, text/plain, */*");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["PRIVATE-TOKEN"]).toBeUndefined();
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(resultDir, "skills", "review.md"))).toBe(true);

    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTar())("accepts an http archive that carries its role files at the root", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-root-"));
    const roleSource = join(tmpDir, "fixture");
    mkdirSync(roleSource, { recursive: true });
    writeFileSync(join(roleSource, "role.yaml"), "name: code-reviewer\n");
    const archiveBytes = await buildTarGz(tmpDir, ["."]);

    capturingFetch(() => new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }));

    const resultDir = await downloadRole(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      "code-reviewer",
      "1.0.0",
    );

    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTar())("falls back to the versionless archive only on a 404", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-fallback-"));
    const roleDir = join(tmpDir, "fixture", "roles", "code-reviewer");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: code-reviewer\n");
    // A sibling role directory may ship in the same archive.
    const siblingDir = join(tmpDir, "fixture", "roles", "other-role");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, "role.yaml"), "name: other-role\n");
    const archiveBytes = await buildTarGz(tmpDir, ["roles"]);

    const seen = capturingFetch((url) =>
      url.includes("@") ? new Response("Not Found", { status: 404 }) : new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }),
    );

    const resultDir = await downloadRole(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      "code-reviewer",
      "1.0.0",
    );

    expect(seen.urls).toEqual([
      "https://roles.example.com/acme/roles/code-reviewer@1.0.0.tar.gz",
      "https://roles.example.com/acme/roles/code-reviewer.tar.gz",
    ]);
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails on a non-404 status without trying the versionless fallback", async () => {
    const seen = capturingFetch(() => new Response("Server Error", { status: 500 }));

    await expect(
      downloadRole(
        { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
        "code-reviewer",
        "1.0.0",
      ),
    ).rejects.toThrow("HTTP 500");

    expect(seen.urls).toEqual(["https://roles.example.com/acme/roles/code-reviewer@1.0.0.tar.gz"]);
  });

  it("reports the versionless 404 when the fallback is not found either", async () => {
    const seen = capturingFetch(() => new Response("Not Found", { status: 404 }));

    await expect(
      downloadRole(
        { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
        "code-reviewer",
        "1.0.0",
      ),
    ).rejects.toThrow('role "code-reviewer" not found in registry "plain"');

    expect(seen.urls).toHaveLength(2);
  });

  it.skipIf(!hasTar())("uses the manifest-declared archive when the caller passes one", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-http-explicit-"));
    const roleSource = join(tmpDir, "fixture");
    mkdirSync(roleSource, { recursive: true });
    writeFileSync(join(roleSource, "role.yaml"), "name: code-reviewer\n");
    const archiveBytes = await buildTarGz(tmpDir, ["."]);

    const seen = capturingFetch(() => new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }));

    const resultDir = await downloadRole(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      "code-reviewer",
      "1.0.0",
      undefined,
      undefined,
      { archivePath: "dist/code-reviewer.tar.gz" },
    );

    expect(seen.urls).toEqual(["https://roles.example.com/acme/dist/code-reviewer.tar.gz"]);
    expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);

    rmSync(resultDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Redirect credential routing ────────────────────────────────────

describe("redirect credential routing", () => {
  /** Records the headers each hop received; a 3xx response redirects to `location`. */
  function hopHeaders(
    location: string | null,
  ): Array<{ url: string; headers: Record<string, string> }> {
    const hops: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = input instanceof Request ? input.url : String(input);
        hops.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        if (location !== null && hops.length === 1) {
          return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
        }
        return Promise.resolve(new Response(validYaml, { status: 200 }));
      });
    return hops;
  }

  it("drops PRIVATE-TOKEN on a cross-origin redirect and never re-attaches it", async () => {
    process.env.GITLAB_TOKEN = "glpat-example-token";
    const hops = hopHeaders("https://objects.example.com/elsewhere.yaml");

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-redirect-"));
    setMockDataDir(tmpDir);

    const manifest = await fetchRegistryManifest(
      { name: "gl", url: "https://gitlab.com/group/repo" },
      undefined,
      { noCache: true },
    );

    expect(manifest.name).toBe("community");
    expect(hops).toHaveLength(2);
    expect(hops[0].headers["PRIVATE-TOKEN"]).toBe("glpat-example-token");
    // The second origin is not the one the user configured: no credential.
    expect(hops[1].url).toBe("https://objects.example.com/elsewhere.yaml");
    expect(hops[1].headers["PRIVATE-TOKEN"]).toBeUndefined();
    expect(hops[1].headers["Authorization"]).toBeUndefined();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps PRIVATE-TOKEN on a same-origin redirect", async () => {
    process.env.GITLAB_TOKEN = "glpat-example-token";
    const hops = hopHeaders("/group/repo/-/raw/main/registry.yaml");

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-redirect-"));
    setMockDataDir(tmpDir);

    await fetchRegistryManifest({ name: "gl", url: "https://gitlab.com/group/repo" }, undefined, {
      noCache: true,
    });

    expect(hops).toHaveLength(2);
    expect(hops[1].headers["PRIVATE-TOKEN"]).toBe("glpat-example-token");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gl-redirect-"));
    setMockDataDir(tmpDir);
    hopHeaders("file:///etc/passwd");

    await expect(
      fetchRegistryManifest({ name: "gl", url: "https://gitlab.com/group/repo" }, undefined, {
        noCache: true,
      }),
    ).rejects.toThrow(/unsupported scheme "file"/);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Manifest resource bounds ───────────────────────────────────────

describe("fetchRegistryManifest resource bounds", () => {
  it("fails with a timeout instead of hanging on a body that never ends", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-manifest-timeout-"));
    setMockDataDir(tmpDir);
    globalThis.fetch = vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("name: x\n")); } });
          // A server that never closes the body: the fetch must be aborted.
          signal?.addEventListener("abort", () => reject(signal.reason));
          void body;
        });
      });

    const started = Date.now();
    const err = await fetchRegistryManifest(
      { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
      undefined,
      { noCache: true, timeoutMs: 60 },
    ).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/timed out fetching registry "plain"/);
    expect(Date.now() - started).toBeLessThan(2000);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a manifest larger than the byte cap", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-manifest-cap-"));
    setMockDataDir(tmpDir);
    globalThis.fetch = vi.fn(() => {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("x".repeat(4096)));
            c.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });

    await expect(
      fetchRegistryManifest(
        { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
        undefined,
        { noCache: true, maxBytes: 1024 },
      ),
    ).rejects.toThrow(/larger than the 1024-byte limit/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a declared Content-Length above the cap without reading the body", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-manifest-cap-"));
    setMockDataDir(tmpDir);
    globalThis.fetch = vi.fn(
        () =>
          Promise.resolve(
            new Response("name: x\n", { status: 200, headers: { "content-length": "1048576" } }),
          ),
      );

    await expect(
      fetchRegistryManifest(
        { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
        undefined,
        { noCache: true, maxBytes: 1024 },
      ),
    ).rejects.toThrow(/larger than the 1024-byte limit/);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Extraction containment and temp cleanup ────────────────────────

describe("downloadRole containment", () => {
  it.skipIf(!hasTar())("refuses an archive whose role directory is a symlink", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-symlink-role-"));
    const fixture = join(tmpDir, "fixture");
    // The archive keeps the git-style wrapper: `roles/<roleId>` is the entry the
    // extractor resolves, and here it is a link to a sibling tree that is
    // extracted alongside it (so the link resolves and the archive passes the
    // path-traversal guard — resolution is what must reject it).
    mkdirSync(join(fixture, "pkg", "roles", "real"), { recursive: true });
    writeFileSync(join(fixture, "pkg", "roles", "real", "role.yaml"), "name: real\n");
    symlinkSync("real", join(fixture, "pkg", "roles", "code-reviewer"));
    const archivePath = join(tmpDir, "fixture.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", join(fixture, "pkg"), "roles"]);
    expect(await tarProc.exited).toBe(0);
    const archiveBytes = new Uint8Array(readFileSync(archivePath));

    capturingFetch(() => new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }));

    // Extracting it and renaming it out would deliver a directory that is not
    // the role's own, so it is refused at resolution time.
    await expect(
      downloadRole(
        { name: "plain", url: "https://roles.example.com/acme/registry.yaml" },
        "code-reviewer",
        "1.0.0",
      ),
    ).rejects.toThrow(/is not a real directory inside the extract directory/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTar())("leaves no extraction workspace behind when the placement fails", async () => {
    // The install path owns the downloaded tree until it lands in the roles
    // directory. `moveDir` is the seam that puts it there: when it fails, the
    // downloaded tree must be removed, not abandoned in the temp directory. The
    // real module is imported first so only the move fails; everything else
    // (download, extraction, cleanup) runs as shipped.
    const fsUtils = await import("../../src/cli/fs-utils.ts");
    const realMoveDir = fsUtils.moveDir;
    vi.doMock("../../src/cli/fs-utils.ts", () => {
      let staged = 0;
      return {
        ...fsUtils,
        moveDir(src: string, dest: string) {
          if (String(src).includes("rolebox-out-")) {
            staged++;
            const err = new Error(`EACCES: permission denied, rename '${src}' -> '${dest}'`);
            throw err;
          }
          return realMoveDir(src, dest);
        },
      };
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-temp-cleanup-"));
    const fixture = join(tmpDir, "fixture");
    mkdirSync(join(fixture, "skills"), { recursive: true });
    writeFileSync(join(fixture, "role.yaml"), "name: code-reviewer\n");
    writeFileSync(join(fixture, "skills", "review.md"), "# review\n");
    const archivePath = join(tmpDir, "fixture.tar.gz");
    const tarProc = spawnProcess(["tar", "czf", archivePath, "-C", fixture, "."]);
    expect(await tarProc.exited).toBe(0);
    const archiveBytes = new Uint8Array(readFileSync(archivePath));

    const configDir = mkdtempSync(join(tmpdir(), "rolebox-temp-cleanup-cfg-"));
    process.env.ROLEBOX_CONFIG_DIR = configDir;
    const dataDir = mkdtempSync(join(tmpdir(), "rolebox-temp-cleanup-data-"));
    process.env.ROLEBOX_DATA_DIR = dataDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "registries:",
        "  - name: plain",
        "    url: https://roles.example.com/acme/registry.yaml",
        "    default: true",
        "",
      ].join("\n"),
    );
    capturingFetch((url) =>
      url.endsWith("registry.yaml")
        ? new Response(
            "name: acme\ndescription: d\nurl: u\nroles:\n  code-reviewer: {version: '1.0.0', description: d, tags: []}\n",
            { status: 200 },
          )
        : new Response(new Blob([Uint8Array.from(archiveBytes).buffer]), { status: 200 }),
    );

    const tempRoot = process.env.TMPDIR ?? tmpdir();
    const before = new Set(readdirSync(tempRoot).filter((name) => name.startsWith("rolebox-")));

    vi.resetModules();
    const { install: installWithPlacementFailure } = await import("../../src/cli/commands/install.ts");
    const err = await installWithPlacementFailure("plain:code-reviewer", { quiet: true }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/while placing the new version/);

    const leaked = readdirSync(tempRoot).filter(
      (name) => name.startsWith("rolebox-") && !before.has(name),
    );
    expect(leaked).toEqual([]);
    // Nothing was half-placed into the roles directory either (the registry
    // directory itself is created before the download and stays empty).
    expect(readdirSync(join(dataDir, "roles", "plain"))).toEqual([]);

    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("escapeForDisplay", () => {
  it("renders remote control characters instead of emitting them", () => {
    expect(escapeForDisplay("1.0.0\n✓ Installed evil@9.9.9")).toBe("1.0.0\\x0A✓ Installed evil@9.9.9");
    expect(escapeForDisplay("x\u001b]0;title\u0007")).toBe("x\\x1B]0;title\\x07");
    expect(escapeForDisplay("plain-1.0.0")).toBe("plain-1.0.0");
  });
});
