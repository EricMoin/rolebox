import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-tools";
import * as entry from "../../src/entries/dsh.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";
import { graphStoreRoot } from "../../src/graph/store/schema.ts";
import { TeamStore } from "../../src/team/store.ts";
import type { TeamState } from "../../src/team/types.ts";
import { createSmokeHost, type SmokeHost } from "./host.ts";
import type { TeamSmokeRoles } from "./roles.ts";

export interface TeamSmokeIsolationReport {
  version: 1;
  mode: "no-model-post-run";
  passed: boolean;
  modelRequests: number;
  checks: string[];
  failedStage?: string;
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Audit operation timed out: ${label}`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

function readTeam(workspace: string): TeamState {
  assert.ok(existsSync(join(workspace, ".rolebox", "team")), "Completed team storage is missing");
  const store = new TeamStore(join(workspace, ".rolebox", "team"));
  try {
    const teams = store.list();
    assert.equal(teams.length, 1, "Audit requires exactly one completed collaboration");
    return teams[0]!;
  } finally { store.close(); }
}

/** Reopen the persisted host without prompting a model and exercise its registered isolation boundaries. */
export async function runTeamSmokeAudit(directory: string): Promise<TeamSmokeIsolationReport> {
  const root = realpathSync(directory);
  const workspace = realpathSync(join(root, "workspace"));
  const load = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), "utf8")) as T;
  const diagnostic = (value: unknown) => appendFileSync(join(root, "audit-private.log"), `${typeof value === "string" ? value : JSON.stringify(value)}\n`, { mode: 0o600 });
  const report: TeamSmokeIsolationReport = { version: 1, mode: "no-model-post-run", passed: false, modelRequests: 0, checks: [] };
  let stage = "prerequisites";
  let host: SmokeHost | undefined;
  let plugin: entry.DshPluginDisposer | undefined;
  const agents: AgentHandle[] = [];
  const originalDirectory = process.cwd();
  const originalData = process.env.ROLEBOX_DATA_DIR;
  let failure: unknown;
  try {
    const after = load<TeamState>("after.json");
    const finished = load<{ quietMs: number; secondPid: number }>("finished.json");
    const acceptance = load<{ host: string; artifactTests: string; processRestart: string; rolePromptsVerified: boolean; ownChildrenUsable: boolean }>("report.json");
    const roles = load<TeamSmokeRoles>("roles.json");
    assert.ok(acceptance.host === "dsh" && acceptance.artifactTests === "passed" && acceptance.processRestart === "SIGKILL"
      && acceptance.rolePromptsVerified === true && acceptance.ownChildrenUsable === true, "The real run has not passed its acceptance controller");
    assert.ok(Number.isSafeInteger(finished.secondPid) && finished.secondPid > 0, "The resumed host PID is missing");
    let hostExited = false;
    try { process.kill(finished.secondPid, 0); }
    catch (error) { hostExited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    assert.ok(hostExited, "The resumed host must exit before its sessions can be audited");
    assert.ok(finished.quietMs >= 5000, "The real run has no completed quiet observation interval");
    assert.equal(after.status, "active", "The completed team is not active");
    assert.ok(!after.control && after.members.every(member => member.status === "active" && !member.delivery && !member.error), "The team is not settled");
    assert.ok(["design", "implementation", "review"].every(id => after.tasks.some(task => task.id === id && task.status === "completed")), "The real collaboration has unfinished acceptance tasks");
    assert.ok(after.tasks.every(task => task.status === "completed"), "The real collaboration has unfinished extra tasks");
    assert.deepEqual(readTeam(workspace), after, "The supplied final snapshot differs from durable storage");
    for (const member of after.members) {
      assert.ok(!after.events.some(event => event.seq > member.cursor && event.wake && event.sender !== member.id
        && (!event.recipient || event.recipient === member.id)), "Audit would awaken pending collaboration work");
    }
    const owner = after.members.find(member => member.sessionId === after.ownerSessionId && member.roleId === roles.engineer.id);
    const peer = after.members.find(member => member.managed && member.roleId === roles.designer.id);
    assert.ok(owner?.sessionId && peer?.sessionId && owner.sessionId !== peer.sessionId, "Expected peer identities are missing");
    const privateRoleIds = [...roles.engineer.childIds, ...roles.designer.childIds];
    assert.ok(roles.engineer.childIds.length > 0 && roles.designer.childIds.length > 0, "Isolation requires actual private child roles");
    assert.ok(privateRoleIds.every(id => !JSON.stringify(after.events).includes(id)), "The shared team stream disclosed a private child role");
    report.checks.push("completed-run-prerequisites", "shared-events-hide-private-child-identities");

    stage = "host-startup";
    process.chdir(workspace);
    process.env.ROLEBOX_DATA_DIR = join(root, "runtime");
    host = await createSmokeHost({ root });
    const ctx = host.ctx;
    ctx.on("llm/stream", async function* () {
      report.modelRequests++;
      throw new Error("Model requests are forbidden during the post-run isolation audit");
    });
    plugin = await entry.apply(ctx as unknown as entry.DshPluginContext, entry.Config.parse({
      roleboxDir: join(root, "roles"), defaultRole: roles.engineer.id, computerUse: false,
      enabledNamespaces: ["team", "graph", "session", "asset_search", "asset_inspect", "load_role_skill", "reference_search"],
    }));
    for (const member of [owner, peer]) {
      const handle: AgentHandle = await bounded(ctx.agents.resume({ resumeSessionId: member.sessionId as SessionId, agentOptions: host.agentOptions,
        setup: (_scope, agent) => { void plugin!.activateRole(member.roleId, agent.id); } }), "restore settled session");
      agents.push(handle);
      assert.equal(plugin.getActiveRole(handle.agent.id), member.roleId, "The restored agent did not receive its original role");
      assert.equal(handle.agent.status, "idle", "A restored session became active without a prompt");
    }
    const [ownerAgent, peerAgent] = agents;
    assert.ok(ownerAgent && peerAgent);
    await ctx.sessionPersistence.flush();
    const savedSessions = (await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id).sort();
    const baseline = new Map(agents.map(handle => [handle.agent.id, handle.agent.session.snapshotEvents()]));
    const foreignSecrets = new Set([...roles.engineer.childIds]);
    const ownedGraphs = queryGraphs(graphStoreRoot(join(root, "runtime"), workspace), owner.sessionId);
    assert.ok(!ownedGraphs.blocked && ownedGraphs.refused.length === 0, "The creator's graph history is unreadable");
    const privateGraph = ownedGraphs.graphs.find(graph => graph.phase === "complete" && graph.nodes.some(node => roles.engineer.childIds.includes(node.agent)));
    assert.ok(privateGraph, "The real run has no completed private creator graph to test");
    const privateChild = privateGraph.nodes.find(node => roles.engineer.childIds.includes(node.agent))!.agent;
    for (const graph of ownedGraphs.graphs) foreignSecrets.add(graph.graphId);

    const invoke = async (name: string, args: Record<string, unknown>, agent: AgentHandle["agent"]) => {
      const actual = ctx.tools.get(name) ? name : `rb_${name}`;
      assert.ok(ctx.tools.get(actual), "A required registered audit tool is missing");
      const result = await bounded(ctx.tools.execute({ name: actual, arguments: args, agent,
        callId: randomUUID() as ToolCallId, signal: AbortSignal.timeout(15_000) }), name);
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      diagnostic({ stage, name, caller: agent.id, args, result });
      assert.equal(report.modelRequests, 0, "An audit probe tried to contact a model");
      return { text, error: result.isError === true };
    };
    const concealed = (text: string) => {
      assert.ok([...foreignSecrets].every(secret => !text.includes(secret)), "A peer query disclosed a creator graph or private child role");
    };

    stage = "graph-positive";
    const ownStatus = await invoke("graph_status", { graph_id: privateGraph.graphId, format: "json", include_history: true }, ownerAgent.agent);
    assert.ok(!ownStatus.error && ownStatus.text.includes(privateGraph.graphId), "The creator cannot inspect its own persisted graph");
    assert.ok(roles.engineer.childIds.some(id => ownStatus.text.includes(id)), "The graph positive control did not expose its own child role");
    const ownAudit = await invoke("graph_audit", {}, ownerAgent.agent);
    assert.ok(!ownAudit.error && ownAudit.text.includes(privateGraph.graphId), "The creator cannot audit its own persisted graph");
    report.checks.push("creator-can-query-own-private-graph");

    stage = "graph-negative";
    for (const [name, parameters] of [
      ["graph_status", { scope: "all", format: "json", include_history: true, include_output: true }],
      ["graph_audit", {}],
    ] as const) {
      const response = await invoke(name, parameters, peerAgent.agent);
      assert.ok(!response.error, "A peer graph inventory failed before it could enforce visibility");
      JSON.parse(response.text);
      concealed(response.text);
    }
    const targeted = await invoke("graph_status", { graph_id: privateGraph.graphId, scope: "all", format: "json" }, peerAgent.agent);
    assert.match(targeted.text, /Unknown graph in the selected scope/);
    concealed(targeted.text);
    report.checks.push("peer-graph-inventory-hides-creator-work", "peer-targeted-graph-query-refused");

    stage = "session-positive";
    for (const handle of agents) {
      const response = await invoke("session_read", { session_id: handle.agent.id, include_tool_results: true }, handle.agent);
      assert.ok(!response.error && response.text.includes(`ID: ${handle.agent.id}`) && response.text.length > 100,
        "An agent cannot read its own existing session transcript");
    }
    const ownSearch = await invoke("session_search", { query: privateChild, include_tool_output: true, format: "json" }, ownerAgent.agent);
    assert.ok(!ownSearch.error, "The creator cannot search its own session");
    const ownMatches: unknown = JSON.parse(ownSearch.text);
    assert.ok(Array.isArray(ownMatches) && ownMatches.length > 0 && ownMatches.every(match => match.sessionID === ownerAgent.agent.id),
      "The session search positive control did not find the creator's own private child role");
    report.checks.push("both-peers-can-read-own-session", "creator-can-search-own-private-workflow");

    stage = "session-negative";
    for (const [caller, target] of [[peerAgent, ownerAgent], [ownerAgent, peerAgent]]) {
      assert.ok(caller && target);
      const listed = await invoke("session_list", { limit: 100 }, caller.agent);
      assert.ok(!listed.error && listed.text.includes(caller.agent.id)
        && savedSessions.filter(id => id !== caller.agent.id).every(id => !listed.text.includes(id)),
        "Session listing is not restricted to the caller");
      for (const [name, parameters] of [
        ["session_read", { session_id: target.agent.id, include_tool_results: true }],
        ["session_search", { session_id: target.agent.id, query: "design", include_tool_output: true, format: "json" }],
        ["session_info", { session_id: target.agent.id }],
        ["session_diff", { session_id: target.agent.id }],
        ["session_fork", { session_id: target.agent.id }],
      ] as const) {
        const response = await invoke(name, parameters, caller.agent);
        assert.ok(response.error && response.text.includes("Session access denied: DSH session tools may only access the calling session."),
          "A cross-role session operation did not return the expected access denial");
      }
    }
    const searched = await invoke("session_search", { query: privateChild, include_tool_output: true, format: "json" }, peerAgent.agent);
    assert.ok(!searched.error, "The scoped session search failed");
    assert.deepEqual(JSON.parse(searched.text), [], "A peer search found a private creator child role");
    concealed(searched.text);
    report.checks.push("session-list-restricted-to-caller", "foreign-session-read-search-info-diff-fork-refused", "session-search-hides-foreign-history");

    stage = "read-only-verification";
    await ctx.sessionPersistence.flush();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id).sort(), savedSessions,
      "A denied probe created or forked a session");
    for (const handle of agents) {
      assert.deepEqual(handle.agent.session.snapshotEvents(), baseline.get(handle.agent.id), "A read-only probe modified a session log");
      assert.equal(handle.agent.status, "idle", "A read-only probe awakened an agent");
    }
    assert.deepEqual(readTeam(workspace), after, "The audit changed persisted team state");
    assert.equal(report.modelRequests, 0, "The audit attempted a model request");
    report.checks.push("no-session-fork-or-transcript-mutation", "team-state-unchanged", "zero-model-requests");
  } catch (error) {
    failure = error;
    diagnostic(error instanceof Error ? error.stack ?? error.message : String(error));
    report.failedStage = stage;
  } finally {
    const cleanup: Array<() => Promise<unknown>> = [
      async () => { if (plugin) { await plugin(); await plugin.whenDisposed(); } },
      ...agents.reverse().map(handle => () => handle.dispose()),
      async () => { await host?.dispose(); },
    ];
    for (const dispose of cleanup) {
      try { await bounded(dispose(), "cleanup"); }
      catch (error) { diagnostic(error instanceof Error ? error.stack ?? error.message : String(error)); failure ??= error; report.failedStage ??= "cleanup"; }
    }
    process.chdir(originalDirectory);
    if (originalData === undefined) delete process.env.ROLEBOX_DATA_DIR;
    else process.env.ROLEBOX_DATA_DIR = originalData;
    report.passed = failure === undefined && report.modelRequests === 0;
    writeFileSync(join(root, "isolation-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  if (!report.passed) throw new Error(`Post-run isolation audit failed at ${report.failedStage ?? "model-request"}; inspect its private local log`);
  return report;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--root");
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  if (!directory) throw new Error("Post-run audit requires --root pointing to a completed smoke run");
  const root = realpathSync(directory);
  const descriptor = openSync(join(root, "audit-private.log"), "a", 0o600);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const capture = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    writeFileSync(descriptor, typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk);
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  let result: TeamSmokeIsolationReport | undefined;
  try { result = await runTeamSmokeAudit(root); }
  catch { process.exitCode = 1; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; closeSync(descriptor); }
  console.log(JSON.stringify(result ?? { passed: false, mode: "no-model-post-run", diagnostic: "See the private local audit log" }));
  process.exit(result?.passed ? 0 : 1);
}
