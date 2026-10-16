/**
 * npm-readme — make npm's copy of the README carry absolute image URLs.
 *
 * GitHub resolves the README against the branch it is read on, so the image
 * `src` values on disk stay repository-relative. npm cannot do that: `npm
 * publish` stores the bytes of README.md as the registry readme, and
 * `@npmcli/package-json` globs {README,README.*} and reads that file —
 * `readmeFilename` is an output field, never an input — so the registry page
 * resolves those relative URLs against npmjs.com and every image 404s.
 *
 * The rewrite therefore happens at pack time:
 *
 *   absolute — every local `<img src="...">` value becomes
 *              https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>,
 *              pinned to the commit being packaged. A path that is not present
 *              in that commit refuses the whole rewrite: the pinned URL must
 *              never point at a file that does not exist in the published tree.
 *   relative — the exact inverse, restoring the branch-relative form.
 *
 * Both modes are idempotent and touch only `src` attribute values. No backup
 * file is kept: the inverse transform is deterministic, so `postpack` needs no
 * state from `prepack`.
 *
 * Usage:
 *   bun run scripts/npm-readme.ts absolute
 *   bun run scripts/npm-readme.ts relative
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

/** GitHub's raw file host; the only host this transform emits. */
export const RAW_HOST = "https://raw.githubusercontent.com"

/** The only origin host whose `<owner>/<repo>` can be pinned to RAW_HOST. */
const SUPPORTED_HOST = "github.com"

/** An `src` attribute with either quote style; group 1 is the attribute prefix. */
const SRC_ATTRIBUTE = /(\bsrc\s*=\s*)(["'])([^"']*)\2/g

/** A repository identity derived from `git remote get-url origin`. */
export interface RepoSlug {
  host: string
  owner: string
  repo: string
}

/** Context for pinning local paths to the commit being published. */
export interface AbsoluteOptions {
  owner: string
  repo: string
  sha: string
  /** Whether `path` is present in the commit the pinned URL will name. */
  exists: (path: string) => boolean
}

/** Context for restoring the branch-relative form. */
export interface RelativeOptions {
  owner: string
  repo: string
}

/** The rewritten markdown plus how many `src` values actually changed. */
export interface RewriteResult {
  content: string
  rewritten: number
}

/** Raised when `absolute` is asked to pin a path absent from the published commit. */
export class MissingLocalImagesError extends Error {
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `refusing to rewrite: ${missing.length} local image src value(s) are not present in the published commit: ${missing.join(", ")}`,
    )
    this.name = "MissingLocalImagesError"
    this.missing = missing
  }
}

/**
 * Derive `<host>/<owner>/<repo>` from a git remote URL. Handles the scp-like
 * form (`git@github.com:owner/repo.git`) and URL forms
 * (`https://github.com/owner/repo.git`, `ssh://git@github.com/owner/repo.git`).
 * Throws instead of guessing when the URL carries no usable `owner/repo`.
 */
export function deriveRepoSlug(remoteUrl: string): RepoSlug {
  const value = remoteUrl.trim()
  let host: string
  let path: string

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    const url = new URL(value)
    host = url.hostname
    path = url.pathname
  } else {
    // scp-like syntax: [user@]host:path — the first colon separates host from path.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
    if (!scp) {
      throw new Error(`cannot derive <owner>/<repo> from remote URL ${JSON.stringify(remoteUrl)}`)
    }
    host = scp[1] as string
    path = scp[2] as string
  }

  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment !== "")
  if (segments.length < 2) {
    throw new Error(`cannot derive <owner>/<repo> from remote URL ${JSON.stringify(remoteUrl)}`)
  }
  return {
    host,
    owner: segments[segments.length - 2] as string,
    repo: segments[segments.length - 1] as string,
  }
}

/** A `src` value is local when it is a repository-relative path, not a URL. */
function isLocalPath(src: string): boolean {
  if (src === "" || src.startsWith("#") || src.startsWith("/")) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)
}

/** `./assets/x.png` and `assets/x.png` name the same repository path. */
function toRepoPath(src: string): string {
  return src.replace(/^\.\//, "")
}

/** Apply `map` to every `src` attribute value; `null` leaves the value alone. */
function rewriteSrcAttributes(markdown: string, map: (src: string) => string | null): RewriteResult {
  let rewritten = 0
  const content = markdown.replace(SRC_ATTRIBUTE, (match, prefix: string, quote: string, src: string) => {
    const next = map(src)
    if (next === null || next === src) return match
    rewritten += 1
    return `${prefix}${quote}${next}${quote}`
  })
  return { content, rewritten }
}

/**
 * Pin every local image `src` to `RAW_HOST/<owner>/<repo>/<sha>/<path>`.
 *
 * Throws `MissingLocalImagesError` — writing nothing — when any referenced path
 * is absent from the published commit. Absolute URLs that are not local paths,
 * including the shields.io badges, are left byte-for-byte alone.
 */
export function absolute(markdown: string, options: AbsoluteOptions): RewriteResult {
  const missing: string[] = []
  const result = rewriteSrcAttributes(markdown, (src) => {
    if (!isLocalPath(src)) return null
    const path = toRepoPath(src)
    if (!options.exists(path)) {
      if (!missing.includes(path)) missing.push(path)
      return null
    }
    return `${RAW_HOST}/${options.owner}/${options.repo}/${options.sha}/${path}`
  })
  // Refuse the whole rewrite rather than emit a partially pinned README: a URL
  // pointing at a path outside the commit is the silent 404 this exists to stop.
  if (missing.length > 0) throw new MissingLocalImagesError(missing)
  return result
}

/**
 * The exact inverse of `absolute`: rewrite this repository's SHA-pinned raw
 * URLs back to repository-relative paths, leaving every other `src` untouched.
 * Any 7–40 character hex revision qualifies, so a README pinned to an earlier
 * commit still round-trips.
 */
export function relative(markdown: string, options: RelativeOptions): RewriteResult {
  const prefix = `${RAW_HOST}/${options.owner}/${options.repo}/`
  return rewriteSrcAttributes(markdown, (src) => {
    if (!src.startsWith(prefix)) return null
    const rest = src.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash <= 0) return null
    const revision = rest.slice(0, slash)
    const path = rest.slice(slash + 1)
    if (path === "" || !/^[0-9a-f]{7,40}$/i.test(revision)) return null
    return path
  })
}

/** Run `git` in `cwd` and return trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** Whether `path` is present in the commit currently checked out in `cwd`. */
function existsInHead(cwd: string, path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${path}`], { cwd, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const USAGE = "usage: bun run scripts/npm-readme.ts <absolute|relative>"

/**
 * CLI entry point. Rewrites `<cwd>/README.md` only when the content changes,
 * prints a one-line summary and returns the process exit code.
 */
export function main(argv: string[], cwd = resolve(import.meta.dir, "..")): number {
  const mode = argv[0]
  if (mode !== "absolute" && mode !== "relative") {
    console.error(
      `npm-readme: expected mode "absolute" or "relative", got ${mode === undefined ? "nothing" : JSON.stringify(mode)}`,
    )
    console.error(USAGE)
    return 2
  }

  const readmePath = resolve(cwd, "README.md")
  const markdown = readFileSync(readmePath, "utf8")

  let slug: RepoSlug
  try {
    slug = deriveRepoSlug(git(cwd, ["remote", "get-url", "origin"]))
  } catch (error) {
    console.error(`npm-readme: cannot determine <owner>/<repo>: ${errorMessage(error)}`)
    return 1
  }
  if (slug.host !== SUPPORTED_HOST) {
    console.error(
      `npm-readme: origin host ${JSON.stringify(slug.host)} is not ${SUPPORTED_HOST}; refusing to guess a raw URL`,
    )
    return 1
  }

  let result: RewriteResult
  try {
    if (mode === "absolute") {
      const sha = git(cwd, ["rev-parse", "HEAD"])
      result = absolute(markdown, { ...slug, sha, exists: (path) => existsInHead(cwd, path) })
    } else {
      result = relative(markdown, slug)
    }
  } catch (error) {
    console.error(`npm-readme: ${errorMessage(error)}`)
    return 1
  }

  const changed = result.content !== markdown
  if (changed) writeFileSync(readmePath, result.content, "utf8")
  console.log(
    `npm-readme: ${mode} — rewrote ${result.rewritten} src value(s); README.md ${changed ? "updated" : "unchanged"}`,
  )
  return 0
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
