import { DEFAULT_GIT_BRANCH } from "../constants.ts";

/**
 * Role source URLs: the single owner of "which hosting backend does this URL
 * belong to, and where do its manifest and role archives live".
 *
 * The module is pure — no fs, no network, no config loading — so the client, the
 * commands and the tests all map a source URL the same way. Every entry point
 * validates before it builds anything: a URL is never concatenated unchecked.
 */

/** The hosting backends a role source can come from. */
export type SourceKind = "github" | "gitlab" | "http";

/** A git-hosted source (GitHub or GitLab): owner/repo project coordinates. */
export interface GitRegistryUrl {
  kind: "github" | "gitlab";
  /** Everything before the last path segment; nested GitLab groups keep their subgroups. */
  owner: string;
  /** The last path segment, with a trailing `.git` stripped. */
  repo: string;
  /** Canonical project URL, e.g. `https://gitlab.com/group/sub/repo`. */
  baseUrl: string;
}

/** A plain HTTP source: a dumb file server, no hosting API involved. */
export interface HttpRegistryUrl {
  kind: "http";
  /** URL the manifest and the default archive paths are resolved against. */
  baseUrl: string;
  /** Manifest file name: `registry.yaml`, or the file a direct manifest URL names. */
  manifestFile: string;
}

export type ParsedRegistryUrl = GitRegistryUrl | HttpRegistryUrl;

/** The subset of a registry entry needed to build its URLs. */
export interface RegistrySource {
  url: string;
  /** Git branch or tag; `github`/`gitlab` fall back to DEFAULT_GIT_BRANCH, `http` ignores it. */
  ref?: string;
}

// RFC 1123 hostname labels. `new URL` already rejects the coarser mistakes, but
// an explicit check keeps a bogus host from ever reaching a template string.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;
// `git@host:owner/repo.git` — the scp-like form git itself accepts.
const SCP_URL_RE = /^git@([^/:\s]+):(.+)$/;
const YAML_FILE_RE = /\.ya?ml$/i;

interface SourceTarget {
  /** Lowercased, validated host. */
  host: string;
  /** Origin (`https://host[:port]`) to rebuild canonical URLs from. */
  origin: string;
  /** Path segments without slashes or empty entries. */
  segments: string[];
  /** The original http(s) URL, unchanged (empty for the scp-like form). */
  rawUrl: string;
  /** Whether the input used the scp-like `git@host:path` form. */
  scp: boolean;
}

function invalidUrl(url: string, reason: string): Error {
  return new Error(`invalid registry URL "${url}": ${reason}`);
}

/**
 * The refusal for a URL that does not identify its backend. Rolebox never
 * probes the network and never guesses a backend, so the error names the URL
 * shapes that are recognizable instead.
 */
function unrecognizedSource(url: string): Error {
  return new Error(
    `unrecognized source URL "${url}": expected a GitHub or GitLab project URL, or a registry.yaml URL (for example https://host/path/registry.yaml)`,
  );
}

function assertHostname(host: string, url: string): string {
  const normalized = host.trim().toLowerCase();
  const bare = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  const valid = normalized.startsWith("[")
    ? IPV6_RE.test(bare)
    : HOSTNAME_RE.test(normalized);
  if (bare === "" || !valid) {
    throw invalidUrl(url, `"${host}" is not a valid hostname`);
  }
  return normalized;
}

function pathSegments(pathname: string): string[] {
  const path = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return path === "" ? [] : path.split("/");
}

/** Parse and validate the raw URL into host + project path coordinates. */
function parseTarget(url: string): SourceTarget {
  const raw = url.trim();

  const scp = raw.match(SCP_URL_RE);
  if (scp) {
    const host = assertHostname(scp[1], url);
    const segments = pathSegments(scp[2]);
    return { host, origin: `https://${host}`, segments, rawUrl: "", scp: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidUrl(url, "expected an absolute http(s) URL or git@host:owner/repo");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidUrl(
      url,
      `unsupported scheme "${parsed.protocol.replace(/:$/, "")}" (expected http or https)`,
    );
  }
  const host = assertHostname(parsed.hostname, url);
  return {
    host,
    origin: parsed.origin,
    segments: pathSegments(parsed.pathname),
    rawUrl: raw,
    scp: false,
  };
}

/**
 * gitlab.com and the gitlab-family hosts.
 *
 * The family test is deliberately explicit — a label that IS `gitlab`, starts
 * with `gitlab-`, or sits under `*.gitlab.com` — rather than a substring test,
 * so a look-alike host (`notgitlab.example.com`, `gitlab.evil.example`) does not
 * receive the GitLab credential just because it spells "gitlab" somewhere. A
 * project on such a host is still reachable through its own `/-/` URL or a
 * `.yaml` manifest URL.
 */
function isGitLabHost(host: string): boolean {
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return true;
  const labels = host.split(".");
  return labels.some((label) => label === "gitlab" || label.startsWith("gitlab-"));
}

/**
 * Detect the hosting backend from the URL alone, in this order:
 * `github.com` → github, but ONLY the canonical `owner/repo` project path —
 * exactly two segments, so a pasted web-UI route is not a project; a
 * gitlab-family host → gitlab (nested groups allowed); a `/-/` path segment
 * (GitLab's own project/route separator, present on any self-hosted host) →
 * gitlab; a `.yaml`/`.yml` last segment → http (the URL is the manifest).
 * Anything else is refused: a URL that does not identify its backend is never
 * guessed at or probed.
 */
function detectKind(target: SourceTarget, url: string): SourceKind {
  if (target.host === "github.com") {
    if (target.segments.length === 2) return "github";
    if (target.segments.length < 2) {
      throw invalidUrl(url, "expected a project path like owner/repo");
    }
    throw unrecognizedSource(url);
  }
  if (isGitLabHost(target.host)) return "gitlab";
  if (target.segments.includes("-")) return "gitlab";
  const last = target.segments[target.segments.length - 1];
  if (last !== undefined && YAML_FILE_RE.test(last)) return "http";
  throw unrecognizedSource(url);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** `http(s)://…` as a URL, or `undefined` when the value is relative/not http(s). */
function toHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a role source URL into its kind and coordinates. The kind is detected
 * from the URL alone; a URL that does not identify its backend is refused.
 */
export function parseRegistryUrl(url: string): ParsedRegistryUrl {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      `invalid registry URL "${url}": expected a non-empty http(s) URL or git@host:owner/repo`,
    );
  }

  const target = parseTarget(url);
  // `new URL` silently collapses `/../` while parsing, which would retarget a
  // pasted GitLab web URL without telling anyone. The raw input is checked
  // because the parsed segments no longer show the dot segment. A source URL
  // has no reason to contain one, so it is refused rather than normalised.
  if (/\/\.\.?(\/|$)/.test(target.rawUrl)) {
    throw invalidUrl(url, "the project path contains a '.' or '..' segment");
  }
  const kind = detectKind(target, url);

  if (kind === "http") {
    if (target.scp) {
      throw invalidUrl(url, "a direct manifest source must be an http(s) URL");
    }
    // The URL *is* the manifest — detection only picks `http` for a
    // `.yaml`/`.yml` last segment — so the base is the URL minus that file.
    const cut = target.rawUrl.lastIndexOf("/");
    return {
      kind: "http",
      baseUrl: trimTrailingSlashes(target.rawUrl.slice(0, cut)),
      manifestFile: target.rawUrl.slice(cut + 1),
    };
  }

  // A pasted GitLab web URL carries a UI route after the project path
  // (`…/group/repo/-/tree/main`). `/-/` is GitLab's own project-vs-route
  // separator — the same marker kind detection keys on — so the route is
  // dropped and the coordinates describe the project root. A URL without `/-/`
  // is untouched.
  const route = kind === "gitlab" ? target.segments.indexOf("-") : -1;
  const segments = route === -1 ? target.segments : target.segments.slice(0, route);
  if (segments.length < 2) {
    throw invalidUrl(url, "expected a project path like owner/repo");
  }
  const repo = segments[segments.length - 1].replace(/\.git$/, "");
  if (repo === "") {
    throw invalidUrl(url, "the project path has no repository name");
  }
  const owner = segments.slice(0, -1).join("/");
  const baseUrl = `${target.origin}/${[...segments.slice(0, -1), repo].join("/")}`;
  return { kind, owner, repo, baseUrl };
}

/**
 * The manifest URL of a source. `refOverride` wins over the entry's own `ref`;
 * a git source without either reads DEFAULT_GIT_BRANCH. `http` sources ignore
 * refs entirely.
 */
export function manifestUrlFor(source: RegistrySource, refOverride?: string): string {
  const parsed = parseRegistryUrl(source.url);

  if (parsed.kind === "http") {
    return `${trimTrailingSlashes(parsed.baseUrl)}/${parsed.manifestFile}`;
  }

  const ref = refOverride ?? source.ref ?? DEFAULT_GIT_BRANCH;
  // The ref is one opaque name: encoding it keeps `..`, `?`, `#` or a newline
  // inside the slot it was given instead of letting it rewrite the URL. Both
  // hosts decode it back, so `feature/x` still resolves.
  const encodedRef = encodeURIComponent(ref);
  if (parsed.kind === "github") {
    return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodedRef}/registry.yaml`;
  }
  return `${parsed.baseUrl}/-/raw/${encodedRef}/registry.yaml`;
}

/**
 * Every archive URL to try for a role, in order.
 *
 * `github`/`gitlab` have exactly one candidate (the hosting API/archive path).
 * `http` prefers a manifest-declared `archivePath` — absolute, else resolved
 * against the manifest URL — and otherwise the conventional
 * `<base>/roles/<roleId>@<version>.tar.gz` followed by the versionless
 * `<base>/roles/<roleId>.tar.gz` fallback. The fallback carries no version of
 * its own, so callers must have resolved a version from the manifest before
 * using it (the lock entry records it); an unknown version is rejected rather
 * than silently fetching the versionless URL.
 */
export function archiveUrlCandidates(
  source: RegistrySource,
  roleId: string,
  version: string,
  archivePath?: string,
  refOverride?: string,
): string[] {
  const parsed = parseRegistryUrl(source.url);

  if (parsed.kind === "http") {
    const explicit = archivePath?.trim();
    if (explicit) {
      return [resolveArchiveUrl(explicit, manifestUrlFor(source))];
    }
    const base = trimTrailingSlashes(parsed.baseUrl);
    const encodedRole = encodeURIComponent(roleId);
    const versionless = `${base}/roles/${encodedRole}.tar.gz`;
    // The versionless archive carries no version of its own, so it is only a
    // candidate when a version is already known — from the role spec or the
    // manifest — and can be recorded in the lock file.
    if (version.trim() === "") {
      throw new Error(
        `a version is required to use the versionless archive ${versionless}: the archive name carries no version`,
      );
    }
    return [`${base}/roles/${encodedRole}@${encodeURIComponent(version)}.tar.gz`, versionless];
  }

  const ref = refOverride ?? source.ref ?? DEFAULT_GIT_BRANCH;
  // The ref is one opaque name: encoding it keeps `..`, `?`, `#` or a newline
  // inside the slot it was given instead of letting it rewrite the URL. The
  // GitHub API decodes it back, so `feature/x` still resolves.
  const encodedRef = encodeURIComponent(ref);
  if (parsed.kind === "github") {
    return [`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodedRef}`];
  }
  return [`${parsed.baseUrl}/-/archive/${encodedRef}/${parsed.repo}-${encodedRef}.tar.gz`];
}

/** The preferred archive URL for a role (the first candidate). */
export function archiveUrlFor(
  source: RegistrySource,
  roleId: string,
  version: string,
  archivePath?: string,
  refOverride?: string,
): string {
  return archiveUrlCandidates(source, roleId, version, archivePath, refOverride)[0];
}

/**
 * Resolve a manifest-declared `archive` value into an absolute http(s) URL on
 * the manifest's own origin.
 *
 * The value is untrusted manifest data, so it is validated where it enters:
 * without the origin check a hostile manifest could steer the archive download
 * to any http(s) host — loopback, a private range, a protocol-relative attacker
 * host — while the user only ever configured the manifest's source.
 */
function resolveArchiveUrl(archivePath: string, manifestUrl: string): string {
  const manifest = new URL(manifestUrl);

  let resolved: URL;
  const absolute = toHttpUrl(archivePath);
  if (absolute) {
    resolved = absolute;
  } else {
    try {
      resolved = new URL(archivePath, manifestUrl);
    } catch {
      throw invalidUrl(archivePath, "an archive path must resolve to an http(s) URL");
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      throw invalidUrl(archivePath, "an archive path must resolve to an http(s) URL");
    }
  }

  if (resolved.origin !== manifest.origin) {
    throw new Error(
      `refusing archive path "${archivePath}": a manifest-declared archive must stay on the manifest's own origin (${manifest.origin})`,
    );
  }
  return resolved.toString();
}

/**
 * Default source name for a URL: the project basename (`owner/repo` → `repo`,
 * `.git` stripped) for git sources, else the last path segment of the manifest's
 * base — its hostname (port excluded) when the manifest sits at the root.
 */
export function defaultRegistryName(url: string): string {
  const parsed = parseRegistryUrl(url);
  if (parsed.kind !== "http") return parsed.repo;

  const base = new URL(trimTrailingSlashes(parsed.baseUrl));
  const segments = base.pathname.split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  return last !== undefined ? last : base.hostname;
}
