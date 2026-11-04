import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

const traceFile = process.argv[process.argv.indexOf("--trace-file") + 1];
function trace(event) {
  if (process.argv.includes("--trace-file")) appendFileSync(traceFile, JSON.stringify({ pid: process.pid, ...event }) + "\n");
}
trace({ event: "spawn" });
if (process.argv.includes("--ignore-sigterm")) process.on("SIGTERM", () => trace({ event: "signal", signal: "SIGTERM" }));

const documents = new Map();
const range = { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } };
let buffer = Buffer.alloc(0);
let initialized = false;
let diagnosticsEnabled = false;
let rootUri;
let configure;
const configured = new Promise(resolve => { configure = resolve; });

function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function diagnostics(document) {
  return document.text.includes('"bad"')
    ? [{ range, severity: 1, source: "fixture", message: "Expected a number" }] : [];
}

function publish(uri, document) {
  if (!diagnosticsEnabled || process.argv.includes("--no-diagnostics")) return;
  const publishedUri = uri.replaceAll("&", "%26").replaceAll("+", "%2B").replaceAll("$", "%24")
    .replaceAll(",", "%2C").replaceAll(";", "%3B").replaceAll("=", "%3D").replaceAll("@", "%40");
  setTimeout(() => send({
    method: "textDocument/publishDiagnostics",
    params: { uri: publishedUri, version: document.version, diagnostics: diagnostics(document) },
  }), process.argv.includes("--slow-diagnostics") ? 100 : 30);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method) trace({ event: "rpc", method, id, uri: params?.textDocument?.uri ?? params?.item?.uri,
    diagnostics: params?.context?.diagnostics?.length });
  if (!method) {
    if (id === "configuration") configure();
    return;
  }
  if (method === "initialize") {
    if (process.argv.includes("--hang-initialize")) return;
    if (process.argv.includes("--fail-initialize")) {
      send({ id, error: { code: -32000, message: "Fixture initialization failed" } });
      return;
    }
    rootUri = params.rootUri;
    diagnosticsEnabled = Boolean(params.capabilities.textDocument?.publishDiagnostics);
    setTimeout(() => send({ id, result: { capabilities: {
      textDocumentSync: 1,
      ...(process.argv.includes("--pull-diagnostics") ? { diagnosticProvider: {} } : {}),
      hoverProvider: true, definitionProvider: true, typeDefinitionProvider: true,
      implementationProvider: true, declarationProvider: true, referencesProvider: true,
      documentHighlightProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
      completionProvider: {}, signatureHelpProvider: {}, renameProvider: { prepareProvider: true },
      codeActionProvider: true, documentFormattingProvider: true, documentRangeFormattingProvider: true,
      callHierarchyProvider: true, typeHierarchyProvider: true, foldingRangeProvider: true,
      selectionRangeProvider: true, codeLensProvider: {}, inlayHintProvider: true,
      documentLinkProvider: {}, colorProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: ["variable"], tokenModifiers: [] }, full: true },
    } } }), 30);
    return;
  }
  if (method === "initialized") {
    initialized = true;
    send({ id: "configuration", method: "workspace/configuration", params: { items: [{ section: "fixture" }] } });
    return;
  }
  if (method === "exit") { process.exit(0); }
  if (method === "shutdown") {
    if (!process.argv.includes("--ignore-shutdown")) send({ id, result: null });
    return;
  }
  if (!initialized) {
    if (id !== undefined) send({ id, error: { code: -32002, message: "Not initialized" } });
    return;
  }
  if (method === "textDocument/didOpen") {
    const document = params.textDocument;
    documents.set(document.uri, document);
    publish(document.uri, document);
    return;
  }
  if (method === "textDocument/didChange") {
    const document = { ...params.textDocument, text: params.contentChanges[0].text };
    documents.set(document.uri, document);
    publish(document.uri, document);
    return;
  }
  if (method === "textDocument/didClose") { documents.delete(params.textDocument.uri); return; }
  if (id === undefined) return;
  await configured;
  if (method === "textDocument/hover" && process.argv.includes("--slow-hover")) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const uri = params.textDocument?.uri ?? params.item?.uri ?? pathToFileURL(`${process.cwd()}/index.ts`).href;
  const document = documents.get(uri);
  if (method.startsWith("textDocument/") && !document) {
    send({ id, error: { code: -32602, message: "Document was not opened" } });
    return;
  }
  const item = { name: "answer", kind: 13, uri, range, selectionRange: range };
  if (method === "textDocument/codeAction" && process.argv.includes("--require-diagnostic-context") &&
    !params.context.diagnostics.some(item => item.message === "Expected a number")) {
    send({ id, error: { code: -32602, message: "A fresh diagnostic is required for this quickfix" } });
    return;
  }
  const results = {
    "textDocument/diagnostic": { kind: "full", items: document ? diagnostics(document) : [] },
    "textDocument/hover": { contents: { kind: "plaintext", value: `${rootUri}\n${document?.text}` } },
    "textDocument/definition": [{ uri, range }],
    "textDocument/typeDefinition": [{ uri, range }],
    "textDocument/implementation": [{ uri, range }],
    "textDocument/declaration": [{ uri, range }],
    "textDocument/references": [{ uri, range }],
    "textDocument/documentHighlight": [{ range, kind: 1 }],
    "textDocument/documentSymbol": [item],
    "workspace/symbol": [{ name: "answer", kind: 13, location: { uri, range } }],
    "textDocument/prepareRename": process.argv.includes("--range-rename") ? range : { range, placeholder: "answer" },
    "textDocument/rename": { changes: { [uri]: [{ range, newText: params.newName ?? "renamed" }] } },
    "textDocument/completion": [{ label: "answer", kind: 6 }],
    "textDocument/signatureHelp": { signatures: [{ label: "answer()" }], activeSignature: 0, activeParameter: 0 },
    "textDocument/codeAction": [{ title: "Fixture fix", kind: "quickfix", edit: { changes: { [uri]: [{ range, newText: "fixed" }] } } }],
    "textDocument/formatting": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// formatted\n" }],
    "textDocument/rangeFormatting": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// range formatted\n" }],
    "textDocument/prepareCallHierarchy": [item],
    "textDocument/prepareTypeHierarchy": [item],
    "callHierarchy/incomingCalls": [{ from: item, fromRanges: [range] }],
    "callHierarchy/outgoingCalls": [{ to: item, fromRanges: [range] }],
    "typeHierarchy/supertypes": [item],
    "typeHierarchy/subtypes": [item],
    "textDocument/foldingRange": [{ startLine: 0, endLine: 1 }],
    "textDocument/selectionRange": [{ range }],
    "textDocument/semanticTokens/full": { data: [0, 13, 6, 0, 0] },
    "textDocument/codeLens": [{ range, command: { title: "Fixture lens", command: "fixture.lens" } }],
    "textDocument/inlayHint": [{ position: range.start, label: ": number", kind: 1 }],
    "textDocument/documentLink": [{ range, target: "https://example.com/" }],
    "textDocument/documentColor": [{ range, color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
  };
  if (method in results) send({ id, result: results[method] });
  else send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/)[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
