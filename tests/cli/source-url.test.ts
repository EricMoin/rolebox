// Source URL mapping: the URL-only kind detection, the exact manifest/archive
// shapes each kind produces, and the refusal for a URL that identifies no
// backend. Pure module — no fs, no network, no config.
import { describe, it, expect } from "vitest";
import {
  archiveUrlCandidates,
  archiveUrlFor,
  defaultRegistryName,
  manifestUrlFor,
  parseRegistryUrl,
} from "../../src/cli/source-url.ts";

// ── kind detection ────────────────────────────────────────────────

describe("parseRegistryUrl detection", () => {
  it("detects github.com", () => {
    const parsed = parseRegistryUrl("https://github.com/owner/repo");
    expect(parsed.kind).toBe("github");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("owner");
    expect(parsed.repo).toBe("repo");
    expect(parsed.baseUrl).toBe("https://github.com/owner/repo");
  });

  it("strips a trailing .git from the repository name", () => {
    const parsed = parseRegistryUrl("https://github.com/owner/repo.git");
    expect(parsed.kind).toBe("github");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.repo).toBe("repo");
  });

  it("keeps the scp-like git@github.com form working", () => {
    const parsed = parseRegistryUrl("git@github.com:owner/repo.git");
    expect(parsed.kind).toBe("github");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("owner");
    expect(parsed.repo).toBe("repo");
  });

  it("detects gitlab.com with a nested group", () => {
    const parsed = parseRegistryUrl("https://gitlab.com/group/sub/repo");
    expect(parsed.kind).toBe("gitlab");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("group/sub");
    expect(parsed.repo).toBe("repo");
    expect(parsed.baseUrl).toBe("https://gitlab.com/group/sub/repo");
  });

  it("detects a self-hosted host from a /-/ path segment and normalizes the route", () => {
    const parsed = parseRegistryUrl("https://code.example.com/group/sub/repo/-/tree/main");
    expect(parsed.kind).toBe("gitlab");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("group/sub");
    expect(parsed.repo).toBe("repo");
    expect(parsed.baseUrl).toBe("https://code.example.com/group/sub/repo");
  });

  it("detects the gitlab family from the host alone", () => {
    expect(parseRegistryUrl("https://gitlab.example.com/group/repo").kind).toBe("gitlab");
    expect(parseRegistryUrl("https://gitlab-team.example.com/group/repo").kind).toBe("gitlab");
    expect(parseRegistryUrl("https://my.gitlab.com/group/repo").kind).toBe("gitlab");
  });

  it("detects a .yaml URL as a direct http manifest", () => {
    const parsed = parseRegistryUrl("https://roles.example.com/acme/registry.yaml");
    expect(parsed.kind).toBe("http");
    if (parsed.kind !== "http") throw new Error("expected an http source");
    expect(parsed.baseUrl).toBe("https://roles.example.com/acme");
    expect(parsed.manifestFile).toBe("registry.yaml");
  });

  it("detects .yml case-insensitively", () => {
    const parsed = parseRegistryUrl("https://roles.example.com/acme/roles.YML");
    expect(parsed.kind).toBe("http");
    if (parsed.kind !== "http") throw new Error("expected an http source");
    expect(parsed.manifestFile).toBe("roles.YML");
  });

  it("treats a .yaml URL as the manifest itself, whatever the host", () => {
    const parsed = parseRegistryUrl("https://code.example.com/group/repo/roles.yaml");
    expect(parsed.kind).toBe("http");
    if (parsed.kind !== "http") throw new Error("expected an http source");
    expect(parsed.baseUrl).toBe("https://code.example.com/group/repo");
    expect(parsed.manifestFile).toBe("roles.yaml");
  });
});

// ── refusal ───────────────────────────────────────────────────────

describe("parseRegistryUrl refusal", () => {
  /** The refusal names the recognizable forms, with the URL interpolated. */
  const refusal = (url: string) =>
    `unrecognized source URL "${url}": expected a GitHub or GitLab project URL, or a registry.yaml URL (for example https://host/path/registry.yaml)`;

  it("refuses a bare owner/repo on an unrecognized host", () => {
    expect(() => parseRegistryUrl("https://code.example.com/group/sub/repo")).toThrow(
      refusal("https://code.example.com/group/sub/repo"),
    );
    expect(() => parseRegistryUrl("https://roles.example.com/acme")).toThrow(
      refusal("https://roles.example.com/acme"),
    );
    expect(() => parseRegistryUrl("git@code.example.com:group/repo")).toThrow(
      /unrecognized source URL/,
    );
  });

  it("refuses a bare host or a host/path on an unrecognized host", () => {
    expect(() => parseRegistryUrl("https://code.example.com")).toThrow(/unrecognized source URL/);
    expect(() => parseRegistryUrl("https://code.example.com/group")).toThrow(
      /unrecognized source URL/,
    );
  });

  it("refuses a GitHub web-UI route instead of fetching a URL that cannot exist", () => {
    expect(() => parseRegistryUrl("https://github.com/o/r/blob/main/registry.yaml")).toThrow(
      refusal("https://github.com/o/r/blob/main/registry.yaml"),
    );
    expect(() => parseRegistryUrl("https://github.com/o/r/tree/main")).toThrow(
      /unrecognized source URL/,
    );
    expect(() => parseRegistryUrl("git@github.com:o/sub/r.git")).toThrow(
      /unrecognized source URL/,
    );
    expect(() => parseRegistryUrl("https://github.com/o//r")).toThrow(/unrecognized source URL/);
  });

  it("points at a recognizable form in the message", () => {
    expect(() => parseRegistryUrl("https://roles.example.com/acme")).toThrow(
      /expected a GitHub or GitLab project URL, or a registry\.yaml URL \(for example https:\/\/host\/path\/registry\.yaml\)/,
    );
  });
});

// ── rejection ─────────────────────────────────────────────────────

describe("parseRegistryUrl rejection", () => {
  it("rejects a non-http(s) scheme", () => {
    expect(() => parseRegistryUrl("ftp://host/repo")).toThrow(/unsupported scheme "ftp"/);
    expect(() => parseRegistryUrl("git://host/owner/repo")).toThrow(/unsupported scheme "git"/);
  });

  it("rejects a value that is not a URL", () => {
    expect(() => parseRegistryUrl("not-a-url")).toThrow(/invalid registry URL/);
    expect(() => parseRegistryUrl("github.com/owner/repo")).toThrow(/invalid registry URL/);
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(() => parseRegistryUrl("")).toThrow(/invalid registry URL/);
    expect(() => parseRegistryUrl("   ")).toThrow(/invalid registry URL/);
  });

  it("rejects a host that is not a valid hostname", () => {
    expect(() => parseRegistryUrl("https://exa_mple.com/owner/repo")).toThrow(/not a valid hostname/);
  });

  it("rejects a project path without an owner", () => {
    expect(() => parseRegistryUrl("https://github.com/owner")).toThrow(/expected a project path/);
  });
});

// ── GitLab web URLs ───────────────────────────────────────────────

describe("parseRegistryUrl GitLab web URLs", () => {
  it("drops the web-UI route from a pasted tree URL", () => {
    const parsed = parseRegistryUrl("https://gitlab.com/group/repo/-/tree/main");
    expect(parsed.kind).toBe("gitlab");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("group");
    expect(parsed.repo).toBe("repo");
    expect(parsed.baseUrl).toBe("https://gitlab.com/group/repo");
    expect(defaultRegistryName("https://gitlab.com/group/repo/-/tree/main")).toBe("repo");
  });

  it("builds the same manifest and archive URLs as the plain project root", () => {
    const webUrl = { url: "https://gitlab.com/group/repo/-/tree/main" };
    const rootUrl = { url: "https://gitlab.com/group/repo" };

    const manifest = manifestUrlFor(webUrl);
    expect(manifest).toBe("https://gitlab.com/group/repo/-/raw/main/registry.yaml");
    expect(manifest).toBe(manifestUrlFor(rootUrl));
    expect(manifest.match(/\/-\//g)).toHaveLength(1);

    const archives = archiveUrlCandidates(webUrl, "role-a", "1.0.0");
    expect(archives).toEqual(["https://gitlab.com/group/repo/-/archive/main/repo-main.tar.gz"]);
    expect(archives).toEqual(archiveUrlCandidates(rootUrl, "role-a", "1.0.0"));
    expect(archives[0].match(/\/-\//g)).toHaveLength(1);
  });

  it("normalizes a pasted blob URL on a self-hosted host", () => {
    const url = "https://code.example.com/group/sub/repo/-/blob/main/registry.yaml";
    const parsed = parseRegistryUrl(url);
    expect(parsed.kind).toBe("gitlab");
    if (parsed.kind === "http") throw new Error("expected a git source");
    expect(parsed.owner).toBe("group/sub");
    expect(parsed.repo).toBe("repo");
    expect(parsed.baseUrl).toBe("https://code.example.com/group/sub/repo");
    expect(manifestUrlFor({ url })).toBe(
      "https://code.example.com/group/sub/repo/-/raw/main/registry.yaml",
    );
  });

  it("rejects a /-/ route with no project path in front", () => {
    expect(() => parseRegistryUrl("https://gitlab.com/-/tree/main")).toThrow(
      /expected a project path like owner\/repo/,
    );
  });
});

// ── manifest URLs ─────────────────────────────────────────────────

describe("manifestUrlFor", () => {
  it("builds the GitHub raw URL, defaulting to main", () => {
    expect(manifestUrlFor({ url: "https://github.com/owner/repo" })).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/registry.yaml",
    );
  });

  it("uses the entry's ref, and lets an explicit ref win", () => {
    expect(manifestUrlFor({ url: "https://github.com/owner/repo", ref: "v2" })).toBe(
      "https://raw.githubusercontent.com/owner/repo/v2/registry.yaml",
    );
    expect(manifestUrlFor({ url: "https://github.com/owner/repo", ref: "v2" }, "release")).toBe(
      "https://raw.githubusercontent.com/owner/repo/release/registry.yaml",
    );
  });

  it("builds the GitLab -/raw URL for a nested group", () => {
    expect(manifestUrlFor({ url: "https://gitlab.com/group/sub/repo" })).toBe(
      "https://gitlab.com/group/sub/repo/-/raw/main/registry.yaml",
    );
  });

  it("URL-encodes a GitLab ref as one path component", () => {
    expect(manifestUrlFor({ url: "https://gitlab.com/group/sub/repo" }, "feature/x")).toBe(
      "https://gitlab.com/group/sub/repo/-/raw/feature%2Fx/registry.yaml",
    );
  });

  it("uses the URL itself for a direct http manifest", () => {
    expect(manifestUrlFor({ url: "https://roles.example.com/acme/registry.yaml" })).toBe(
      "https://roles.example.com/acme/registry.yaml",
    );
    expect(manifestUrlFor({ url: "https://roles.example.com/registry.yaml" })).toBe(
      "https://roles.example.com/registry.yaml",
    );
  });

  it("auto-detects the http kind from a .yaml URL", () => {
    expect(manifestUrlFor({ url: "https://roles.example.com/acme/registry.yaml" })).toBe(
      "https://roles.example.com/acme/registry.yaml",
    );
  });
});

// ── archive URLs ──────────────────────────────────────────────────

describe("archiveUrlCandidates", () => {
  it("builds the GitHub tarball API URL", () => {
    expect(archiveUrlCandidates({ url: "https://github.com/owner/repo" }, "role-a", "1.0.0")).toEqual([
      "https://api.github.com/repos/owner/repo/tarball/main",
    ]);
  });

  it("lets an explicit ref win over the entry's ref for GitHub", () => {
    expect(
      archiveUrlCandidates({ url: "https://github.com/owner/repo", ref: "v2" }, "role-a", "1.0.0", undefined, "release"),
    ).toEqual(["https://api.github.com/repos/owner/repo/tarball/release"]);
  });

  it("builds the GitLab archive URL for a nested group and an encoded ref", () => {
    expect(
      archiveUrlCandidates({ url: "https://gitlab.com/group/sub/repo" }, "role-a", "1.0.0", undefined, "feature/x"),
    ).toEqual(["https://gitlab.com/group/sub/repo/-/archive/feature%2Fx/repo-feature%2Fx.tar.gz"]);
  });

  it("builds the GitLab archive URL from the entry's ref", () => {
    expect(
      archiveUrlCandidates({ url: "https://gitlab.com/group/repo", ref: "v1.2.3" }, "role-a", "1.0.0"),
    ).toEqual(["https://gitlab.com/group/repo/-/archive/v1.2.3/repo-v1.2.3.tar.gz"]);
  });

  it("offers the versioned http archive, then the versionless fallback", () => {
    expect(
      archiveUrlCandidates({ url: "https://roles.example.com/acme/registry.yaml" }, "role-a", "1.0.0"),
    ).toEqual([
      "https://roles.example.com/acme/roles/role-a@1.0.0.tar.gz",
      "https://roles.example.com/acme/roles/role-a.tar.gz",
    ]);
  });

  it("resolves the http candidates against a direct manifest URL's base", () => {
    expect(
      archiveUrlCandidates({ url: "https://roles.example.com/acme/registry.yaml" }, "role-a", "2.1.0"),
    ).toEqual([
      "https://roles.example.com/acme/roles/role-a@2.1.0.tar.gz",
      "https://roles.example.com/acme/roles/role-a.tar.gz",
    ]);
  });

  it("requires a version before it uses the versionless archive", () => {
    const versionless = "https://roles.example.com/acme/roles/role-a.tar.gz";
    expect(() =>
      archiveUrlCandidates({ url: "https://roles.example.com/acme/registry.yaml" }, "role-a", ""),
    ).toThrow(`a version is required to use the versionless archive ${versionless}: the archive name carries no version`);
    // A whitespace-only version is not a version either.
    expect(() =>
      archiveUrlCandidates({ url: "https://roles.example.com/acme/registry.yaml" }, "role-a", "   "),
    ).toThrow(/a version is required to use the versionless archive/);
  });

  it("resolves a relative per-role archive against the manifest URL", () => {
    expect(
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "dist/role-a.tar.gz",
      ),
    ).toEqual(["https://roles.example.com/acme/dist/role-a.tar.gz"]);
  });

  // A manifest-declared `archive` is untrusted remote data: it may point at any
  // path on ITS OWN origin, but never steer the download to a host the user did
  // not configure (the source URL itself stays unrestricted — that choice is the
  // user's).
  it("uses an absolute per-role archive on the manifest's own origin as-is", () => {
    expect(
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "https://roles.example.com/dist/role-a-1.0.0.tar.gz",
      ),
    ).toEqual(["https://roles.example.com/dist/role-a-1.0.0.tar.gz"]);
  });

  it("refuses a per-role archive on another origin", () => {
    expect(() =>
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "https://cdn.example.com/roles/role-a-1.0.0.tar.gz",
      ),
    ).toThrow(/must stay on the manifest's own origin \(https:\/\/roles\.example\.com\)/);
  });

  it("refuses a protocol-relative per-role archive", () => {
    expect(() =>
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "//cdn.example.com/roles/role-a-1.0.0.tar.gz",
      ),
    ).toThrow(/must stay on the manifest's own origin/);
  });

  it("refuses a loopback or link-local per-role archive", () => {
    for (const target of [
      "http://127.0.0.1:9/roles/role-a.tar.gz",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(() =>
        archiveUrlCandidates(
          { url: "https://roles.example.com/acme/registry.yaml" },
          "role-a",
          "1.0.0",
          target,
        ),
      ).toThrow(/must stay on the manifest's own origin/);
    }
  });

  it("keeps a relative per-role archive relative to the manifest, never another origin", () => {
    // `..` moves the path but not the origin, so the archive stays on the
    // host the user configured.
    expect(
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "../../../etc/passwd",
      ),
    ).toEqual(["https://roles.example.com/etc/passwd"]);
  });

  it("refuses a per-role archive that is not an http(s) URL", () => {
    expect(() =>
      archiveUrlCandidates(
        { url: "https://roles.example.com/acme/registry.yaml" },
        "role-a",
        "1.0.0",
        "data:text/plain,x",
      ),
    ).toThrow(/an archive path must resolve to an http\(s\) URL/);
  });

  it("ignores a per-role archive for git sources", () => {
    expect(
      archiveUrlCandidates({ url: "https://github.com/owner/repo" }, "role-a", "1.0.0", "https://cdn.example.com/x.tar.gz"),
    ).toEqual(["https://api.github.com/repos/owner/repo/tarball/main"]);
  });

  it("archiveUrlFor returns the first candidate", () => {
    expect(archiveUrlFor({ url: "https://roles.example.com/acme/registry.yaml" }, "role-a", "1.0.0")).toBe(
      "https://roles.example.com/acme/roles/role-a@1.0.0.tar.gz",
    );
  });
});

// ── default source names ──────────────────────────────────────────

describe("defaultRegistryName", () => {
  it("uses the repository basename for git sources", () => {
    expect(defaultRegistryName("https://github.com/owner/my-repo")).toBe("my-repo");
    expect(defaultRegistryName("https://github.com/owner/my-repo.git")).toBe("my-repo");
    expect(defaultRegistryName("git@github.com:owner/my-repo.git")).toBe("my-repo");
  });

  it("uses the last path segment for a nested GitLab project", () => {
    expect(defaultRegistryName("https://gitlab.com/group/sub/repo")).toBe("repo");
  });

  it("uses the last path segment of the manifest's base", () => {
    expect(defaultRegistryName("https://roles.example.com/team/acme/registry.yaml")).toBe("acme");
  });

  it("strips the manifest file name for a direct manifest URL", () => {
    expect(defaultRegistryName("https://roles.example.com/acme/registry.yaml")).toBe("acme");
  });

  it("falls back to the host when the manifest sits at the root", () => {
    expect(defaultRegistryName("https://roles.example.com/registry.yaml")).toBe("roles.example.com");
  });

  it("uses the hostname without the port at the root", () => {
    expect(defaultRegistryName("http://localhost:8080/registry.yaml")).toBe("localhost");
    expect(defaultRegistryName("http://127.0.0.1:8080/acme/registry.yaml")).toBe("acme");
  });
});

// ── ref encoding and host look-alikes ─────────────────────────────

describe("ref encoding and GitLab host recognition", () => {
  it("encodes a GitHub ref as one path component", () => {
    // A ref is one opaque name: `..` must not rewrite the URL it sits in.
    expect(manifestUrlFor({ url: "https://github.com/owner/repo" }, "../../evil")).toBe(
      "https://raw.githubusercontent.com/owner/repo/..%2F..%2Fevil/registry.yaml",
    );
    expect(archiveUrlCandidates({ url: "https://github.com/owner/repo" }, "role-a", "1.0.0", undefined, "feature/x")).toEqual([
      "https://api.github.com/repos/owner/repo/tarball/feature%2Fx",
    ]);
    // Ordinary refs are unchanged.
    expect(manifestUrlFor({ url: "https://github.com/owner/repo" }, "v2")).toContain("/v2/registry.yaml");
  });

  it("refuses a source URL with a dot segment instead of silently retargeting it", () => {
    expect(() => parseRegistryUrl("https://gitlab.com/group/../repo")).toThrow(/contains a '\.' or '\.\.' segment/);
    expect(() => parseRegistryUrl("https://gitlab.com/a/./b/repo")).toThrow(/contains a '\.' or '\.\.' segment/);
  });

  it("recognizes the gitlab family without trusting a look-alike host", () => {
    expect(parseRegistryUrl("https://gitlab.example.com/group/repo").kind).toBe("gitlab");
    expect(parseRegistryUrl("https://my.gitlab.com/group/repo").kind).toBe("gitlab");
    expect(parseRegistryUrl("https://sub.gitlab.example.com/group/repo").kind).toBe("gitlab");
    // `notgitlab.example.com` spells "gitlab" but is not the family: it must not
    // receive the GitLab credential. Its project is still reachable explicitly.
    expect(() => parseRegistryUrl("https://notgitlab.example.com/group/repo")).toThrow(/unrecognized source URL/);
    expect(parseRegistryUrl("https://notgitlab.example.com/group/repo/-/tree/main").kind).toBe("gitlab");
    expect(parseRegistryUrl("https://notgitlab.example.com/group/repo/registry.yaml").kind).toBe("http");
  });
});
