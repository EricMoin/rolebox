import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const retired = new Set([
  "src/types.engine-v2", "src/types.graph-v2",
  "src/graph/persistence/engine-persistence", "src/graph/persistence/declared-state", "src/graph/persistence/storage-format",
  "src/graph/tools/persisted-state", "src/graph/tools/status-queries", "src/graph/tools/status-render",
]);
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(path, entry.name)] : []);
}
const violations: string[] = [];
const computed: string[] = [];
let imports = 0;
const sources = files(join(root, "src"));
for (const path of sources) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const check = (specifier: ts.Node | undefined) => {
    if (!specifier) return;
    imports++;
    if (!ts.isStringLiteralLike(specifier)) { computed.push(relative(root, path) + ":" + (source.getLineAndCharacterOfPosition(specifier.pos).line + 1)); return; }
    const text = specifier.text;
    if (!text.startsWith(".")) return;
    const target = relative(root, resolve(dirname(path), text)).replace(/\.[cm]?[jt]sx?$/, "");
    if (retired.has(target)) violations.push(relative(root, path) + " -> " + target);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) check(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
console.log(JSON.stringify({ sourceFiles: sources.length, importSites: imports, retiredDependencies: violations, computedImportsForReview: computed }, null, 2));
if (violations.length) process.exitCode = 1;
