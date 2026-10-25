import { setTimeout as sleep } from "node:timers/promises";
import { spawnProcess, sleepSync } from "../../scripts/node-process.ts";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { TeamStore } from "../../src/team/store.ts";
import type { TeamState } from "../../src/team/types.ts";

const roots: string[] = [];
const stores: TeamStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; directory: string; store: TeamStore }> {
  const root = await mkdtemp(join(tmpdir(), "team-store-test-"));
  roots.push(root);
  const directory = join(root, ".rolebox", "team");
  const store = new TeamStore(directory);
  stores.push(store);
  return { root, directory, store };
}

function state(id = "team-one"): TeamState {
  return {
    version: 1, id, name: "Design and engineering", goal: "Improve a screen",
    ownerSessionId: "owner-session", ownerRoleId: "android-lead", platformId: "test",
    status: "active", createdAt: 1, nextSeq: 1, maxTurns: 100, turns: 0,
    members: [{ id: "member-owner", roleId: "android-lead", sessionId: "owner-session", status: "active", managed: false, cursor: 0 }],
    events: [], tasks: [],
  };
}

function withDelivery(id: string, deliveryId: string): TeamState {
  const team = state(id);
  team.members[0]!.delivery = {
    id: deliveryId, throughSeq: 0, startedAt: 1, ownerPid: process.pid, ownerId: "runtime-one", baselineMessageIds: [],
  };
  return team;
}

describe("team store", () => {
  it("persists independent snapshots, enumerates teams, and preserves extension fields after reopening", async () => {
    const { directory, store } = await fixture();
    const source = { ...state(), extension: { revision: 2 } };
    expect(store.list()).toEqual([]);
    store.create(source);
    store.create(state("team-two"));
    source.name = "mutated input";
    source.extension.revision = 3;
    const read = store.read(source.id);
    read.name = "mutated result";
    read.members[0]!.cursor = 10;
    expect(store.read(source.id)).toEqual({ ...state(), extension: { revision: 2 } });
    expect(store.list().map(team => team.id)).toEqual(["team-one", "team-two"]);
    store.close();
    const reopened = new TeamStore(directory);
    stores.push(reopened);
    expect(reopened.update(source.id, team => { team.turns += 1; return team.turns; })).toBe(1);
    expect(reopened.read(source.id)).toEqual({ ...state(), turns: 1, extension: { revision: 2 } });
  });

  it("rolls back callback failures, invalid state changes, and asynchronous callbacks", async () => {
    const { store } = await fixture();
    const original = state();
    store.create(original);
    expect(() => store.update(original.id, team => {
      team.name = "partial mutation";
      throw new Error("callback failed");
    })).toThrow("callback failed");
    expect(store.read(original.id)).toEqual(original);
    expect(() => store.update(original.id, team => { team.id = "another-team"; })).toThrow("corrupt");
    expect(() => store.update(original.id, team => { team.nextSeq = 0; })).toThrow("corrupt");
    expect(() => store.update(original.id, team => {
      team.name = "async mutation";
      return Promise.resolve();
    })).toThrow("synchronous");
    expect(store.read(original.id)).toEqual(original);
    expect(store.update(original.id, team => { team.turns += 1; return "saved"; })).toBe("saved");
    expect(store.read(original.id).turns).toBe(1);
  });

  it("reads the latest committed state through independent connections", async () => {
    const { directory, store } = await fixture();
    store.create(state());
    const other = new TeamStore(directory);
    stores.push(other);
    expect(other.read("team-one").turns).toBe(0);
    store.update("team-one", team => { team.turns += 1; });
    other.update("team-one", team => { team.turns += 1; });
    expect(store.read("team-one").turns).toBe(2);
    store.update("team-one", team => { team.turns += 1; });
    expect(other.read("team-one").turns).toBe(3);
  });

  it("serializes competing processes without losing updates", async () => {
    const { directory, store } = await fixture();
    store.create(state());
    const source = `
      import { TeamStore } from ${JSON.stringify(new URL("../../src/team/store.ts", import.meta.url).href)};
      import { sleepSync } from ${JSON.stringify(new URL("../../scripts/node-process.ts", import.meta.url).href)};
      import { setTimeout as sleep } from "node:timers/promises";
      const store = new TeamStore(${JSON.stringify(directory)});
      try {
        for (let i = 0; i < 30; i++) {
          store.update("team-one", state => {
            const previous = state.turns;
            sleepSync(2);
            state.turns = previous + 1;
          });
        }
      } finally { store.close(); }
    `;
    const children = [0, 1].map(() => spawnProcess([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
    try {
      const results = await Promise.all(children.map(async child => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })));
      expect(results).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
      expect(store.read("team-one").turns).toBe(60);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
    }
  });

  it("serializes session ownership across teams and reclaims only unreferenced delivery leases", async () => {
    const { directory, store } = await fixture();
    store.create(withDelivery("team-one", "delivery-one"));
    const other = new TeamStore(directory);
    stores.push(other);
    other.create(withDelivery("team-two", "delivery-two"));
    const sessionKey = JSON.stringify(["test", "owner-session"]);
    expect(store.acquireSession(sessionKey, "delivery-one")).toBe(true);
    expect(store.acquireSession(sessionKey, "delivery-one")).toBe(true);
    expect(other.acquireSession(sessionKey, "delivery-two")).toBe(false);
    other.releaseSession(sessionKey, "delivery-two");
    expect(other.acquireSession(sessionKey, "delivery-two")).toBe(false);
    store.update("team-one", team => { delete team.members[0]!.delivery; });
    expect(other.acquireSession(sessionKey, "delivery-two")).toBe(true);
    store.releaseSession(sessionKey, "delivery-one");
    expect(store.acquireSession(sessionKey, "delivery-one")).toBe(false);
    other.close();
    const reopened = new TeamStore(directory);
    stores.push(reopened);
    expect(reopened.acquireSession(sessionKey, "delivery-one")).toBe(false);
    reopened.releaseSession(sessionKey, "delivery-two");
    store.update("team-one", team => { team.members[0]!.delivery = withDelivery("team-one", "delivery-one").members[0]!.delivery; });
    expect(store.acquireSession(sessionKey, "delivery-one")).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it("allows only one of two processes to acquire a session shared by two teams", async () => {
    const { directory, store } = await fixture();
    store.create(withDelivery("team-one", "delivery-one"));
    store.create(withDelivery("team-two", "delivery-two"));
    const children = ["delivery-one", "delivery-two"].map(deliveryId => {
      const source = `
        import { TeamStore } from ${JSON.stringify(new URL("../../src/team/store.ts", import.meta.url).href)};
      import { sleepSync } from ${JSON.stringify(new URL("../../scripts/node-process.ts", import.meta.url).href)};
      import { setTimeout as sleep } from "node:timers/promises";
        const store = new TeamStore(${JSON.stringify(directory)});
        try { process.stdout.write(String(store.acquireSession("shared-session", ${JSON.stringify(deliveryId)}))); }
        finally { store.close(); }
      `;
      return spawnProcess([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    });
    try {
      const results = await Promise.all(children.map(async child => ({
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })));
      expect(results.map(result => result.code)).toEqual([0, 0]);
      expect(results.map(result => result.stderr)).toEqual(["", ""]);
      expect(results.map(result => result.stdout).sort()).toEqual(["false", "true"]);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
    }
  });

  it("refuses unknown scheduler versions and preserves existing leases", async () => {
    const { directory, store } = await fixture();
    store.create(withDelivery("team-one", "delivery-one"));
    expect(store.acquireSession("shared-session", "delivery-one")).toBe(true);
    store.close();
    const db = createDatabaseSync(join(directory, "scheduler.sqlite"));
    try { db.exec("PRAGMA user_version = 2"); }
    finally { db.close(); }
    const reopened = new TeamStore(directory);
    stores.push(reopened);
    expect(() => reopened.acquireSession("shared-session", "delivery-two")).toThrow("unsupported");
    const reader = createDatabaseSync(join(directory, "scheduler.sqlite"), { readonly: true });
    try { expect(reader.query("SELECT session_key, delivery_id FROM session_leases").all()).toEqual([{ session_key: "shared-session", delivery_id: "delivery-one" }]); }
    finally { reader.close(); }
  });

  it("keeps membership, pending delivery, event ordering, and task ownership across restart", async () => {
    const { directory, store } = await fixture();
    const team = state();
    team.nextSeq = 3;
    team.members.push({
      id: "member-designer", roleId: "designer", sessionId: "designer-session", status: "active", managed: true,
      cursor: 1, lastTurnId: "turn-previous", delivery: {
        id: "delivery-one", throughSeq: 2, startedAt: 2, ownerPid: process.pid, ownerId: "runtime-one",
        baselineMessageIds: ["old-message"], promptId: "prompt-one",
      },
    });
    team.events = [
      { seq: 1, id: "event-one", type: "member.joined", sender: "member-owner", content: "Designer joined", at: 1, wake: true },
      { seq: 2, id: "event-two", type: "task.offered", sender: "member-owner", content: "Design the screen", taskId: "task-one", at: 2, wake: true },
    ];
    team.tasks = [{ id: "task-one", description: "Design the screen", status: "claimed", owner: "member-designer", leaseUntil: 100 }];
    store.create(team);
    store.close();
    const reopened = new TeamStore(directory);
    stores.push(reopened);
    expect(reopened.read(team.id)).toEqual(team);
  });

  it("publishes complete teams atomically while another process enumerates them", async () => {
    const { directory, store } = await fixture();
    const source = `
      import { TeamStore } from ${JSON.stringify(new URL("../../src/team/store.ts", import.meta.url).href)};
      import { sleepSync } from ${JSON.stringify(new URL("../../scripts/node-process.ts", import.meta.url).href)};
      import { setTimeout as sleep } from "node:timers/promises";
      const store = new TeamStore(${JSON.stringify(directory)});
      const template = ${JSON.stringify(state())};
      try {
        for (let i = 0; i < 30; i++) {
          store.create({ ...template, id: "created-" + i });
          await sleep(1);
        }
      } finally { store.close(); }
    `;
    const child = spawnProcess([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    let done = false;
    const completed = child.exited.then(code => { done = true; return code; });
    try {
      while (!done) {
        for (const team of store.list()) expect(team.name).toBe("Design and engineering");
        await sleep(1);
      }
      expect(await completed).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(store.list()).toHaveLength(30);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("ignores only reserved unpublished creation directories left by interrupted writers", async () => {
    const { directory, store } = await fixture();
    const staging = join(directory, ".team-create-00000000-0000-0000-0000-000000000000");
    mkdirSync(staging);
    writeFileSync(join(staging, "team.sqlite"), "interrupted creation");
    store.create(state());
    expect(store.list()).toEqual([state()]);
    mkdirSync(join(directory, ".team-create-invalid"));
    expect(() => store.list()).toThrow("Invalid team ID");
  });

  it("rejects unsafe IDs and missing teams without creating database files", async () => {
    const { store } = await fixture();
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b", "a.b", "a".repeat(129), "NUL", "name\0"]) {
      expect(() => store.create(state(id))).toThrow("Invalid team ID");
      expect(() => store.read(id)).toThrow("Invalid team ID");
      expect(() => store.update(id, () => {})).toThrow("Invalid team ID");
    }
    expect(() => store.read("missing")).toThrow("not found");
    expect(() => store.update("missing", () => {})).toThrow("not found");
    expect(store.list()).toEqual([]);
  });

  it("refuses existing or incomplete team directories instead of overwriting or hiding them", async () => {
    const { directory, store } = await fixture();
    store.create(state());
    expect(() => store.create(state())).toThrow("already exists");
    expect(store.read("team-one")).toEqual(state());
    mkdirSync(join(directory, "incomplete"));
    expect(() => store.create(state("incomplete"))).toThrow("already exists");
    expect(() => store.read("incomplete")).toThrow("corrupt");
    expect(() => store.list()).toThrow("corrupt");
  });

  it("refuses symbolic links for team directories and databases", async () => {
    const { root, directory, store } = await fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(directory, "linked-team"), "junction");
    expect(() => store.read("linked-team")).toThrow("Unsafe");
    expect(() => store.list()).toThrow("Unsafe");
    mkdirSync(join(directory, "linked-file"));
    writeFileSync(join(outside, "database"), "outside");
    symlinkSync(join(outside, "database"), join(directory, "linked-file", "team.sqlite"));
    expect(() => store.read("linked-file")).toThrow("Unsafe");
  });

  it("rejects malformed or incompatible snapshots on reads, listing, and updates", async () => {
    const { directory, store } = await fixture();
    store.create(state());
    const db = createDatabaseSync(join(directory, "team-one", "team.sqlite"));
    try {
      const variants = [
        "{",
        JSON.stringify({ ...state(), version: 2 }),
        JSON.stringify({ ...state(), members: [{ ...state().members[0], managed: "yes" }] }),
        JSON.stringify({ ...state(), members: [{ ...state().members[0], cursor: 1 }] }),
        JSON.stringify({ ...state(), members: [state().members[0], state().members[0]] }),
        JSON.stringify({ ...state(), members: [{ ...state().members[0], delivery: { id: "pending" } }] }),
        JSON.stringify({ ...state(), turns: null }),
        JSON.stringify({ ...state(), control: { id: "control", ownerPid: 0, ownerId: "runtime" } }),
        JSON.stringify({ ...state(), id: "different-team" }),
        JSON.stringify({ ...state(), tasks: [{ id: "task", description: "Task", status: "unknown" }] }),
        JSON.stringify({ ...state(), nextSeq: 2, events: [{ seq: 1, id: "event", type: "message", sender: "member-owner", content: "hello", at: 1, wake: "yes" }] }),
      ];
      for (const body of variants) {
        db.run("UPDATE team_state SET state = ? WHERE id = 1", body);
        expect(() => store.read("team-one")).toThrow();
        expect(() => store.list()).toThrow();
        let invoked = false;
        expect(() => store.update("team-one", () => { invoked = true; })).toThrow();
        expect(invoked).toBe(false);
        expect(db.query("SELECT state FROM team_state WHERE id = 1").get()).toEqual({ state: body });
      }
      db.run("DELETE FROM team_state WHERE id = 1");
      expect(() => store.read("team-one")).toThrow("corrupt");
      expect(() => store.update("team-one", () => {})).toThrow("corrupt");
    } finally { db.close(); }
  });

  it("rejects invalid database contents and cannot be reused after close", async () => {
    const { directory, store } = await fixture();
    mkdirSync(join(directory, "broken"));
    writeFileSync(join(directory, "broken", "team.sqlite"), "not a SQLite database");
    expect(() => store.read("broken")).toThrow();
    expect(() => store.list()).toThrow();
    expect(() => store.create(state("broken"))).toThrow("already exists");
    store.close();
    store.close();
    expect(() => store.create(state())).toThrow("closed");
    expect(() => store.read("team-one")).toThrow("closed");
    expect(() => store.list()).toThrow("closed");
  });
});
