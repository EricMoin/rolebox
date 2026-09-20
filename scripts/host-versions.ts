/**
 * host-versions — keep the platform host packages on their published channel.
 *
 * rolebox consumes three host families as devDependencies:
 *
 *   @opencode-ai/*   @deepseek-ai/*   @earendil-works/*
 *
 * HOST_PACKAGES below is the single source of the policy: one row per tracked
 * package, each with the npm dist-tag ("channel") it follows. A host dependency
 * declared in devDependencies but missing from that table is reported as a
 * policy error — it is never silently ignored.
 *
 * Why the dsh packages track `next`: their `latest` dist-tag still points at the
 * older 0.0.1-rc.1 line, so tracking `latest` would hold rolebox a generation
 * behind. cordis is the mirror case — its `next` tag (4.0.1-rc.4) is OLDER than
 * its `latest` (4.0.2) — so cordis tracks `latest`.
 *
 * check  — resolve each tracked package version (node_modules when the package
 *          is installed, otherwise the exact devDependencies pin) and compare it
 *          with the version at its channel. Exit 1 when any host is behind.
 * update — rewrite the behind devDependencies pins to the channel version, then
 *          run `bun install`, `bun run typecheck` and the event-vocabulary guard
 *          slices, and report the guard verdict. `--dry-run` prints the edits it
 *          would make and runs nothing.
 *
 * Only devDependencies pins are rewritten. peerDependencies ranges (the cordis
 * peer, the opencode and pi peer ranges) are never touched.
 *
 * Environment:
 *   HOST_VERSIONS_REGISTRY_URL — registry base URL (default https://registry.npmjs.org).
 *
 * Exit codes:
 *   0 — every tracked host is current (check), or the plan/upgrade succeeded (update).
 *   1 — check found at least one host behind its channel, or update failed a step.
 *   2 — the policy could not be evaluated (registry error, untracked host, bad arguments).
 *
 * Usage:
 *   bun run check:hosts
 *   bun run update:hosts --dry-run
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ── Policy table ───────────────────────────────────────────────────────────

/** npm dist-tags rolebox is willing to track. */
export type HostChannel = "next" | "latest"

/** One row of the host-version policy. */
export interface HostPackage {
  /** Exact npm package name, as declared in devDependencies. */
  name: string
  /** dist-tag this package follows. */
  channel: HostChannel
}

/**
 * The single source of the host-version policy. Add a row here together with a
 * new host devDependency: check and update read nothing else.
 */
export const HOST_PACKAGES: readonly HostPackage[] = [
  // opencode host — published to `latest`.
  { name: "@opencode-ai/plugin", channel: "latest" },
  // cordis — `latest` (4.0.2) is newer than its `next` tag (4.0.1-rc.4).
  { name: "@deepseek-ai/cordis", channel: "latest" },
  // dsh packages — `next` is the current line; `latest` is the older 0.0.1-rc.1.
  { name: "@deepseek-ai/dsh-client-locale", channel: "next" },
  { name: "@deepseek-ai/dsh-client-ui-conversation", channel: "next" },
  { name: "@deepseek-ai/dsh-client-ui-settings", channel: "next" },
  { name: "@deepseek-ai/dsh-client-ui-slots", channel: "next" },
  { name: "@deepseek-ai/dsh-invariants", channel: "next" },
  { name: "@deepseek-ai/dsh-llm", channel: "next" },
  { name: "@deepseek-ai/dsh-scope", channel: "next" },
  { name: "@deepseek-ai/dsh-session", channel: "next" },
  { name: "@deepseek-ai/dsh-session-persistence", channel: "next" },
  { name: "@deepseek-ai/dsh-skill", channel: "next" },
  { name: "@deepseek-ai/dsh-system-prompt", channel: "next" },
  { name: "@deepseek-ai/dsh-tools", channel: "next" },
  // pi host — published to `latest`.
  { name: "@earendil-works/pi-coding-agent", channel: "latest" },
]

/**
 * Package scopes that are host packages: every devDependency under one of these
 * scopes must also appear in HOST_PACKAGES.
 */
export const HOST_FAMILIES: readonly string[] = [
  "@opencode-ai",
  "@deepseek-ai",
  "@earendil-works",
]

/** Registry base URL used when HOST_VERSIONS_REGISTRY_URL is unset. */
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org"

/** Slices that must stay green for a host bump to count as guard-clean. */
export const VOCABULARY_GUARD_SLICES: readonly string[] = [
  "tests/platform/dsh-event-vocabulary.test.ts",
  "tests/platform/pi-event-vocabulary.test.ts",
  "tests/opencode-liveness-relay.test.ts",
]

// ── Version logic (pure) ───────────────────────────────────────────────────

/**
 * Fully-qualified version shape. Bun.semver.order also accepts loose input such
 * as "1.2" and even a caret range, none of which is a resolved version, so every
 * value is shape-checked before it reaches the comparator.
 */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Whether value is a plain, fully-qualified version. */
export function isValidVersion(value: string): boolean {
  return VERSION_PATTERN.test(value.trim())
}

/**
 * Semver precedence (npm semantics, prereleases included): -1, 0 or 1.
 * Throws when either operand is not a fully-qualified version.
 */
export function compareVersions(left: string, right: string): number {
  if (!isValidVersion(left)) throw new Error("not a version: " + JSON.stringify(left))
  if (!isValidVersion(right)) throw new Error("not a version: " + JSON.stringify(right))
  // Probed on Bun 1.3.14: order() implements SemVer 2.0.0 precedence, including
  // numeric prerelease identifiers (1.0.0-rc.10 > 1.0.0-rc.2), which the dsh
  // prerelease line depends on.
  return Bun.semver.order(left, right)
}

/** How a tracked host version relates to its channel. */
export type HostStatus = "current" | "behind" | "ahead" | "unknown"

/**
 * Classify one host. An unparsable current version counts as "behind": a range
 * such as "^1.3.0" or a missing install can never be proven current. An
 * unparsable channel version means the registry answer is unusable ("unknown").
 */
export function classifyHostStatus(current: string | undefined, channelVersion: string | undefined): HostStatus {
  if (channelVersion === undefined || !isValidVersion(channelVersion)) return "unknown"
  if (current === undefined || !isValidVersion(current)) return "behind"
  const order = compareVersions(current, channelVersion)
  if (order < 0) return "behind"
  if (order > 0) return "ahead"
  return "current"
}

/** The channel HOST_PACKAGES assigns to name, or undefined when untracked. */
export function hostChannelFor(name: string): HostChannel | undefined {
  return HOST_PACKAGES.find((entry) => entry.name === name)?.channel
}

/** Host devDependencies the policy table does not list — a policy error. */
export function findUntrackedHosts(devDependencyNames: readonly string[]): string[] {
  return devDependencyNames.filter(
    (name) => HOST_FAMILIES.some((scope) => name.startsWith(scope + "/")) && hostChannelFor(name) === undefined,
  )
}

// ── devDependencies pin rewriting (pure) ───────────────────────────────────

/** One planned devDependencies rewrite. */
export interface DevDependencyEdit {
  name: string
  from: string
  to: string
}

/** A pin the caller wants set. */
export interface PinTarget {
  name: string
  version: string
}

/**
 * The [open, close] brace range of the object that follows the "<key>" property,
 * or undefined when the property is absent. Braces inside strings are skipped,
 * so a spec containing a brace cannot unbalance the scan.
 */
function objectRangeAfterKey(text: string, key: string): [number, number] | undefined {
  const marker = "\"" + key + "\""
  const keyIndex = text.indexOf(marker)
  if (keyIndex < 0) return undefined
  const open = text.indexOf("{", keyIndex + marker.length)
  if (open < 0) return undefined
  let depth = 0
  let inString = false
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === "\\") {
        index += 1
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
    } else if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) return [open, index]
    }
  }
  return undefined
}

/**
 * Value range [start, end) and current text of the named key inside the slice
 * [open, close) of a JSON object, or undefined when the key is not there.
 */
function findPinValue(text: string, open: number, close: number, name: string): [number, number, string] | undefined {
  const marker = "\"" + name + "\""
  const keyIndex = text.indexOf(marker, open)
  if (keyIndex < 0 || keyIndex >= close) return undefined
  const colon = text.indexOf(":", keyIndex + marker.length)
  if (colon < 0 || colon >= close) return undefined
  const valueStart = text.indexOf("\"", colon + 1)
  if (valueStart < 0 || valueStart >= close) return undefined
  const valueEnd = text.indexOf("\"", valueStart + 1)
  if (valueEnd < 0 || valueEnd >= close) return undefined
  return [valueStart + 1, valueEnd, text.slice(valueStart + 1, valueEnd)]
}

/**
 * Apply the requested pins to the devDependencies object of packageJsonText.
 * Only the version string of each named entry changes: key order, indentation,
 * scripts and peerDependencies keep every byte they had.
 */
export function planDevDependencyPins(
  packageJsonText: string,
  targets: readonly PinTarget[],
): { text: string; edits: DevDependencyEdit[]; missing: string[] } {
  let text = packageJsonText
  const edits: DevDependencyEdit[] = []
  const missing: string[] = []
  for (const target of targets) {
    const range = objectRangeAfterKey(text, "devDependencies")
    if (range === undefined) {
      missing.push(target.name)
      continue
    }
    const [open, close] = range
    const pin = findPinValue(text, open, close, target.name)
    if (pin === undefined) {
      missing.push(target.name)
      continue
    }
    text = text.slice(0, pin[0]) + target.version + text.slice(pin[1])
    edits.push({ name: target.name, from: pin[2], to: target.version })
  }
  return { text, edits, missing }
}

// ── Registry (network) ─────────────────────────────────────────────────────

/** Registry base URL: HOST_VERSIONS_REGISTRY_URL when set, else the public registry. */
export function registryBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.HOST_VERSIONS_REGISTRY_URL?.trim()
  if (configured === undefined || configured === "") return DEFAULT_REGISTRY_URL
  let base = configured
  while (base.endsWith("/")) base = base.slice(0, -1)
  return base === "" ? DEFAULT_REGISTRY_URL : base
}

/** Metadata URL for one package; the scope slash is percent-encoded for the registry. */
export function packageMetadataUrl(name: string, baseUrl: string = DEFAULT_REGISTRY_URL): string {
  return baseUrl + "/" + encodeURIComponent(name)
}

/** dist-tags of one package, straight from the registry metadata document. */
async function fetchDistTags(name: string, baseUrl: string): Promise<Record<string, string>> {
  const url = packageMetadataUrl(name, baseUrl)
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + url)
  const body = (await response.json()) as { "dist-tags"?: Record<string, unknown> }
  const tags = body["dist-tags"]
  if (tags === undefined || tags === null || typeof tags !== "object") {
    throw new Error("no dist-tags in the metadata for " + name)
  }
  const versions: Record<string, string> = {}
  for (const [tag, version] of Object.entries(tags)) {
    if (typeof version === "string") versions[tag] = version
  }
  return versions
}

// ── Host state ─────────────────────────────────────────────────────────────

type CurrentSource = "node_modules" | "package.json"

interface HostRow {
  entry: HostPackage
  /** The version actually resolved for this package. */
  current: string
  source: CurrentSource
  /** Version at the tracked channel, when the registry answered. */
  channelVersion?: string
  status: HostStatus
}

interface HostState {
  packageJsonPath: string
  packageJsonText: string
  rows: HostRow[]
  /** Host devDependencies missing from HOST_PACKAGES. */
  untracked: string[]
  /** Table rows that package.json no longer declares. */
  undeclared: string[]
  /** Per-package registry failures. */
  registryErrors: string[]
}

function readInstalledVersion(name: string, root: string): string | undefined {
  const manifest = resolve(root, "node_modules", ...name.split("/"), "package.json")
  if (!existsSync(manifest)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined
  } catch {
    return undefined
  }
}

async function collectHostState(root: string, registry: string): Promise<HostState> {
  const packageJsonPath = resolve(root, "package.json")
  const packageJsonText = readFileSync(packageJsonPath, "utf8")
  const parsed = JSON.parse(packageJsonText) as { devDependencies?: Record<string, string> }
  const devDependencies = parsed.devDependencies ?? {}
  const isDeclared = (entry: HostPackage): boolean =>
    Object.prototype.hasOwnProperty.call(devDependencies, entry.name)
  const declared = HOST_PACKAGES.filter(isDeclared)
  const undeclared = HOST_PACKAGES.filter((entry) => !isDeclared(entry)).map((entry) => entry.name)
  const untracked = findUntrackedHosts(Object.keys(devDependencies))

  const registryErrors: string[] = []
  const answers = await Promise.all(
    declared.map(async (entry) => {
      try {
        return { entry, tags: await fetchDistTags(entry.name, registry) }
      } catch (error) {
        registryErrors.push(entry.name + ": " + (error instanceof Error ? error.message : String(error)))
        return { entry, tags: undefined }
      }
    }),
  )

  const rows: HostRow[] = answers.map(({ entry, tags }) => {
    const installed = readInstalledVersion(entry.name, root)
    const channelVersion = tags?.[entry.channel]
    const current = installed ?? devDependencies[entry.name] ?? ""
    return {
      entry,
      current,
      source: installed === undefined ? "package.json" : "node_modules",
      channelVersion,
      status: classifyHostStatus(current, channelVersion),
    }
  })

  return { packageJsonPath, packageJsonText, rows, untracked, undeclared, registryErrors }
}

// ── Reporting ──────────────────────────────────────────────────────────────

const TABLE_HEADERS = ["PACKAGE", "CURRENT", "SOURCE", "CHANNEL", "LATEST", "STATUS"] as const

function renderTable(tableRows: readonly (readonly string[])[]): string {
  const widths = TABLE_HEADERS.map((header, column) =>
    Math.max(header.length, ...tableRows.map((row) => (row[column] ?? "").length)),
  )
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()
  const rule = widths.map((width) => "-".repeat(width)).join("  ")
  return [renderRow(TABLE_HEADERS), rule, ...tableRows.map(renderRow)].join("\n")
}

function tableRows(state: HostState): string[][] {
  return state.rows.map((row) => [
    row.entry.name,
    row.current === "" ? "(not resolved)" : row.current,
    row.source,
    row.entry.channel,
    row.channelVersion ?? "(unavailable)",
    row.status,
  ])
}

function policyProblems(state: HostState): string[] {
  const problems: string[] = []
  for (const name of state.untracked) {
    problems.push("untracked host dependency " + name + " — add it to HOST_PACKAGES in scripts/host-versions.ts")
  }
  for (const error of state.registryErrors) {
    problems.push("registry query failed — " + error)
  }
  for (const row of state.rows) {
    if (row.status === "unknown") {
      problems.push("package " + row.entry.name + ": channel \"" + row.entry.channel + "\" did not resolve to a version")
    }
  }
  return problems
}

function printHeader(registry: string): void {
  console.log("host-versions — tracked host packages must follow their published channel")
  console.log("registry: " + registry)
  console.log("policy:   HOST_PACKAGES in scripts/host-versions.ts")
  console.log("")
}

function printProblems(problems: readonly string[]): void {
  console.error("host-versions: the policy could not be evaluated:")
  for (const problem of problems) console.error("  ! " + problem)
}

// ── Modes ──────────────────────────────────────────────────────────────────

async function runCheck(root: string, registry: string): Promise<number> {
  const state = await collectHostState(root, registry)
  const behind = state.rows.filter((row) => row.status === "behind")

  printHeader(registry)
  console.log(renderTable(tableRows(state)))
  console.log("")
  for (const row of state.rows) {
    if (row.status === "ahead") {
      console.log("note: " + row.entry.name + " is ahead of its " + row.entry.channel + " channel (" + row.current + " > " + row.channelVersion + ")")
    }
  }
  for (const name of state.undeclared) {
    console.log("note: " + name + " is in the policy table but not declared in devDependencies")
  }

  const problems = policyProblems(state)
  if (problems.length > 0) {
    printProblems(problems)
    return 2
  }
  if (behind.length === 0) {
    console.log("ok: all " + state.rows.length + " tracked host package(s) are current")
    return 0
  }
  console.log(behind.length + " of " + state.rows.length + " tracked host package(s) are behind:")
  for (const row of behind) {
    console.log("  - " + row.entry.name + "  " + row.current + " -> " + row.channelVersion + "  (" + row.entry.channel + ")")
  }
  console.log("")
  console.log("remedy: bun run update:hosts")
  return 1
}

interface Step {
  label: string
  args: string[]
}

/** The commands an update runs after it rewrites package.json. */
export function upgradeSteps(): Step[] {
  return [
    { label: "bun install", args: ["install"] },
    { label: "bun run typecheck", args: ["run", "typecheck"] },
    {
      label: "bun test --isolate " + VOCABULARY_GUARD_SLICES.join(" "),
      args: ["test", "--isolate", ...VOCABULARY_GUARD_SLICES],
    },
  ]
}

function runStep(step: Step, root: string): boolean {
  console.log("")
  console.log("$ " + step.label)
  const result = spawnSync(process.execPath, step.args, { cwd: root, stdio: "inherit" })
  if (result.error !== undefined) {
    console.error("host-versions: " + step.label + " could not start: " + result.error.message)
    return false
  }
  if (result.status !== 0) {
    console.error("host-versions: " + step.label + " exited with status " + String(result.status))
    return false
  }
  return true
}

async function runUpdate(root: string, registry: string, dryRun: boolean): Promise<number> {
  const state = await collectHostState(root, registry)
  const problems = policyProblems(state)
  if (problems.length > 0) {
    printProblems(problems)
    console.error("host-versions: refusing to update while the policy cannot be evaluated")
    return 2
  }

  const behind = state.rows.filter((row) => row.status === "behind")
  printHeader(registry)
  console.log(renderTable(tableRows(state)))
  console.log("")

  if (behind.length === 0) {
    console.log("ok: every tracked host package is current; nothing to update")
    return 0
  }

  const targets: PinTarget[] = behind.map((row) => ({ name: row.entry.name, version: row.channelVersion ?? "" }))
  const plan = planDevDependencyPins(state.packageJsonText, targets)
  if (plan.missing.length > 0) {
    console.error("host-versions: devDependencies does not declare: " + plan.missing.join(", "))
    return 2
  }

  console.log(plan.edits.length + " devDependencies pin(s) to update:")
  for (const edit of plan.edits) {
    console.log("  package.json  \"" + edit.name + "\": \"" + edit.from + "\" -> \"" + edit.to + "\"")
  }

  if (dryRun) {
    console.log("")
    console.log("dry run: package.json and bun.lock untouched; bun install, typecheck and the guards were not run")
    return 0
  }

  writeFileSync(state.packageJsonPath, plan.text)
  console.log("")
  console.log("wrote " + state.packageJsonPath + " (" + plan.edits.length + " pin(s))")

  const results: string[] = []
  for (const step of upgradeSteps()) {
    const ok = runStep(step, root)
    results.push(step.label + (ok ? " PASS" : " FAIL"))
    if (!ok) {
      console.log("")
      console.log("guard verdict: " + results.join(", "))
      return 1
    }
  }
  console.log("")
  console.log("guard verdict: " + results.join(", "))
  return 0
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  mode?: string
  dryRun: boolean
  unexpected: string[]
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let mode: string | undefined
  let dryRun = false
  const unexpected: string[] = []
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg.startsWith("-")) {
      unexpected.push(arg)
    } else if (mode === undefined) {
      mode = arg
    } else {
      unexpected.push(arg)
    }
  }
  return { mode, dryRun, unexpected }
}

function usage(): void {
  console.error("usage: bun run scripts/host-versions.ts <check|update> [--dry-run]")
  console.error("       bun run check:hosts")
  console.error("       bun run update:hosts [--dry-run]")
}

async function main(argv: readonly string[]): Promise<number> {
  const { mode, dryRun, unexpected } = parseArgs(argv)
  if (unexpected.length > 0) {
    console.error("host-versions: unrecognized argument(s): " + unexpected.join(" "))
    usage()
    return 2
  }
  if (dryRun && mode !== "update") {
    console.error("host-versions: --dry-run is only meaningful with the update mode")
    usage()
    return 2
  }
  const root = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd()
  const registry = registryBaseUrl()
  if (mode === "check") return runCheck(root, registry)
  if (mode === "update") return runUpdate(root, registry, dryRun)
  console.error("host-versions: expected mode \"check\" or \"update\", got " + (mode === undefined ? "nothing" : JSON.stringify(mode)))
  usage()
  return 2
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
