import { spawnProcess } from "../../scripts/node-process.ts";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { DshTeamSessionLease } from "../../src/platform/adapters/dsh/team-session-lease.ts";

const directories: string[] = [];
const leases: DshTeamSessionLease[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-team-lease-test-"));
  directories.push(directory);
  const create = () => {
    const lease = new DshTeamSessionLease(directory);
    leases.push(lease);
    return lease;
  };
  return { directory, create };
}

describe("DSH team session ownership", () => {
  it("keeps live ownership exclusive and fences release by the owning instance", async () => {
    const { create } = await fixture();
    const first = create();
    const second = create();
    expect(first.acquire("peer")).toBe(true);
    expect(first.acquire("peer")).toBe(true);
    expect(first.isOwnedElsewhere("peer")).toBe(false);
    expect(second.isOwnedElsewhere("peer")).toBe(true);
    expect(second.acquire("peer")).toBe(false);
    second.release("peer");
    expect(second.acquire("peer")).toBe(false);
    first.release("peer");
    expect(second.acquire("peer")).toBe(true);
    first.release("peer");
    expect(first.acquire("peer")).toBe(false);
  });

  it("releases all sessions on disposal without releasing another owner's sessions", async () => {
    const { create } = await fixture();
    const first = create();
    const second = create();
    first.acquire("one");
    first.acquire("two");
    second.acquire("three");
    first.dispose();
    first.dispose();
    expect(second.acquire("one")).toBe(true);
    expect(second.acquire("two")).toBe(true);
    const third = create();
    expect(third.isOwnedElsewhere("three")).toBe(true);
    expect(() => first.acquire("one")).toThrow("closed");
  });

  it("reclaims a stale owner token from the same process", async () => {
    const { directory, create } = await fixture();
    const first = create();
    const db = createDatabaseSync(join(directory, ".rolebox", "team-sessions", "leases.sqlite"));
    try { db.run("INSERT INTO peer_leases (session_id, owner_pid, owner_id) VALUES (?, ?, ?)", "peer", process.pid, "retired-owner"); }
    finally { db.close(); }
    expect(first.isOwnedElsewhere("peer")).toBe(false);
    expect(first.acquire("peer")).toBe(true);
    expect(create().acquire("peer")).toBe(false);
  });

  it("holds ownership across processes and reclaims it only after the owner exits", async () => {
    const { directory, create } = await fixture();
    const observer = create();
    const source = `
      import { DshTeamSessionLease } from ${JSON.stringify(new URL("../../src/platform/adapters/dsh/team-session-lease.ts", import.meta.url).href)};
      const lease = new DshTeamSessionLease(${JSON.stringify(directory)});
      if (!lease.acquire("peer")) process.exit(1);
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `;
    const child = spawnProcess([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready"); }
      finally { reader.releaseLock(); }
      expect(observer.isOwnedElsewhere("peer")).toBe(true);
      expect(observer.acquire("peer")).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(observer.isOwnedElsewhere("peer")).toBe(false);
    expect(observer.acquire("peer")).toBe(true);
  });

  it("refuses unknown schemas and corrupt ownership data", async () => {
    const { directory, create } = await fixture();
    const lease = create();
    const db = createDatabaseSync(join(directory, ".rolebox", "team-sessions", "leases.sqlite"));
    try {
      db.run("INSERT INTO peer_leases (session_id, owner_pid, owner_id) VALUES (?, ?, ?)", "peer", 0, "invalid");
      expect(() => lease.acquire("peer")).toThrow("corrupt");
      expect(() => lease.isOwnedElsewhere("peer")).toThrow("corrupt");
      db.exec("PRAGMA user_version = 2");
      expect(() => create()).toThrow("unsupported");
    } finally { db.close(); }
  });
});
