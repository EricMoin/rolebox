import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphView } from "../../src/graph/query/graph-query.ts";

export function assertRestored(workspace: string, graphs: readonly GraphView[]) {
  assert.deepEqual(recoveryManifest(graphs), JSON.parse(readFileSync(join(workspace, "restore-manifest.json"), "utf8")));
}

function recoveryManifest(graphs: readonly GraphView[]) {
  return graphs.map(graph => ({ id: graph.graphId, phase: graph.phase, runs: graph.runs.map(run => ({ id: run.runId, attempts: run.attempts.map(attempt => attempt.attemptId) })) })).sort((a, b) => a.id.localeCompare(b.id));
}

export async function verifyHostProcessRestart(script: string, workspace: string, graphs: readonly GraphView[]) {
  writeFileSync(join(workspace, "restore-manifest.json"), JSON.stringify(recoveryManifest(graphs)));
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, ROLEBOX_SMOKE_RESTORE_ROOT: workspace }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(exit, 0, `Fresh host recovery failed: ${stderr.slice(-2000)}`);
    assert.ok(stdout.includes('"processRecovery":"verified"'), "Fresh host did not verify recovery");
  } finally { clearTimeout(timer); }
}

export async function eventually<T>(read: () => T, accepts: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const value = read();
    if (accepts(value)) return value;
    const graph = value as GraphView | undefined;
    assert.ok(Date.now() < deadline, description + JSON.stringify(graph ? { phase: graph.phase, control: graph.current?.control, unsettled: graph.current?.unsettledEffects.map(effect => ({ kind: effect.kind, status: effect.status })) } : {}));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function approvalPolicy(host: string, approver: string) {
  return JSON.stringify({ id: "smoke-approval", revision: "1", rules: [{ graphId: `${host}.approval`, nodeId: "work", approverSessions: [approver] }] });
}

/** Every call must go through the real host's agent loop and registered tools. */
export async function controlScenarios(options: {
  host: string; workspace: string; approver: string;
  call(tool: string, args: Record<string, unknown>, actor?: "owner" | "other"): Promise<any>;
  read(id: string): GraphView | undefined;
}) {
  const { host, call, read } = options;
  const declare = (suffix: string, prompt = "WAIT_FIXTURE") => call("graph_declare", { declaration: {
    version: 3, name: `${host}.${suffix}`, nodes: [{ id: "work", agent: "smoke--worker", prompt, outcomes: [{ id: "done" }] }], edges: [],
  } });
  const waitStarted = (suffix: string) => eventually(() => read(`${host}.${suffix}`), graph => graph?.current?.attempts[0]?.execution?.state === "created", `No confirmed ${host} ${suffix} worker`);
  const command = (suffix: string, command: string, extra = {}, actor: "owner" | "other" = "owner") => call("graph_control", { graph_id: `${host}.${suffix}`, command, reason: "Host verification", ...extra }, actor);

  await declare("concurrent-one");
  await declare("concurrent-two");
  await Promise.all([waitStarted("concurrent-one"), waitStarted("concurrent-two")]);
  assert.equal((await command("concurrent-one", "cancel", {}, "other")).kind, "refused");
  assert.equal(read(`${host}.concurrent-one`)?.phase, "executing");
  assert.equal((await command("concurrent-one", "cancel")).kind, "applied");
  assert.equal((await command("concurrent-two", "cancel")).kind, "applied");
  assert.equal(read(`${host}.concurrent-one`)?.phase, "stopped");
  assert.equal(read(`${host}.concurrent-two`)?.phase, "stopped");

  await declare("failure", "FAIL_FIXTURE");
  await eventually(() => read(`${host}.failure`), graph => graph?.phase === "stopped", `Failed ${host} worker remained running`);
  assert.equal(read(`${host}.failure`)?.current?.control?.command, "failure");
  const retry = await command("failure", "retry");
  assert.equal(retry.kind, "applied", JSON.stringify(retry.refusals));
  await eventually(() => read(`${host}.failure`), graph => graph?.phase === "complete", `${host} retry did not finish`);
  assert.equal(read(`${host}.failure`)?.runs.length, 2);

  await declare("approval");
  await waitStarted("approval");
  assert.equal((await command("approval", "approval-request", { node_id: "work", approver_session_id: options.approver, expires_at: Date.now() + 60_000 })).kind, "applied");
  assert.equal((await command("approval", "approve", { node_id: "work" })).kind, "refused");
  assert.equal((await command("approval", "approve", { node_id: "work" }, "other")).kind, "applied");
  writeFileSync(join(options.workspace, `${host}.approval.release`), "ready");
  await eventually(() => read(`${host}.approval`), graph => graph?.phase === "complete", `${host} approved worker did not finish`);

  const status = await call("graph_status", { graph_id: `${host}.approval`, scope: "all", format: "json", include_history: true });
  const audit = await call("graph_audit", {});
  assert.deepEqual(status.runs, JSON.parse(JSON.stringify(read(`${host}.approval`)?.runs)));
  assert.deepEqual(audit.entries.find((entry: any) => entry.graphId === `${host}.approval`)?.graph, JSON.parse(JSON.stringify(read(`${host}.approval`))));
  return { concurrentGraphs: true, crossSession: "refused", cancel: "stopped", failure: "stopped", retry: "complete", approval: "complete", queryAgreement: true };
}
