/**
 * verify-dsh-contract — READ-ONLY drift detector for rolebox's structural dsh
 * mirrors (`Dsh*` interfaces in `src/platform/adapters/dsh/**` and the plugin
 * metadata in `src/dsh-plugin.ts`).
 *
 * rolebox consumes the DeepSeek Harness (dsh) across a structural boundary: it
 * never imports `@deepseek-ai/*` at runtime, so a dsh rename or removal of a
 * mirrored member fails silently until a spawn/route/skill call breaks. This
 * gate re-derives the dsh source member sets from a local checkout and compares
 * them with the `Dsh*` mirrors, mirroring dsh's own `scripts/verify-cordis-config.ts`
 * pattern (`harness-source/package.json` script `verify-cordis-config`).
 *
 * It asserts, per seam:
 *   - tool `ToolDefinition` / `ToolSchema` / `ToolOutputDefinition` members,
 *   - `SkillProvider` / `SkillCandidate` / `SkillDefinition` members,
 *   - `SubagentCapabilities` key set and `SubagentProvider` members,
 *   - `SessionStore` / `Session` methods,
 *   - `SessionEvent` envelope keys,
 *   - the cordis `Plugin.Base.Config` type,
 *   - the `dsh.bundle.patch` row shape,
 *   - the two slot keys (`conversation.input.dock`, `settings.section`).
 *
 * Developer-local by design (decision Q5): it is NOT wired into CI and never
 * vendors or clones dsh. When `DSH_SOURCE_DIR` is unset it prints a notice and
 * exits 0, so CI stays green; when set it reads the checkout read-only and exits
 * non-zero (1) with a per-seam diff on any drift.
 *
 * Usage:
 *   DSH_SOURCE_DIR=/path/to/harness-source bun run scripts/verify-dsh-contract.ts
 */

import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"
import { load as loadYaml } from "js-yaml"

const projectRoot = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd()

// ── Drift ledger ────────────────────────────────────────────────────────────

interface Drift {
  seam: string
  detail: string
}

const drifts: Drift[] = []
let seamCount = 0

function report(seam: string, detail: string): void {
  drifts.push({ seam, detail })
}

function readText(absPath: string): string {
  return readFileSync(absPath, "utf8")
}

function relFrom(root: string, absPath: string): string {
  return relative(root, absPath).replaceAll("\\", "/")
}

// ── Member extraction (TypeScript AST, read-only) ───────────────────────────

type Decl = ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration
type DeclIndex = Map<string, Decl>

interface MemberSet {
  /** Every property, method, and accessor name. */
  all: Set<string>
  /** Method and accessor names only. */
  methods: Set<string>
  /** Property names found anywhere in the declaration subtree (mapped types). */
  deepAll: Set<string>
}

function emptySet(): MemberSet {
  return { all: new Set(), methods: new Set(), deepAll: new Set() }
}

function merge(target: MemberSet, source: MemberSet): void {
  for (const name of source.all) target.all.add(name)
  for (const name of source.methods) target.methods.add(name)
  for (const name of source.deepAll) target.deepAll.add(name)
}

function nameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function entityName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isQualifiedName(node)) return node.right.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

function createSourceFile(absPath: string): ts.SourceFile {
  return ts.createSourceFile(absPath, readText(absPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function buildIndex(files: string[]): DeclIndex {
  const index: DeclIndex = new Map()
  for (const file of files) {
    const sourceFile = createSourceFile(file)
    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        const name = statement.name?.text
        if (name !== undefined) index.set(name, statement)
      }
    }
  }
  return index
}

function hasNonPublicModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return (modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  )
}

function addTypeMember(member: ts.TypeElement, out: MemberSet): void {
  if (ts.isPropertySignature(member)) {
    const name = nameText(member.name)
    if (name !== undefined) out.all.add(name)
    return
  }
  if (ts.isMethodSignature(member)) {
    const name = nameText(member.name)
    if (name !== undefined) {
      out.all.add(name)
      out.methods.add(name)
    }
  }
}

function addClassMember(member: ts.ClassElement, out: MemberSet): void {
  if (ts.isConstructorDeclaration(member) || ts.isIndexSignatureDeclaration(member)) return
  if (hasNonPublicModifier(member)) return
  const name = nameText(member.name)
  if (name === undefined || name.startsWith("#")) return
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    out.all.add(name)
    out.methods.add(name)
  } else if (ts.isPropertyDeclaration(member)) {
    out.all.add(name)
  }
}

function deepPropertyNames(node: ts.Node, out: Set<string>): void {
  if (ts.isPropertySignature(node)) {
    const name = nameText(node.name)
    if (name !== undefined) out.add(name)
  }
  ts.forEachChild(node, (child) => deepPropertyNames(child, out))
}

function collectTypeNode(node: ts.TypeNode, index: DeclIndex, out: MemberSet, seen: Set<string>): void {
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) addTypeMember(member, out)
  } else if (ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) collectTypeNode(part, index, out, seen)
  } else if (ts.isParenthesizedTypeNode(node)) {
    collectTypeNode(node.type, index, out, seen)
  } else if (ts.isTypeReferenceNode(node)) {
    const base = entityName(node.typeName)
    if (base !== undefined && !seen.has(base)) {
      seen.add(base)
      const declaration = index.get(base)
      if (declaration !== undefined) merge(out, collectMembers(declaration, index, seen))
    }
  }
}

function resolveHeritage(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  index: DeclIndex,
  out: MemberSet,
  seen: Set<string>,
): void {
  for (const clause of clauses ?? []) {
    for (const type of clause.types) {
      const base = entityName(type.expression)
      if (base === undefined || seen.has(base)) continue
      seen.add(base)
      const declaration = index.get(base)
      if (declaration !== undefined) merge(out, collectMembers(declaration, index, seen))
    }
  }
}

function collectMembers(node: ts.Node, index: DeclIndex, seen: Set<string> = new Set()): MemberSet {
  const out = emptySet()
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    for (const member of node.members) addTypeMember(member, out)
    if (ts.isInterfaceDeclaration(node)) resolveHeritage(node.heritageClauses, index, out, seen)
  } else if (ts.isClassDeclaration(node)) {
    for (const member of node.members) addClassMember(member, out)
    resolveHeritage(node.heritageClauses, index, out, seen)
  } else if (ts.isTypeAliasDeclaration(node)) {
    collectTypeNode(node.type, index, out, seen)
  }
  deepPropertyNames(node, out.deepAll)
  return out
}

function elementsOf(node: ts.Node): readonly ts.Node[] {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node) || ts.isClassDeclaration(node)) return node.members
  return []
}

function findProperty(node: ts.Node, name: string): ts.PropertySignature | ts.MethodSignature | ts.PropertyDeclaration | ts.MethodDeclaration | undefined {
  for (const member of elementsOf(node)) {
    if (
      (ts.isPropertySignature(member) ||
        ts.isMethodSignature(member) ||
        ts.isPropertyDeclaration(member) ||
        ts.isMethodDeclaration(member)) &&
      nameText(member.name) === name
    ) {
      return member
    }
  }
  return undefined
}

/**
 * Resolve a mirror/source declaration descriptor — a top-level type name, or a
 * dotted property path for an inline object member (e.g.
 * `DshToolDefinition.output`) — to its member set.
 */
function collectFromDesc(desc: string, index: DeclIndex): MemberSet | undefined {
  const parts = desc.split(".")
  const head = index.get(parts[0])
  if (head === undefined) return undefined
  let target: ts.Node = head
  for (let i = 1; i < parts.length; i++) {
    const property = findProperty(target, parts[i])
    if (property === undefined || !("type" in property) || property.type === undefined) return undefined
    target = property.type
  }
  return collectMembers(target, index)
}

// ── Member-set seams ────────────────────────────────────────────────────────

type CompareMode = "subset" | "exact" | "require"

interface MembersSeam {
  id: string
  mirrorFiles: string[]
  mirrorDecl: string
  sourceFiles: string[]
  sourceDecl: string
  mode: CompareMode
  /** Mirror members that are documented rolebox extensions (not dsh vocabulary). */
  allowMirrorOnly?: string[]
  /** Source members legitimately not modelled by the mirror (subset mode ignores them). */
  allowSourceOnly?: string[]
  /** Names that must exist on BOTH sides (require mode). */
  require?: string[]
  /** Compare methods only (the task's `SessionStore` / `Session` methods seam). */
  methodsOnly?: boolean
}

function resolveIndex(files: string[], root: string, seam: string): { index: DeclIndex; resolved: string[] } | undefined {
  const resolved = files.map((file) => resolve(root, file))
  const missing = resolved.filter((file) => !existsSync(file))
  if (missing.length > 0) {
    for (const file of missing) report(seam, `dsh source file not found: ${file}`)
    return undefined
  }
  return { index: buildIndex(resolved), resolved }
}

function checkMembersSeam(seam: MembersSeam, dshRoot: string): void {
  seamCount += 1
  const mirrorRoot = projectRoot
  const mirrorResolved = seam.mirrorFiles.map((file) => resolve(mirrorRoot, file))
  const missingMirror = mirrorResolved.filter((file) => !existsSync(file))
  if (missingMirror.length > 0) {
    for (const file of missingMirror) report(seam.id, `rolebox mirror file not found: ${relFrom(mirrorRoot, file)}`)
    return
  }
  const source = resolveIndex(seam.sourceFiles, dshRoot, seam.id)
  if (source === undefined) return

  const mirrorIndex = buildIndex(mirrorResolved)
  const mirror = collectFromDesc(seam.mirrorDecl, mirrorIndex)
  if (mirror === undefined) {
    report(seam.id, `rolebox mirror declaration not found: ${seam.mirrorDecl}`)
    return
  }
  const sourceSet = collectFromDesc(seam.sourceDecl, source.index)
  if (sourceSet === undefined) {
    report(seam.id, `dsh source declaration not found: ${seam.sourceDecl} in ${seam.sourceFiles.join(", ")}`)
    return
  }

  const mirrorNames = seam.methodsOnly ? mirror.methods : mirror.all
  const sourceNames = seam.methodsOnly ? sourceSet.methods : sourceSet.all
  const sourceLabel = `${seam.sourceDecl} (${seam.sourceFiles.join(", ")})`
  const mirrorLabel = `${seam.mirrorDecl} (${seam.mirrorFiles.join(", ")})`
  const allowMirror = new Set(seam.allowMirrorOnly ?? [])
  const allowSource = new Set(seam.allowSourceOnly ?? [])

  if (seam.mode === "require") {
    const mirrorDeep = new Set([...mirror.all, ...mirror.deepAll])
    const sourceDeep = new Set([...sourceSet.all, ...sourceSet.deepAll])
    for (const name of seam.require ?? []) {
      if (!mirrorDeep.has(name)) report(seam.id, `required member "${name}" missing from rolebox mirror ${mirrorLabel}`)
      if (!sourceDeep.has(name)) report(seam.id, `required member "${name}" missing from dsh ${sourceLabel}`)
    }
    return
  }

  for (const name of mirrorNames) {
    if (sourceNames.has(name) || allowMirror.has(name)) continue
    report(seam.id, `mirror member "${name}" not found in dsh ${sourceLabel} — dsh likely renamed/removed it (mirror: ${mirrorLabel})`)
  }
  if (seam.mode === "exact") {
    for (const name of sourceNames) {
      if (mirrorNames.has(name) || allowSource.has(name)) continue
      report(seam.id, `dsh member "${name}" of ${sourceLabel} is not modelled by mirror ${mirrorLabel}`)
    }
  }
}

// Local relative paths (mirror root = rolebox repo root).
const MIRROR = {
  toolFactory: "src/platform/adapters/dsh/tool-factory.ts",
  skillProvider: "src/platform/adapters/dsh/skill-provider.ts",
  agentRegistrar: "src/platform/adapters/dsh/agent-registrar.ts",
  session: "src/platform/adapters/dsh/session.ts",
  plugin: "src/dsh-plugin.ts",
} as const

// dsh-checkout relative paths (source root = $DSH_SOURCE_DIR).
const DSH = {
  toolsIndex: "packages/core/tools/src/index.ts",
  llmTypes: "packages/llm/llm/src/types.ts",
  skill: "packages/skill/skill/src/index.ts",
  subagent: "packages/subagent/subagent/src/types.ts",
  sessionIndex: "packages/core/session/src/index.ts",
  sessionTypes: "packages/core/session/src/types.ts",
  cordisRegistry: "vendor/cordis/src/registry.ts",
  loaderEntry: "vendor/loader/src/config/entry.ts",
  conversationSlots: "packages/client/ui-conversation/src/client/contract/slots.ts",
  settingsSlots: "packages/client/ui-settings/src/client/contract/slots.ts",
} as const

const MEMBER_SEAMS: MembersSeam[] = [
  {
    id: "tool.ToolDefinition",
    mirrorFiles: [MIRROR.toolFactory],
    mirrorDecl: "DshToolDefinition",
    sourceFiles: [DSH.toolsIndex, DSH.llmTypes],
    sourceDecl: "ToolDefinition",
    mode: "subset",
  },
  {
    id: "tool.ToolOutputDefinition",
    mirrorFiles: [MIRROR.toolFactory],
    mirrorDecl: "DshToolDefinition.output",
    sourceFiles: [DSH.toolsIndex],
    sourceDecl: "ToolOutputDefinition",
    mode: "subset",
  },
  {
    id: "tool.ToolSchema",
    mirrorFiles: [MIRROR.toolFactory],
    mirrorDecl: "DshToolDefinition",
    sourceFiles: [DSH.llmTypes],
    sourceDecl: "ToolSchema",
    mode: "require",
    require: ["name", "description", "parameters"],
  },
  {
    id: "skill.SkillProvider",
    mirrorFiles: [MIRROR.skillProvider],
    mirrorDecl: "DshSkillProviderLike",
    sourceFiles: [DSH.skill],
    sourceDecl: "SkillProvider",
    mode: "subset",
  },
  {
    id: "skill.SkillCandidate",
    mirrorFiles: [MIRROR.skillProvider],
    mirrorDecl: "DshSkillCandidate",
    sourceFiles: [DSH.skill],
    sourceDecl: "SkillCandidate",
    mode: "subset",
  },
  {
    id: "skill.SkillDefinition",
    mirrorFiles: [MIRROR.skillProvider],
    mirrorDecl: "DshSkillDefinition",
    sourceFiles: [DSH.skill],
    sourceDecl: "SkillDefinition",
    mode: "subset",
  },
  {
    id: "subagent.SubagentCapabilities",
    mirrorFiles: [MIRROR.agentRegistrar],
    mirrorDecl: "DshSubagentCapabilities",
    sourceFiles: [DSH.subagent],
    sourceDecl: "SubagentCapabilities",
    mode: "exact",
  },
  {
    id: "subagent.SubagentProvider",
    mirrorFiles: [MIRROR.agentRegistrar],
    mirrorDecl: "DshSubagentProvider",
    sourceFiles: [DSH.subagent],
    sourceDecl: "SubagentProvider",
    mode: "subset",
    allowSourceOnly: ["prepareContinuable"],
  },
  {
    id: "session.SessionStore",
    mirrorFiles: [MIRROR.session],
    mirrorDecl: "DshSessionStoreLike",
    sourceFiles: [DSH.sessionIndex],
    sourceDecl: "SessionStore",
    mode: "subset",
    methodsOnly: true,
  },
  {
    id: "session.Session",
    mirrorFiles: [MIRROR.session],
    mirrorDecl: "DshSessionLike",
    sourceFiles: [DSH.sessionIndex],
    sourceDecl: "Session",
    mode: "subset",
    methodsOnly: true,
  },
  {
    id: "session.SessionEvent",
    mirrorFiles: [MIRROR.session],
    mirrorDecl: "DshSessionEventLike",
    sourceFiles: [DSH.sessionTypes],
    sourceDecl: "SessionEvent",
    mode: "require",
    require: ["type", "seq", "time", "data"],
  },
]

// ── Bespoke seams ───────────────────────────────────────────────────────────

/** The cordis `Plugin.Base.Config` field must stay a `StandardSchemaV1` slot. */
function checkCordisConfig(dshRoot: string): void {
  const seam = "cordis.Plugin.Base.Config"
  seamCount += 1
  const registryPath = resolve(dshRoot, DSH.cordisRegistry)
  if (!existsSync(registryPath)) {
    report(seam, `dsh source file not found: ${DSH.cordisRegistry}`)
    return
  }
  const sourceFile = createSourceFile(registryPath)
  let base: ts.InterfaceDeclaration | undefined
  for (const statement of sourceFile.statements) {
    if (
      ts.isModuleDeclaration(statement) &&
      statement.name.getText(sourceFile) === "Plugin" &&
      statement.body !== undefined &&
      ts.isModuleBlock(statement.body)
    ) {
      for (const inner of statement.body.statements) {
        if (ts.isInterfaceDeclaration(inner) && inner.name.text === "Base") base = inner
      }
    }
  }
  if (base === undefined) {
    report(seam, `Plugin.Base interface not found in dsh ${DSH.cordisRegistry}`)
    return
  }
  const config = base.members.find((member) => ts.isPropertySignature(member) && nameText(member.name) === "Config")
  if (config === undefined || !ts.isPropertySignature(config) || config.type === undefined) {
    report(seam, `Plugin.Base has no Config member in dsh ${DSH.cordisRegistry}`)
    return
  }
  const typeText = config.type.getText(sourceFile)
  if (!typeText.includes("StandardSchemaV1")) {
    report(seam, `dsh Plugin.Base.Config type is "${typeText}", expected a StandardSchemaV1`)
    return
  }

  const pluginPath = resolve(projectRoot, MIRROR.plugin)
  const pluginSource = createSourceFile(pluginPath)
  const exportsConfig = pluginSource.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "Config",
      ),
  )
  if (!exportsConfig) {
    report(seam, `rolebox ${MIRROR.plugin} does not export a Config declaration`)
    return
  }
  if (!/export\s+default\s*\{[\s\S]*?\bConfig\b/.test(pluginSource.getFullText())) {
    report(seam, `rolebox ${MIRROR.plugin} default export does not include Config`)
  }
}

/** The `dsh.bundle.patch` manifest path and every patch row must match dsh's Loader EntryOptions. */
function checkBundlePatch(dshRoot: string): void {
  const seam = "bundle.patch.row"
  seamCount += 1
  let pkg: { dsh?: { bundle?: { patch?: unknown } } }
  try {
    pkg = JSON.parse(readText(resolve(projectRoot, "package.json"))) as typeof pkg
  } catch (error) {
    report(seam, `cannot parse rolebox package.json: ${String(error)}`)
    return
  }
  const patchRel = pkg.dsh?.bundle?.patch
  if (typeof patchRel !== "string") {
    report(seam, "rolebox package.json dsh.bundle.patch is not a string")
    return
  }
  const patchPath = resolve(projectRoot, patchRel)
  if (!existsSync(patchPath)) {
    report(seam, `rolebox dsh.bundle.patch points at a missing file: ${patchRel}`)
    return
  }

  const allowed = new Set(["id", "name", "config", "group", "disabled", "inject", "intercept", "isolate"])
  const entryPath = resolve(dshRoot, DSH.loaderEntry)
  if (existsSync(entryPath)) {
    const entrySource = createSourceFile(entryPath)
    for (const statement of entrySource.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === "EntryOptions") {
        for (const member of statement.members) {
          const name = nameText(member.name)
          if (name !== undefined) allowed.add(name)
        }
      }
    }
  } else {
    report(seam, `dsh Loader entry source not found: ${DSH.loaderEntry}`)
    return
  }

  let document: unknown
  try {
    document = loadYaml(readText(patchPath))
  } catch (error) {
    report(seam, `${patchRel}: invalid YAML: ${String(error)}`)
    return
  }
  if (!Array.isArray(document)) {
    report(seam, `${patchRel}: root must be a Loader entry array`)
    return
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)

  const walk = (rows: unknown[], path: string): void => {
    rows.forEach((row, index) => {
      if (!isRecord(row)) {
        report(seam, `${patchRel}${path}[${index}] is not a Loader entry object`)
        return
      }
      for (const key of Object.keys(row)) {
        if (key === "insert") continue
        if (!allowed.has(key)) {
          report(seam, `${patchRel}${path}[${index}] row key "${key}" is not a dsh EntryOptions member`)
        }
      }
      if (Array.isArray(row.insert)) walk(row.insert, `${path}[${index}].insert`)
    })
  }
  walk(document, "")
}

function extractConstString(sourceFile: ts.SourceFile, name: string): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (declaration.initializer !== undefined && ts.isStringLiteral(declaration.initializer)) {
          return declaration.initializer.text
        }
      }
    }
  }
  return undefined
}

function extractSlotMapKeys(absolutePath: string, interfaceName: string): Set<string> {
  const sourceFile = createSourceFile(absolutePath)
  const keys = new Set<string>()
  const collect = (block: ts.ModuleBlock): void => {
    for (const statement of block.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName) {
        for (const member of statement.members) {
          const name = nameText(member.name)
          if (name !== undefined) keys.add(name)
        }
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isModuleDeclaration(statement) && statement.body !== undefined && ts.isModuleBlock(statement.body)) {
      collect(statement.body)
    }
  }
  return keys
}

/** The two client slot keys rolebox contributes into must stay declared by dsh. */
function checkSlots(dshRoot: string): void {
  const clientPath = resolve(projectRoot, "src/platform/adapters/dsh/web-ui/client.ts")
  if (!existsSync(clientPath)) {
    seamCount += 1
    report("slot.conversation.input.dock", `rolebox client source not found: src/platform/adapters/dsh/web-ui/client.ts`)
    return
  }
  const clientSource = createSourceFile(clientPath)
  const dockName = extractConstString(clientSource, "DOCK_SLOT_NAME")
  const monitorName = extractConstString(clientSource, "MONITOR_SLOT_NAME")

  const seams: Array<{ id: string; roleboxKey: string | undefined; sourceFile: string }> = [
    { id: "slot.conversation.input.dock", roleboxKey: dockName, sourceFile: DSH.conversationSlots },
    { id: "slot.settings.section", roleboxKey: monitorName, sourceFile: DSH.settingsSlots },
  ]

  for (const seam of seams) {
    seamCount += 1
    if (seam.roleboxKey === undefined) {
      report(seam.id, `rolebox constant not found in src/platform/adapters/dsh/web-ui/client.ts`)
      continue
    }
    const absolutePath = resolve(dshRoot, seam.sourceFile)
    if (!existsSync(absolutePath)) {
      report(seam.id, `dsh source file not found: ${seam.sourceFile}`)
      continue
    }
    const keys = extractSlotMapKeys(absolutePath, "SlotMap")
    if (!keys.has(seam.roleboxKey)) {
      report(seam.id, `slot key "${seam.roleboxKey}" is not declared in dsh SlotMap (${seam.sourceFile})`)
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

function dshVersion(dshRoot: string): string {
  const manifestPath = resolve(dshRoot, "package.json")
  if (!existsSync(manifestPath)) return "unknown"
  try {
    const manifest = JSON.parse(readText(manifestPath)) as { version?: string }
    return manifest.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

function run(dshRoot: string): void {
  for (const seam of MEMBER_SEAMS) checkMembersSeam(seam, dshRoot)
  checkCordisConfig(dshRoot)
  checkBundlePatch(dshRoot)
  checkSlots(dshRoot)

  const version = dshVersion(dshRoot)
  if (drifts.length > 0) {
    console.error(`verify-dsh-contract: ${drifts.length} drift finding(s) against ${dshRoot} (dsh ${version}):`)
    for (const drift of drifts) console.error(`  ✗ ${drift.seam}: ${drift.detail}`)
    process.exit(1)
  }
  console.log(`verify-dsh-contract: ${seamCount} seams conform to ${dshRoot} (dsh ${version}).`)
}

if (import.meta.main) {
  const sourceDir = process.env.DSH_SOURCE_DIR?.trim()
  if (!sourceDir) {
    console.log(
      "verify-dsh-contract: skipped — DSH_SOURCE_DIR is not set. " +
        "This is a developer-local dsh conformance drift check (not wired into CI); " +
        "set DSH_SOURCE_DIR to a local harness-source checkout to run it.",
    )
    process.exit(0)
  }
  const dshRoot = resolve(sourceDir)
  if (!existsSync(dshRoot)) {
    console.error(`verify-dsh-contract: DSH_SOURCE_DIR does not exist: ${dshRoot}`)
    process.exit(1)
  }
  run(dshRoot)
}
