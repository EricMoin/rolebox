import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexDesktopLaunch, probeCodexDesktopBridge, type CodexDesktopBinding } from "../../../../../src/platform/adapters/codex/desktop/bridge.ts";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const aborters: AbortController[] = [];
const probes: Promise<unknown>[] = [];
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort();
  await Promise.allSettled(probes.splice(0));
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source = `
import {appendFileSync,renameSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const mode=process.env.BRIDGE_FIXTURE_MODE;
const trace=(value)=>appendFileSync(process.env.BRIDGE_TRACE,JSON.stringify(value)+'\\n');
trace({pid:process.pid,pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH,unexpectedEnv:process.env.BRIDGE_UNFORWARDED});
const send=(message)=>{const text=JSON.stringify(message)+'\\n';process.stdout.write(text.slice(0,5));process.stdout.write(text.slice(5));};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);trace(m);
 if(m.method==='initialize'){
  if(mode==='hang')return;
  if(mode==='invalid'){process.stdout.write('not JSON\\n');return;}
  if(mode==='oversized'){process.stdout.write('x'.repeat(1024*1024+1));return;}
  if(['reject','audit','audit-many','audit-rotate'].includes(mode)){
   if(mode==='audit-many')appendFileSync(process.env.BRIDGE_PEER_LOG,'ignored log entry\\n'.repeat(70000));
   if(mode==='audit-rotate'){renameSync(process.env.BRIDGE_PEER_LOG,process.env.BRIDGE_PEER_LOG+'.old');writeFileSync(process.env.BRIDGE_PEER_LOG,new Date().toISOString()+' warning dynamic_app_tools_peer_rejected reason=other_file\\n');}
   if(mode==='audit'||mode==='audit-many')appendFileSync(process.env.BRIDGE_PEER_LOG,new Date().toISOString()+' warning dynamic_app_tools_peer_rejected reason=untrusted_process\\n');
   send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Desktop app tools pipe closed: /private/example/sensitive-value'}});return;
  }
  if(mode==='interactive')send({jsonrpc:'2.0',id:900,method:'sampling/createMessage',params:{}});
  send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}}}});return;
 }
 if(m.method==='tools/list'){
  if(mode==='cycle'){send({jsonrpc:'2.0',id:m.id,result:{tools:[],nextCursor:'repeat'}});return;}
  if(mode==='pages'&&!m.params.cursor){send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'delete_thread'}],nextCursor:'page2'}});return;}
  send({jsonrpc:'2.0',id:m.id,result:{tools:mode==='no-read'?[]:[{name:'read_thread',inputSchema:{type:'object',properties:{threadId:{type:'string'},turnLimit:{type:'number'},includeOutputs:{type:'boolean'}}}}]}});return;
 }
 if(m.method==='tools/call'){
  send({jsonrpc:'2.0',id:m.id,result:{isError:mode==='tool-error',structuredContent:{thread:{id:mode==='wrong-thread'?'other':m.params.arguments.threadId},...(mode==='large-read'?{padding:'x'.repeat(2*1024*1024)}:{})}}});
 }
});
`;

async function fixture(mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "db-")); roots.push(root);
  const pipePath = join(root, "s");
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
  chmodSync(pipePath, 0o600);
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const pluginRoot = join(root, "p"); mkdirSync(pluginRoot);
  const command = join(pluginRoot, "launch");
  writeFileSync(command, '#!/bin/sh\nexec "$CODEX_MCP_NODE_PATH" "$@"\n', { mode: 0o700 });
  writeFileSync(join(pluginRoot, "server.mjs"), source);
  writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { codex_app: {
    command: "./launch", args: ["./server.mjs"], cwd: ".", env: { BRIDGE_STATIC: "provided" },
    env_vars: ["BRIDGE_FIXTURE_MODE", "BRIDGE_TRACE", "BRIDGE_PEER_LOG"],
    tools: { delete_thread: { approval_mode: "prompt" } },
  } } }));
  const trace = join(root, "trace");
  const peerLogPath = join(root, "desktop.log"); writeFileSync(peerLogPath, "");
  const binding: CodexDesktopBinding = { pluginRoot, nodePath: process.execPath, pipePath };
  const env = { BRIDGE_FIXTURE_MODE: mode, BRIDGE_TRACE: trace, BRIDGE_PEER_LOG: peerLogPath, BRIDGE_UNFORWARDED: "private" };
  const parent = { inspect: vi.fn(async () => ({ available: true, reason: "Loaded parent" })) };
  return { root, binding, env, parent, peerLogPath,
    trace: () => readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    probe: (extra: Partial<Parameters<typeof probeCodexDesktopBridge>[0]> = {}) => {
      const abort = new AbortController(); aborters.push(abort);
      const pending = probeCodexDesktopBridge({ binding, env, parent, threadId: "parent", timeoutMs: 5000, ...extra,
        signal: extra.signal ? AbortSignal.any([abort.signal, extra.signal]) : abort.signal });
      probes.push(pending); return pending;
    },
  };
}

describe.skipIf(process.platform === "win32")("Codex desktop bridge", () => {
  it("injects the explicit binding into the original launcher without inheriting unrelated environment", async () => {
    const f = await fixture();
    const launch = codexDesktopLaunch(f.binding, f.env);
    expect(launch.env.CODEX_APP_TOOLS_PIPE_PATH).toBe(f.binding.pipePath);
    expect(launch.env.CODEX_MCP_NODE_PATH).toBe(process.execPath);
    expect(launch.env.BRIDGE_STATIC).toBe("provided");
    expect(launch.env.BRIDGE_UNFORWARDED).toBeUndefined();
    expect(launch.args).toEqual(["./server.mjs"]);
  });

  it("requires a verified read of the selected chat and forwards supplied host metadata unchanged", async () => {
    const f = await fixture();
    const hostMeta = { threadId: "parent", opaque: { value: "host-provided" } };
    expect(await f.probe({ hostMeta })).toEqual({ status: "ready", stage: "tools/call", code: "verified", toolCount: 1, readOnlyToolVerified: true });
    const trace = f.trace();
    expect(trace.find(item => item.method === "initialize").params.clientInfo.name).toBe("rolebox_desktop_bridge");
    expect(trace.find(item => item.method === "tools/call").params).toEqual({ name: "read_thread", arguments: {
      threadId: "parent", turnLimit: 1, includeOutputs: false,
    }, _meta: hostMeta });
    expect(trace.some(item => item.method?.includes("config") || item.params?.name === "delete_thread")).toBe(false);
    expect(() => process.kill(trace[0].pid, 0)).toThrow();
    expect(f.parent.inspect).toHaveBeenCalledWith("parent");
  });

  it("does not invent metadata when the host has not provided it", async () => {
    const f = await fixture(); await f.probe();
    expect(f.trace().find(item => item.method === "tools/call").params).not.toHaveProperty("_meta");
  });

  it("discovers all pages before choosing the read-only tool", async () => {
    const f = await fixture("pages");
    expect(await f.probe()).toMatchObject({ status: "ready", toolCount: 2 });
    expect(f.trace().filter(item => item.method === "tools/list")).toHaveLength(2);
    expect(f.trace().filter(item => item.method === "tools/call").map(item => item.params.name)).toEqual(["read_thread"]);
  });

  it("refuses a parent not loaded by the selected shared host before starting any child", async () => {
    const f = await fixture(); f.parent.inspect.mockResolvedValue({ available: false, reason: "Not loaded" });
    expect(await f.probe()).toMatchObject({ stage: "parent", code: "parent_unavailable" });
    expect(() => f.trace()).toThrow();
  });

  it("reports an unavailable launcher without leaving a pending child", async () => {
    const f = await fixture(); chmodSync(join(f.binding.pluginRoot, "launch"), 0o600);
    expect(await f.probe()).toMatchObject({ stage: "initialize", code: "process_unavailable" });
  });

  it("does not start a child for an already cancelled probe or invalid deadline", async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    expect(await f.probe({ signal: abort.signal })).toMatchObject({ code: "cancelled" });
    expect(await f.probe({ timeoutMs: 60_001 })).toMatchObject({ code: "invalid_timeout" });
    expect(await f.probe({ maxResponseBytes: 1023 })).toMatchObject({ code: "invalid_response_limit" });
    expect(() => f.trace()).toThrow();
  });

  it("rejects stale, relative, non-socket and permissive pipe bindings", async () => {
    const f = await fixture();
    for (const pipePath of ["relative.sock", join(f.root, "missing"), join(f.binding.pluginRoot, "server.mjs")]) {
      expect(await f.probe({ binding: { ...f.binding, pipePath } })).toMatchObject({ stage: "binding", code: "invalid_binding" });
    }
    chmodSync(f.binding.pipePath, 0o666);
    expect(await f.probe()).toMatchObject({ code: "invalid_binding" });
  });

  it("refuses a non-executable Node binding instead of letting the launcher select a fallback", async () => {
    const f = await fixture(); const nodePath = join(f.root, "node"); writeFileSync(nodePath, "not executable", { mode: 0o600 });
    expect(await f.probe({ binding: { ...f.binding, nodePath } })).toMatchObject({ code: "invalid_binding" });
    expect(() => f.trace()).toThrow();
  });

  it("rejects a manifest launching outside its selected bundle", async () => {
    const f = await fixture();
    writeFileSync(join(f.binding.pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { codex_app: {
      command: process.execPath, args: [], env_vars: [],
    } } }));
    expect(await f.probe()).toMatchObject({ code: "invalid_binding" });
  });

  it("records MCP refusal without leaking server diagnostics or claiming native rejection", async () => {
    const f = await fixture("reject"); const result = await f.probe();
    expect(result).toMatchObject({ status: "blocked", stage: "initialize", code: "ipc_closed", mcpErrorCode: -32603 });
    expect(result.peerRejection).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(JSON.stringify(result)).not.toContain(f.root);
  });

  it("requires a new matching desktop log event before reporting native peer rejection", async () => {
    const f = await fixture("audit");
    expect(await f.probe({ peerLogPath: f.peerLogPath })).toMatchObject({ code: "peer_rejected",
      peerRejection: { reason: "untrusted_process" }, stage: "initialize" });
  });

  it("does not attribute a historical rejection to this attempt", async () => {
    const f = await fixture("reject");
    writeFileSync(f.peerLogPath, "2026-01-01T00:00:00.000Z warning dynamic_app_tools_peer_rejected reason=old_rejection\n");
    expect(await f.probe({ peerLogPath: f.peerLogPath })).toMatchObject({ code: "ipc_closed" });
  });

  it.each(["invalid", "cycle"])("releases a malformed %s peer", async mode => {
    const f = await fixture(mode);
    expect(await f.probe()).toMatchObject({ status: "blocked", code: "invalid_protocol" });
    expect(() => process.kill(f.trace()[0].pid, 0)).toThrow();
  });

  it("accepts a valid read larger than 1 MiB and reports a separately configured response limit", async () => {
    const f = await fixture("large-read");
    expect(await f.probe()).toMatchObject({ status: "ready", code: "verified" });
    expect(await f.probe({ maxResponseBytes: 1024 * 1024 })).toMatchObject({ stage: "tools/call", code: "response_too_large" });
  });

  it("limits an oversized unfinished response without calling it invalid JSON", async () => {
    const f = await fixture("oversized");
    expect(await f.probe({ maxResponseBytes: 1024 * 1024 })).toMatchObject({ stage: "initialize", code: "response_too_large" });
  });

  it("does not mislabel host metadata serialization failures as a closed transport", async () => {
    const f = await fixture(); const hostMeta: Record<string, unknown> = {}; hostMeta.self = hostMeta;
    expect(await f.probe({ hostMeta })).toMatchObject({ stage: "tools/call", code: "invalid_request" });
  });

  it("reads fresh complete peer events beyond one MiB of appended log records", async () => {
    const f = await fixture("audit-many");
    expect(await f.probe({ peerLogPath: f.peerLogPath })).toMatchObject({ code: "peer_rejected" });
  });

  it("does not use a replacement log file as evidence for this probe", async () => {
    const f = await fixture("audit-rotate");
    expect(await f.probe({ peerLogPath: f.peerLogPath })).toMatchObject({ code: "ipc_closed" });
  });

  it("waits for a delayed log flush and the final newline before accepting evidence", async () => {
    const f = await fixture("reject"); let finished = false;
    const pending = f.probe({ peerLogPath: f.peerLogPath }); void pending.then(() => { finished = true; });
    await vi.waitFor(() => expect(f.trace()[0].pid).toBeTypeOf("number"), { timeout: 5000 });
    appendFileSync(f.peerLogPath, '2026-01-01T00:00:00.000Z warning dynamic_app_tools_peer_rejected reason=delayed');
    await new Promise(resolve => setTimeout(resolve, 180)); expect(finished).toBe(false);
    appendFileSync(f.peerLogPath, "\n");
    expect(await pending).toMatchObject({ code: "peer_rejected", peerRejection: { reason: "delayed" } });
  });

  it("denies interactive server requests", async () => {
    const f = await fixture("interactive");
    expect(await f.probe()).toMatchObject({ status: "ready" });
    expect(f.trace().find(item => item.id === 900)).toMatchObject({ error: { code: -32601 } });
  });

  it.each(["wrong-thread", "tool-error"])("does not report a %s read as verified", async mode => {
    const f = await fixture(mode);
    expect(await f.probe()).toMatchObject({ status: "blocked", code: "read_result_unverified", readOnlyToolVerified: false });
  });

  it("does not substitute another available tool when read_thread is absent", async () => {
    const f = await fixture("no-read");
    expect(await f.probe()).toMatchObject({ code: "read_tool_unavailable" });
    expect(f.trace().some(item => item.method === "tools/call")).toBe(false);
  });

  it("times out and reaps a child that never completes initialization", async () => {
    const f = await fixture("hang");
    expect(await f.probe({ timeoutMs: 1000 })).toMatchObject({ status: "blocked", code: "timeout" });
    expect(() => process.kill(f.trace()[0].pid, 0)).toThrow();
  });

  it("cancels an active handshake and reaps its child", async () => {
    const f = await fixture("hang"); const abort = new AbortController();
    const pending = f.probe({ signal: abort.signal });
    await vi.waitFor(() => expect(f.trace()[0].pid).toBeTypeOf("number"), { timeout: 5000 });
    abort.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    expect(() => process.kill(f.trace()[0].pid, 0)).toThrow();
  });
});
