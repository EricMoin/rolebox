import { describe, expect, it } from "bun:test";
import { createDshSessionTools, DSH_SESSION_ACCESS_DENIED, scopeDshSessionClient } from "../../src/platform/adapters/dsh/session-visibility.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { CanonicalToolContext, Message, SessionInfo } from "../../src/platform/types.ts";

const directory = "/workspace";
const context = (sessionID: string): CanonicalToolContext => ({ sessionID, messageID: "call", agent: "designer", directory,
  worktree: directory, abort: new AbortController().signal, metadata() {}, ask: async () => {} });

function fixture() {
  const calls: Array<{ method: string; id?: string }> = [];
  const sessions: SessionInfo[] = ["owner", "peer", "private-worker"].map(id => ({ id, projectID: directory, directory,
    title: `${id} title`, version: "1", time: { created: 1, updated: 2 }, ...(id === "owner" ? {} : { parentID: "owner" }) }));
  const get = (id: string) => sessions.find(session => session.id === id) ?? null;
  const message = (id: string): Message => ({ info: { id: `${id}-message`, sessionID: id, role: "assistant", time: { created: 2 } },
    parts: [{ id: `${id}-text`, sessionID: id, messageID: `${id}-message`, type: "text",
      text: id === "owner" ? "graph_declare private worker detail" : `${id} visible message` }] });
  const client: ISessionClient = {
    async list() { calls.push({ method: "list" }); return sessions; },
    async get(id) { calls.push({ method: "get", id }); await Promise.resolve(); return get(id); },
    async messages(id) { calls.push({ method: "messages", id }); return get(id) ? [message(id)] : []; },
    async children(id) { calls.push({ method: "children", id }); return sessions.filter(session => session.parentID === id); },
    async todo(id) { calls.push({ method: "todo", id }); return [{ id: "task", content: `${id} todo`, status: "pending", priority: "medium" }]; },
    async diff(id) { calls.push({ method: "diff", id }); return [{ file: `${id}.ts`, before: "old", after: `${id} change`, additions: 1, deletions: 1 }]; },
    async fork(id) { calls.push({ method: "fork", id }); const original = get(id); return original ? { ...original, id: `${id}-fork`, parentID: id } : null; },
    async status(id) { calls.push({ method: "status", id }); return { type: "idle" }; },
    async prompt(id) { calls.push({ method: "prompt", id }); return { id: "sent" }; },
    async promptSync(id) { calls.push({ method: "promptSync", id }); return { parts: [{ type: "text", text: "sent" }] }; },
    async create() { calls.push({ method: "create" }); return null; },
    async abort(id) { calls.push({ method: "abort", id }); return true; },
    async compact(id) { calls.push({ method: "compact", id }); return true; },
  };
  const tools = createDshSessionTools(client);
  const invoke = async (name: string, input: Record<string, unknown>, caller = "peer") => tools[name]!.execute(input, context(caller));
  return { client, calls, invoke };
}

describe("DSH session tool visibility", () => {
  it("lists and searches only the caller without enumerating the workspace", async () => {
    const f = fixture();
    const list = String(await f.invoke("session_list", { limit: 20 }));
    expect(list).toContain("peer title");
    expect(list).not.toContain("owner title");
    expect(list).not.toContain("private-worker");
    expect(await f.invoke("session_search", { query: "private worker", format: "json", include_tool_output: true })).toBe("[]");
    expect(JSON.parse(String(await f.invoke("session_search", { query: "visible", format: "json" }))))
      .toMatchObject([{ sessionID: "peer", text: "visible" }]);
    expect(f.calls.every(call => call.id === "peer")).toBe(true);
    expect(await f.invoke("session_list", { project_path: "/another-workspace" })).toBe("No sessions found.");
  });

  it("refuses creator, peer and graph child transcripts regardless of parent metadata or claimed role", async () => {
    for (const [caller, target] of [["peer", "owner"], ["owner", "peer"], ["peer", "private-worker"], ["owner", "private-worker"]]) {
      const f = fixture();
      for (const name of ["session_read", "session_search", "session_info", "session_diff", "session_fork"]) {
        await expect(f.invoke(name, { session_id: target, query: "private", agent: "owner", sessionID: target }, caller))
          .rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
      }
      expect(f.calls).toEqual([]);
    }
  });

  it("retains own reads, analytics, diffs and forks without exposing parent identifiers", async () => {
    const f = fixture();
    expect(String(await f.invoke("session_read", { session_id: "peer", include_todos: true }))).toContain("peer visible message");
    const info = String(await f.invoke("session_info", { session_id: "peer" }));
    expect(info).toContain("peer title");
    expect(info).not.toContain("Parent Session");
    expect(String(await f.invoke("session_diff", { session_id: "peer" }))).toContain("peer.ts");
    expect(String(await f.invoke("session_fork", { session_id: "peer" }))).toContain("peer-fork");
    expect(f.calls.every(call => call.id === "peer")).toBe(true);
  });

  it("isolates concurrent calls and rejects tools without trusted session context", async () => {
    const f = fixture();
    const [owner, peer] = await Promise.all([
      f.invoke("session_search", { query: "private", format: "json" }, "owner"),
      f.invoke("session_search", { query: "private", format: "json" }, "peer"),
    ]);
    expect(JSON.parse(String(owner))).toMatchObject([{ sessionID: "owner", text: "private" }]);
    expect(peer).toBe("[]");
    await expect(f.invoke("session_list", {}, "")).rejects.toThrow("trusted calling session");
  });

  it("keeps administrative clients unrestricted and guards every scoped target operation", async () => {
    const f = fixture();
    expect(await f.client.list()).toHaveLength(3);
    expect(await f.client.messages("owner")).toHaveLength(1);
    f.calls.length = 0;
    const scoped = scopeDshSessionClient(f.client, "peer");
    await expect(scoped.messages("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.children("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.todo("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.status("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.prompt("owner", { parts: [] })).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.promptSync("owner", { parts: [] })).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.abort("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.compact!("owner")).rejects.toThrow(DSH_SESSION_ACCESS_DENIED);
    await expect(scoped.create({ directory })).rejects.toThrow("not available through scoped session readers");
    expect(await scoped.children("peer")).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});
