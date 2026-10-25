import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createSmokeHost } from "./host.ts";
import { prepareTeamSmokeRoles } from "./roles.ts";
import { verifyTeamSmoke } from "./verify.ts";
import { TeamStore } from "../../src/team/store.ts";
import type { TeamState } from "../../src/team/types.ts";
import { splitModel } from "../../src/platform/model-ref.ts";
import yaml from "js-yaml";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-skill";

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = realpathSync(flag("--root") ?? mkdtempSync(join(tmpdir(), "rolebox-team-live-")));
const workspace = join(root, "workspace");
const phase = flag("--worker");
const modelRequestLimit = 160;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
const save = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value, null, 2), { mode: 0o600 });
const evidence = (value: Record<string, unknown>) => appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ at: Date.now(), phase, ...value }) + "\n", { mode: 0o600 });

function team(): TeamState | undefined {
  if (!existsSync(join(workspace, ".rolebox", "team"))) return undefined;
  const store = new TeamStore(join(workspace, ".rolebox", "team"));
  try { return store.list()[0]; } finally { store.close(); }
}

const brief = `Build a small dependency-free TypeScript status card in this workspace.
This is a bounded collaboration smoke fixture: keep design.json under 40 lines,
card.ts under 120 lines, and preview.html under 80 lines. Use a simple static preview.
The supplied tests and one design review are the acceptance scope; avoid optional
features, extra test harnesses, new build configuration, or a long visual strategy.
Deliver design.json (design tokens and active/paused/blocked labels), card.ts, and preview.html.
card.ts exports renderCard({id,title,status,progress}): string. It must render escaped HTML,
show the status text as well as color, and use role="status". It must render a progressbar
with aria-valuemin="0", aria-valuemax="100", and aria-valuenow clamped to 0..100.
Use design.json as the source of design choices. Do not modify card.test.ts.
Run node --test card.test.ts before declaring implementation complete.
Work only in the current workspace; no dependency installation or external publishing.
The designer owns task 'design' and writes the design artifact, then reviews final preview.
The TypeScript engineer owns task 'implementation' and may use its own internal graph workflow.
Every task must be claimed with team_send_event before its artifacts are written.
Publish design and implementation task_complete events with concrete artifact references.
When design is ready, the engineer implements it; when implementation is ready, the designer
offers/claims/completes task 'review' after reading preview.html and checking the design.
On restart, inspect team_status, existing tasks and files before continuing. Retain existing
task IDs and ownership, avoid duplicate teams, and do not reply to passive acknowledgments.
Each role ends its turn while waiting for the other specialty. Do not delete the team.`;

const fixtureTests = `import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCard } from "./card.ts";
import { readFileSync } from "node:fs";
test("escapes content and includes accessible status", () => {
  const html = renderCard({ id: "one", title: '<script>alert("x")</script>', status: "active", progress: 42 });
  assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;"));
  for (const marker of ['role="status"', 'role="progressbar"', 'aria-valuenow="42"', 'aria-valuemin="0"', 'aria-valuemax="100"']) assert.ok(html.includes(marker));
});
test("clamps progress and renders every state", () => {
  for (const [progress, expected] of [[-5, 0], [120, 100]]) {
    assert.ok(renderCard({ id:"test", title:"Card", status:"paused", progress }).includes('aria-valuenow="' + expected + '"'));
  }
  for (const status of ["active", "paused", "blocked"] as const) assert.ok(renderCard({ id:"test", title:"Card", status, progress:0 }).length > 80);
});
test("design and preview artifacts are available", () => {
  assert.ok(Object.keys(JSON.parse(readFileSync("design.json", "utf8"))).length > 2);
  assert.match(readFileSync("preview.html", "utf8"), /<!doctype html|<html/i);
});
`;

function resultText(result: any): string {
  return (result.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

async function worker() {
  process.chdir(workspace);
  process.env.ROLEBOX_DATA_DIR = join(root, "runtime");
  const manifest = json("roles.json");
  const host = await createSmokeHost({ root });
  if (phase === "first") {
    const overrideModel = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const config = value as Record<string, unknown>;
      config.model = host.modelRoute;
      if (Array.isArray(config.subagents)) for (const child of config.subagents) overrideModel(child);
    };
    const walk = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name === "role.yaml") {
          const config = yaml.load(readFileSync(path, "utf8"));
          overrideModel(config);
          writeFileSync(path, yaml.dump(config), { mode: 0o600 });
        }
      }
    };
    walk(join(root, "roles"));
  }
  const ctx = host.ctx;
  let plugin: Awaited<ReturnType<typeof import("../../src/entries/dsh.ts")["apply"]>> | undefined;
  let owner: any;
  let requests = 0;
  let checkpointing = false;
  const ownerId = "team-live-owner" as SessionId;
  const call = async (name: string, parameters: unknown, agent: any) => ctx.tools.execute({
    name, arguments: parameters, agent, callId: randomUUID() as ToolCallId, signal: new AbortController().signal,
  });
  try {
    ctx.on("llm/stream", async function* (options: any, next: () => AsyncIterable<any>) {
      if (++requests > modelRequestLimit) throw new Error("Live verification request budget exhausted");
      const activeRole = plugin?.getActiveRole(options.sessionId);
      const definition = plugin?.stats.resolvedRoles.find(role => role.id === activeRole);
      const expectedRole = options.sessionId === ownerId ? manifest.engineer.id
        : team()?.members.find(member => member.sessionId === options.sessionId)?.roleId;
      const system = [options.system ?? "", ...(options.messages ?? []).filter((message: any) => message.role === "system")
        .flatMap((message: any) => (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text))].join("\n");
      if (expectedRole) {
        assert.equal(activeRole, expectedRole, "Actual team model request has the wrong active role");
        assert.ok(definition && system.includes(definition.prompt), "Actual model request is missing its active role prompt");
        const foreign = expectedRole === manifest.engineer.id ? manifest.designer : manifest.engineer;
        for (const child of foreign.childIds) assert.ok(!system.includes(child), "Foreign child leaked through a team member system prompt");
      }
      assert.equal(options.provider, host.agentOptions.provider, "Actual model request escaped the configured smoke route");
      assert.equal(options.model, host.agentOptions.model, "Actual model request escaped the configured smoke model");
      evidence({ event: "model_request", sessionId: options.sessionId, request: requests,
        role: expectedRole, rolePromptVerified: Boolean(expectedRole), systemIsolationVerified: Boolean(expectedRole) });
      for await (const chunk of next()) {
        if (chunk.type === "usage") evidence({ event: "usage", sessionId: options.sessionId, usage: chunk.usage });
        yield chunk;
      }
    });
    ctx.on("session/event", (session: any, event: any) => {
      if (["turn/start", "turn/end"].includes(event.type)) evidence({ event: event.type, sessionId: session.id, reason: event.data?.reason?.kind });
    });
    ctx.on("tools/result", (execution: any, result: any) => {
      evidence({ event: "tool", sessionId: execution.agent?.id, tool: execution.name,
        kind: execution.arguments?.kind, taskId: execution.arguments?.task_id, error: result.isError });
    });
    ctx.on("tools/execute", async (execution: any, next: () => Promise<any>) => {
      const result = await next();
      if (phase !== "first" || checkpointing || execution.name !== "team_send_event" ||
        execution.arguments?.kind !== "task_claim" || execution.arguments?.task_id !== "design" || result.isError) return result;
      const current = team();
      const peer = current?.members.find(member => member.sessionId === execution.agent?.id && member.managed);
      if (!current || !peer?.delivery || current.tasks.find(task => task.id === "design")?.owner !== peer.id) return result;
      checkpointing = true;
      assert.equal(await ctx.sessions.flush(execution.agent.session), true, "Claim session was not durably flushed");
      const conflict = await call("team_send_event", { team_id: current.id, kind: "task_claim", task_id: "design", content: "Conflicting claim probe" }, owner.agent);
      assert.match(resultText(conflict), /already claimed/);
      const catalog = resultText(await call("team_list_roles", {}, owner.agent));
      for (const child of manifest.designer.childIds) assert.ok(!catalog.includes(child), "Private child leaked through team catalog");
      const foreign = manifest.designer.childIds[0];
      assert.ok(foreign, "Designer fixture has no private child to test");
      const invited = await call("team_add", { team_id: current.id, role_id: foreign }, owner.agent);
      assert.match(resultText(invited), /top-level|private subroles/);
      const blocked = await call("graph_declare", { declaration: { version: 3, name: "foreign-child-probe", nodes: [{ id: "work", agent: foreign, prompt: "Do not execute this probe", outcomes: [{ id: "done" }] }], edges: [] } }, owner.agent);
      assert.match(resultText(blocked), /not a top-level role or a direct child/);
      const assets = resultText(await call("asset_search", { query: "design", role_id: manifest.designer.id }, owner.agent));
      for (const child of manifest.designer.childIds) assert.ok(!assets.includes(child), "Private child leaked through asset search");
      const nativeSkills = await ctx.skills.list({ cwd: workspace });
      const privateSkills = (role: any): string[] => (role.subagents ?? []).flatMap((child: any) => [
        ...child.skills.map((skill: any) => skill.name), ...privateSkills(child),
      ]);
      for (const role of plugin!.stats.resolvedRoles) for (const name of privateSkills(role)) {
        assert.ok(!nativeSkills.some(skill => skill.provider === "rolebox" && skill.name === name), "Private child leaked through native skill catalog");
        assert.equal(await ctx.skills.get(name, { cwd: workspace }), undefined, "Native skill lookup disclosed a private child skill");
      }
      for (const [ownId, foreignId, actor] of [
        [manifest.engineer.id, manifest.designer.id, owner.agent],
        [manifest.designer.id, manifest.engineer.id, execution.agent],
      ] as const) {
        const ownRole = plugin!.stats.resolvedRoles.find(role => role.id === ownId)!;
        const foreignRole = plugin!.stats.resolvedRoles.find(role => role.id === foreignId)!;
        const ownSkill = ownRole.skills[0]!;
        assert.ok(resultText(await call("load_role_skill", { name: ownSkill.name }, actor)).includes("### Content"), "Role cannot read its own skill");
        const foreignSkill = foreignRole.skills.find(skill => !ownRole.skills.some(own => own.name === skill.name))!;
        assert.ok(foreignSkill, "Isolation fixture requires a distinct peer skill");
        assert.match(resultText(await call("load_role_skill", { name: foreignSkill.name }, actor)), /Skill not found/);
        assert.equal(await ctx.skills.get(foreignSkill.name, { cwd: workspace }), undefined, "Native lookup disclosed a peer workflow body");
      }
      await ctx.sessionPersistence.flush();
      const before = team()!;
      save("before.json", before);
      save("checkpoint.json", { teamId: before.id, killedSessionId: peer.sessionId, killedDeliveryId: peer.delivery.id,
        firstPid: process.pid, claimConflict: true, catalogIsolation: true, invitationIsolation: true,
        graphIsolation: true, assetIsolation: true, nativeSkillIsolation: true, skillBodyIsolation: true });
      evidence({ event: "checkpoint_durable", sessionId: peer.sessionId });
      await new Promise<void>(() => {});
      return result;
    });
    const entry = await import("../../src/entries/dsh.ts");
    plugin = await entry.apply(ctx as unknown as import("../../src/entries/dsh.ts").DshPluginContext, entry.Config.parse({ roleboxDir: join(root, "roles"), defaultRole: manifest.engineer.id,
      computerUse: false, enabledNamespaces: ["team", "graph", "asset_search", "asset_inspect", "load_role_skill", "reference_search"] }));
    assert.equal(plugin.stats.teamWired, true, "Durable DSH team runtime did not wire");
    const role = plugin.stats.resolvedRoles.find(role => role.id === manifest.engineer.id)!;
    const model = splitModel(role.config.model);
    const agentOptions = model ? { provider: model.provider, model: model.id } : host.agentOptions;
    const setup = (_scope: any, agent: any) => { plugin!.activateRole(manifest.engineer.id, agent.id); };
    owner = phase === "resume"
      ? await ctx.agents.resume({ resumeSessionId: ownerId, agentOptions, setup })
      : await ctx.agents.create({ sessionId: ownerId, meta: { cwd: workspace }, agentOptions, setup });
    if (phase === "resume") {
      await pause(1200);
      assert.equal(team()?.status, "paused", "Interrupted team must pause before explicit resumption");
      evidence({ event: "recovered_paused", secondPid: process.pid });
      owner.agent.followup({ id: randomUUID(), role: "user", source: { kind: "user" }, content: [{ type: "text", text:
        `The process was intentionally interrupted during a team claim. Inspect team_status for the existing team, then use team_resume and continue the existing collaboration. Do not create a replacement team. Preserve task ownership and existing artifacts. The original brief remains:\n${brief}` }] });
    } else {
      owner.agent.followup({ id: randomUUID(), role: "user", source: { kind: "user" }, content: [{ type: "text", text:
        `${brief}\nStart with team_create(max_turns=24), team_add(role_id="${manifest.designer.id}"), then offer task_id="design" to that member with this complete brief. Do not claim or implement the design task. End your turn while waiting. Once its design task completes, offer and claim implementation, execute your internal workflow, then notify the designer to review. Include this complete brief in the team goal so the designer receives the same acceptance criteria.` }] });
    }
    let quietSince = 0;
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      await pause(500);
      if (requests > modelRequestLimit) throw new Error("Live verification request budget exhausted");
      const current = team();
      const lastOwnerEvent = owner.agent.session.snapshotEvents().filter((event: any) => event.type === "turn/start" || event.type === "turn/end").at(-1);
      if (!current && lastOwnerEvent?.type === "turn/end" && lastOwnerEvent.data?.reason?.kind !== "completed") {
        throw new Error("Owner model turn failed before creating a team; inspect the local session log");
      }
      if (phase === "resume" && current && ["design", "implementation", "review"].every(id => current.tasks.some(task => task.id === id && task.status === "completed")) &&
        current.members.every(member => !member.delivery && !member.error) && ctx.agents.list().every((agent: any) => agent.status === "idle")) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= 5000) {
          await ctx.sessionPersistence.flush();
          const sessions: Record<string, unknown> = {};
          for (const member of current.members) if (member.sessionId) {
            const handle = await ctx.sessionPersistence.open(member.sessionId as SessionId, "read");
            try { sessions[member.sessionId] = (await handle.read()).events; } finally { await handle.close(); }
          }
          save("after.json", current);
          save("sessions.json", sessions);
          save("finished.json", { secondPid: process.pid, requests, quietMs: Date.now() - quietSince });
          return;
        }
      } else quietSince = 0;
      if (current?.status === "paused" && current.members.some(member => member.error) && phase === "resume" && requests > 5) {
        save("paused.json", current);
        throw new Error("Resumed collaboration paused after a host error; inspect the local state artifact");
      }
    }
    throw new Error("Live collaboration did not finish within its deadline");
  } finally {
    let cleanupFailed = false;
    for (const dispose of [() => plugin?.(), () => owner?.dispose(), () => host.dispose()]) {
      try { await dispose(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error("The live verification host did not dispose cleanly");
  }
}

async function parent() {
  assert.equal(readdirSync(root).length, 0, "Smoke runs require an empty root; prior evidence must not be reused");
  mkdirSync(workspace, { recursive: true });
  const roles = prepareTeamSmokeRoles(root);
  save("roles.json", roles);
  writeFileSync(join(workspace, "BRIEF.md"), brief);
  const fixturePath = join(workspace, "card.test.ts");
  const fixtureBytes = Buffer.from(fixtureTests);
  writeFileSync(fixturePath, fixtureBytes, { flag: "wx", mode: 0o600 });
  const assertFixture = () => assert.ok(readFileSync(fixturePath).equals(fixtureBytes), "The fixed acceptance test was modified");
  type Exit = { code: number | null; signal: NodeJS.Signals | null; spawnError?: boolean; timedOut?: boolean };
  type ControlledChild = {
    child: ReturnType<typeof spawn>;
    completion: Promise<Exit>;
    result?: Exit;
    deadline: number;
    stopped: boolean;
  };
  const children: ControlledChild[] = [];
  let interrupted = false;
  const grouped = process.platform !== "win32";
  const stop = (controlled: ControlledChild) => {
    if (controlled.stopped) return;
    controlled.stopped = true;
    const pid = controlled.child.pid;
    if (grouped && pid) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") controlled.child.kill("SIGKILL"); }
    } else if (controlled.child.exitCode === null && controlled.child.signalCode === null) controlled.child.kill("SIGKILL");
  };
  const interrupt = () => { interrupted = true; for (const child of children) stop(child); };
  const checkInterrupted = () => { if (interrupted) throw new Error("Live verification controller was interrupted"); };
  const run = (command: string[], timeoutMs: number, logFile = "host-private.log", cwd?: string): ControlledChild => {
    checkInterrupted();
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ...command], { cwd, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let complete!: (result: Exit) => void;
    const controlled: ControlledChild = { child, completion: new Promise(resolve => { complete = resolve; }),
      deadline: Date.now() + timeoutMs, stopped: false };
    children.push(controlled);
    child.once("error", () => {
      controlled.result = { code: null, signal: null, spawnError: true };
      stop(controlled);
      if (!child.pid) complete(controlled.result);
    });
    child.once("close", (code, signal) => {
      controlled.result = { code, signal, ...(controlled.result?.spawnError ? { spawnError: true } : {}) };
      stop(controlled);
      complete(controlled.result);
    });
    const log = (data: Buffer) => {
      try { appendFileSync(join(root, logFile), data, { mode: 0o600 }); }
      catch { controlled.result = { code: null, signal: null, spawnError: true }; stop(controlled); }
    };
    child.stdout!.on("data", log);
    child.stderr!.on("data", log);
    return controlled;
  };
  const wait = async (controlled: ControlledChild, description: string): Promise<Exit> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([controlled.completion, new Promise<Exit>(resolve => {
        timer = setTimeout(() => { stop(controlled); resolve({ code: null, signal: null, timedOut: true }); },
          Math.max(1, controlled.deadline - Date.now()));
      })]);
      checkInterrupted();
      assert.ok(!result.timedOut, `${description} exceeded its controller deadline`);
      assert.ok(!result.spawnError, `${description} could not run or persist its diagnostics`);
      return result;
    } finally { clearTimeout(timer); }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const first = run([import.meta.filename, "--root", root, "--worker", "first"], 12 * 60_000);
    while (!existsSync(join(root, "checkpoint.json"))) {
      checkInterrupted();
      if (first.result || first.child.exitCode !== null || first.child.signalCode !== null) throw new Error("Initial host exited before the durable claim checkpoint");
      if (Date.now() > first.deadline) throw new Error("Initial claim checkpoint timed out");
      await pause(500);
    }
    const checkpoint = json("checkpoint.json");
    assert.equal(checkpoint.firstPid, first.child.pid, "Claim checkpoint does not belong to the initial process");
    for (const field of ["claimConflict", "catalogIsolation", "invitationIsolation", "graphIsolation", "assetIsolation", "nativeSkillIsolation", "skillBodyIsolation"]) {
      assert.equal(checkpoint[field], true, "A same-run isolation or claim probe did not pass");
    }
    assertFixture();
    stop(first);
    const exit = await wait(first, "Initial host shutdown");
    assert.equal(exit.signal, "SIGKILL");
    console.log(JSON.stringify({ stage: "claim-persisted-process-killed", probes: "passed" }));
    const second = run([import.meta.filename, "--root", root, "--worker", "resume"], 28 * 60_000);
    const resumedExit = await wait(second, "Resumed host");
    assert.equal(resumedExit.code, 0, "Resumed host did not complete");
    assert.equal(resumedExit.signal, null, "Resumed host did not exit normally");
    const finished = json("finished.json");
    assert.equal(finished.secondPid, second.child.pid, "Finished snapshot does not belong to the resumed process");
    assert.ok(finished.quietMs >= 5000, "Resumed collaboration did not remain quiet for the observation interval");
    const after: TeamState = json("after.json");
    const creator = after.members.find(member => member.sessionId === after.ownerSessionId && member.roleId === roles.engineer.id);
    const designer = after.members.find(member => member.sessionId === checkpoint.killedSessionId && member.roleId === roles.designer.id);
    assert.ok(creator && designer && creator.id !== designer.id, "The expected specialist identities are missing");
    for (const [id, owner] of [["design", designer.id], ["review", designer.id], ["implementation", creator.id]]) {
      assert.equal(after.tasks.find(task => task.id === id)?.owner, owner, "A final task was performed by the wrong specialty");
    }
    const stored = new TeamStore(join(workspace, ".rolebox", "team"));
    try {
      const teams = stored.list();
      assert.equal(teams.length, 1, "The run created a replacement or duplicate team");
      assert.deepEqual(teams[0], after, "The final snapshot does not match durable team storage");
    } finally { stored.close(); }
    const verification = verifyTeamSmoke({ before: json("before.json"), after, sessions: json("sessions.json"),
      killedSessionId: checkpoint.killedSessionId, killedDeliveryId: checkpoint.killedDeliveryId,
      firstPid: checkpoint.firstPid, secondPid: finished.secondPid, signal: exit.signal! });
    const trace = readFileSync(join(root, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const modelRequests = trace.filter(event => event.event === "model_request");
    for (const member of [creator, designer]) {
      const requests = modelRequests.filter(event => event.sessionId === member.sessionId);
      assert.ok(requests.length > 0 && requests.every(event => event.role === member.roleId &&
        event.rolePromptVerified === true && event.systemIsolationVerified === true), "A specialist lacks verified real role-prompt requests");
    }
    assert.ok(trace.some(event => event.event === "tool" && event.tool === "graph_submit_outcome" && !event.error &&
      event.sessionId !== creator.sessionId && event.sessionId !== designer.sessionId), "Own-role graph workers did not complete their work");
    assertFixture();
    const test = run(["--test", "card.test.ts"], 30_000, "artifact-tests.log", workspace);
    const testExit = await wait(test, "Artifact acceptance tests");
    assertFixture();
    assert.equal(testExit.code, 0, "Generated card failed acceptance tests");
    assert.equal(testExit.signal, null, "Artifact acceptance tests did not exit normally");
    save("report.json", { host: "dsh", model: "real configured adapter; isolated role model overrides", roles: [roles.engineer.id, roles.designer.id],
      ...verification, modelRequests: modelRequests.length, rolePromptsVerified: true, ownChildrenUsable: true,
      isolationProbes: 6, rivalClaimRejected: true, processRestart: exit.signal, artifactTests: "passed", quietMs: finished.quietMs });
    console.log(JSON.stringify({ stage: "complete", report: join(root, "report.json") }));
  } finally {
    for (const child of children) stop(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(children.map(child => child.completion)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Controlled child shutdown could not be confirmed")), 5000);
      })]);
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

try { if (phase) await worker(); else await parent(); }
catch (error) {
  save("failure.json", { phase: phase ?? "controller", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+|\/(?:Users|home)\/\S+/g, "[redacted]") : "Live verification failed" });
  console.error("Live verification failed; inspect the local diagnostic artifact.");
  process.exitCode = 1;
}
