/**
 * DSH memory query scout tests — the one-shot `agent/pre-step` listener
 * (`src/platform/adapters/dsh/memory-scout.ts`) exercised against a fake
 * cordis bus, a recording recall provider, a fake streaming llm and a real
 * {@link MemoryStore} in a temporary workspace.
 *
 * Verifies:
 *   - the listener is registered and notes the payload's admitted user message
 *     (id + text) even without an llm stream, and is disposed with the host
 *   - the scout uses the PAYLOAD prompt, not the previous turn's logged prompt
 *   - the route resolves from the payload selection, then the session's last
 *     request header, then the agent's creation options, and is skipped with
 *     the prompt still noted when none exists
 *   - `auto` scouts only with large memory AND fewer than two deterministic
 *     hits; `always` always scouts; `deterministic` never does
 *   - the `auto` probe and the scout's model input use the prompt's extracted
 *     question, so a long instruction preamble neither grades the search
 *     strong nor reaches the model
 *   - graph workers, subagent sessions (origin or lineage), `recall: false`,
 *     turns with no new human prompt, short prompts and a missing llm stream
 *     never call the model
 *   - the call uses the step's route, a bounded prompt and the JSON system
 *     instruction, and reads text deltas and block-end text
 *   - a fenced, prose-wrapped, single-string or invalid JSON response is
 *     parsed/sanitized/deduped/capped correctly
 *   - timeout, abort, a thrown stream and an empty stream return `next()`'s
 *     decision unchanged without an offer and without throwing, even when the
 *     provider stream ignores the abort signal
 *   - text deltas win over a redundant block-end chunk, which is only the
 *     fallback for a provider that emits no delta text
 *   - `next()` is called exactly once, the listener returns its decision, a
 *     second step without a new prompt does not call the model, and the
 *     disposer removes the listener
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installDshMemoryScout,
  type DshMemoryScoutLlm,
  type DshMemoryScoutRequest,
} from "../../src/platform/adapters/dsh/memory-scout.ts";
import type { DshMemoryRecall } from "../../src/platform/adapters/dsh/memory-recall.ts";
import type { DshCordisContext } from "../../src/platform/adapters/dsh/event-bridge.ts";
import type { DshContextAgent, DshContextOptions } from "../../src/platform/adapters/dsh/session-context.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { ResolvedRole } from "../../src/types.ts";

const SESSION = "session-scout";
const PROVIDER = "example-provider";
const MODEL = "example-model";
const PROMPT = "deployment migration";
const PROMPT_SEQ = 7;
/** The key the claimed payload message carries (its stable id). */
const PROMPT_KEY = `claimed-${PROMPT}`;

/**
 * The controlled headless-E2E task that exposed the starvation: a long
 * English instruction preamble followed by the labelled question.
 */
const E2E_TASK = [
  "This is a controlled memory-recall check. Treat the following paragraphs as a fixed test harness: do not use outside knowledge, do not browse the web, do not ask clarifying questions, and do not write to memory. The workspace already contains every fact you need. Respond with a single short sentence, and name the memory entries you relied on so the operator can verify that retrieval found them.",
  'Question: what are the "cobalt sentinel" code and the "蓝鲸哨兵" number? Reply with both values on one line.',
].join("\n\n");

type SessionEvent = { type: string; data?: unknown; time?: number; seq?: number };
type PreStepListener = (...args: unknown[]) => Promise<unknown>;
type Offer = { sessionId: string; promptKey: string; queries: readonly string[] };
type Note = { sessionId: string; promptKey: string; text: string };

/** Minimal resolved role with mutable memory configuration. */
function role(id: string): ResolvedRole {
  return {
    id,
    config: { name: id, description: id, prompt: id },
    prompt: id,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** A model-visible user-role message from the named producer. */
function userMessage(text: string, seq: number, kind = "user"): SessionEvent {
  return {
    type: "user/message",
    time: seq,
    seq,
    data: {
      id: `message-${seq}`,
      role: "user",
      source: { kind },
      content: [{ type: "text", text }],
    },
  };
}

/** A claimed step message (the shape the waterfall hands the listener). */
function claimedMessage(text: string, kind = "user"): Record<string, unknown> {
  return {
    id: `claimed-${text}`,
    role: "user",
    source: { kind },
    content: [{ type: "text", text }],
  };
}

/** Fake dsh session with a header (cwd and optional subagent lineage). */
function session(
  directory: string,
  events: SessionEvent[] = [],
  header: { origin?: string; parentSession?: string } = {},
) {
  return {
    id: SESSION,
    header: { cwd: directory, ...header },
    events,
    inheritedEventCount: 0,
  };
}

describe("DSH memory query scout", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rolebox-dsh-memory-scout-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(options: { title?: string; content?: string; tags?: string[]; roleId?: string } = {}): string {
    const store = MemoryStore.open(root);
    try {
      return store.write({
        scope: "workspace",
        role_id: options.roleId ?? "shared",
        category: "fact",
        title: options.title ?? "Misc note",
        content: options.content ?? "Unrelated workspace content.",
        tags: options.tags ?? [],
        relevance: "medium",
        session_id: "seed-session",
        source_sessions: ["seed-session"],
      });
    } finally {
      store.close();
    }
  }

  /** Seed enough unrelated entries to pass the default `auto` size gate. */
  function seedLarge(): void {
    for (let index = 0; index < 20; index += 1) {
      seed({ title: `Misc note ${index}`, content: `Unrelated workspace content number ${index}.` });
    }
  }

  /**
   * Seed enough entries to pass the default `auto` size gate while matching
   * only the E2E task's instruction preamble — never its question.
   */
  function seedPreambleOnly(): void {
    for (let index = 0; index < 20; index += 1) {
      seed({
        title: `Archived fixture note ${index}`,
        content: `The controlled instruction paragraph is intentionally unrelated fixture ${index}.`,
      });
    }
  }

  function fixture(options: { timeoutMs?: number; minEntries?: number; maxQueries?: number } = {}) {
    const first = role("role-a");
    const roles = [first];
    const activeRoleId = "role-a";
    const workers = new Set<string>();
    let sessionValue: ReturnType<typeof session> | undefined;
    const context: DshContextOptions = {
      roles: () => roles,
      activeRole: () => activeRoleId,
      session: () => sessionValue,
      tools: () => ["memory_read", "memory_recall"],
      worker: (agent?: DshContextAgent) => {
        const id = agent?.session?.id ?? agent?.id ?? "";
        return workers.has(id) ? { declaredTools: [] } : undefined;
      },
    };
    const offers: Offer[] = [];
    const notes: Note[] = [];
    const recall: DshMemoryRecall = {
      render: () => "",
      notePrompt: (sessionId, promptKey, text) => {
        notes.push({ sessionId, promptKey, text });
      },
      offerQueries: (sessionId, promptKey, queries) => {
        offers.push({ sessionId, promptKey, queries: [...queries] });
      },
    };
    const listeners: PreStepListener[] = [];
    const ctx: DshCordisContext = {
      on(event: string, listener: (...args: unknown[]) => void): () => void {
        if (event !== "agent/pre-step") return () => {};
        const wrapped: PreStepListener = async (...args) => await Promise.resolve(listener(...args));
        listeners.push(wrapped);
        return () => {
          const index = listeners.indexOf(wrapped);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      emit(): void {},
    };
    function install(llm?: DshMemoryScoutLlm): () => void {
      return installDshMemoryScout(ctx, {
        context,
        recall,
        ...(llm === undefined ? {} : { llm }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.minEntries === undefined ? {} : { minEntries: options.minEntries }),
        ...(options.maxQueries === undefined ? {} : { maxQueries: options.maxQueries }),
      });
    }
    function payload(overrides: {
      agent?: Record<string, unknown>;
      session?: ReturnType<typeof session>;
      messages?: readonly unknown[];
      signal?: unknown;
      modelSelection?: unknown;
    } = {}) {
      return {
        agent: overrides.agent ?? { id: SESSION, session: overrides.session ?? sessionValue },
        messages: overrides.messages ?? [claimedMessage(PROMPT)],
        turn: 1,
        step: 1,
        signal: "signal" in overrides ? overrides.signal : new AbortController().signal,
        modelSelection: "modelSelection" in overrides
          ? overrides.modelSelection
          : { provider: PROVIDER, model: MODEL },
      };
    }
    async function invoke(
      listener: PreStepListener,
      value: unknown,
      decision: unknown = { kind: "enter", messages: [] },
    ) {
      const next = vi.fn(async () => decision);
      const result = await listener(value, next);
      return { result, next, decision };
    }
    return {
      first,
      workers,
      offers,
      notes,
      listeners,
      ctx,
      setSession(value: ReturnType<typeof session>) {
        sessionValue = value;
      },
      install,
      payload,
      invoke,
    };
  }

  /** Fake stream-capable llm recording each request. */
  function fakeLlm(
    response: string | (() => AsyncIterable<unknown>),
  ): { llm: DshMemoryScoutLlm; calls: DshMemoryScoutRequest[] } {
    const calls: DshMemoryScoutRequest[] = [];
    const llm: DshMemoryScoutLlm = {
      stream(options) {
        calls.push(options);
        return typeof response === "string" ? textChunks(response) : response();
      },
    };
    return { llm, calls };
  }

  async function* textChunks(text: string): AsyncIterable<unknown> {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: "stop" };
  }

  async function* blockEndOnly(text: string): AsyncIterable<unknown> {
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }

  async function* deltaThenBlockEnd(delta: string, block: string): AsyncIterable<unknown> {
    yield { type: "text-delta", index: 0, text: delta };
    yield { type: "block-end", index: 0, block: { type: "text", text: block } };
  }

  function fenced(queries: readonly string[]): string {
    return "```json\n" + JSON.stringify({ queries }) + "\n```";
  }

  it("does not call the model in auto mode when workspace memory is small", async () => {
    const f = fixture();
    seed({ title: "Unrelated", content: "Unrelated workspace content." });
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["deployment"]));
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);
  });

  it("calls the model in auto mode with large memory and no deterministic hits", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes", "rollout"]));
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe(PROVIDER);
    expect(calls[0].model).toBe(MODEL);
    expect(calls[0].maxTokens).toBe(600);
    expect(calls[0].temperature).toBe(0);
    expect(calls[0].sessionId).toBe(SESSION);
    expect(calls[0].system).toContain("JSON");
    expect(calls[0].messages[0].content[0].text).toBe(PROMPT);
    expect(f.offers).toEqual([{
      sessionId: SESSION,
      promptKey: PROMPT_KEY,
      queries: ["release notes", "rollout"],
    }]);
    expect(result).toBe(decision);
  });

  it("auto-scouts with the extracted question, not the instruction preamble", async () => {
    const f = fixture();
    seedPreambleOnly();
    f.setSession(session(root, [userMessage(E2E_TASK, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["cobalt sentinel"]));
    f.install(llm);

    const { result, decision } = await f.invoke(
      f.listeners[0],
      f.payload({ messages: [claimedMessage(E2E_TASK)] }),
    );

    // The preamble-only entries would make the deterministic search strong if
    // the probe used the whole prompt; with the extracted question it finds
    // nothing and the scout runs.
    expect(calls).toHaveLength(1);
    const sent = calls[0].messages[0].content[0].text;
    expect(sent).toContain('"cobalt sentinel"');
    expect(sent).toContain('"蓝鲸哨兵"');
    expect(sent).not.toContain("This is a controlled");
    expect(f.offers).toEqual([{
      sessionId: SESSION,
      promptKey: `claimed-${E2E_TASK}`,
      queries: ["cobalt sentinel"],
    }]);
    expect(result).toBe(decision);
  });

  it("calls the model in auto mode with exactly one deterministic hit", async () => {
    const f = fixture();
    seedLarge();
    seed({ title: "Deployment migration checklist", content: "Deployment migration notes." });
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(1);
    expect(f.offers).toHaveLength(1);
  });

  it("does not call the model in auto mode with two or more deterministic hits", async () => {
    const f = fixture();
    seedLarge();
    seed({ title: "Deployment migration one", content: "Deployment migration notes." });
    seed({ title: "Deployment migration two", content: "Deployment migration notes again." });
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);
  });

  it("does not count a session-focus entry as a strong deterministic hit", async () => {
    const f = fixture();
    seedLarge();
    seed({ title: "Focus", content: "Deployment migration focus.", tags: ["session-focus"] });
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(1);
  });

  it("calls the model in always mode even with small memory", async () => {
    const f = fixture();
    f.first.config.memory = { recall_mode: "always" };
    seed({ title: "Unrelated", content: "Unrelated workspace content." });
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(1);
  });

  it("never calls the model in deterministic mode", async () => {
    const f = fixture();
    f.first.config.memory = { recall_mode: "deterministic" };
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
    expect(result).toBe(decision);
  });

  it("never calls the model when the role opts out with recall: false", async () => {
    const f = fixture();
    f.first.config.memory = { recall: false };
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
  });

  it("never calls the model for a graph worker", async () => {
    const f = fixture();
    seedLarge();
    f.workers.add(SESSION);
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
  });

  it.each([
    ["origin", { origin: "subagent" }],
    ["lineage", { parentSession: "parent-session" }],
  ])("never calls the model for a subagent session (%s)", async (_name, header) => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)], header));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(0);
  });

  it("never calls the model on a step with no new human prompt", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ messages: [claimedMessage("injected", "runtime-context")] }));
    await f.invoke(f.listeners[0], f.payload({ messages: [] }));

    expect(calls).toHaveLength(0);
    expect(f.notes).toEqual([]);
  });

  it("never calls the model for a prompt with fewer than two search terms", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage("fix", 3)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ messages: [claimedMessage("fix")] }));

    expect(calls).toHaveLength(0);
    expect(f.notes).toEqual([{ sessionId: SESSION, promptKey: "claimed-fix", text: "fix" }]);
  });

  it("resolves the route from the session's last request header without a payload selection", async () => {
    const f = fixture();
    seedLarge();
    const routed = {
      ...session(root),
      requestHeader: () => ({ config: { provider: "header-provider", model: "header-model" } }),
    };
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ session: routed, modelSelection: undefined }));

    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("header-provider");
    expect(calls[0].model).toBe("header-model");
  });

  it("falls back to the agent's creation options when the session has no request header", async () => {
    const f = fixture();
    seedLarge();
    const agent = {
      id: SESSION,
      session: session(root, []),
      options: { provider: "options-provider", model: "options-model" },
    };
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ agent, modelSelection: undefined }));

    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("options-provider");
    expect(calls[0].model).toBe("options-model");
  });

  it("notes the prompt but skips the scout when no route is available", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, []));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    const { result, decision } = await f.invoke(
      f.listeners[0],
      f.payload({ modelSelection: undefined }),
    );

    expect(calls).toHaveLength(0);
    expect(f.offers).toEqual([]);
    expect(f.notes).toEqual([{ sessionId: SESSION, promptKey: PROMPT_KEY, text: PROMPT }]);
    expect(result).toBe(decision);
  });

  it("never calls the model without an abort signal", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, []));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ signal: undefined }));

    expect(calls).toHaveLength(0);
  });

  it("installs the prompt handoff without an llm stream and disposes the listener", async () => {
    const f = fixture();
    f.setSession(session(root, []));

    const dispose = f.install();

    expect(f.listeners).toHaveLength(1);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(f.notes).toEqual([{ sessionId: SESSION, promptKey: PROMPT_KEY, text: PROMPT }]);
    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);

    dispose();
    expect(f.listeners).toHaveLength(0);
  });

  it("scouts the payload prompt when the session log has no user message", async () => {
    const f = fixture();
    seedLarge();
    // First turn: the message is claimed at pre-step and not logged yet.
    f.setSession(session(root, []));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content[0].text).toBe(PROMPT);
    expect(f.offers[0]?.promptKey).toBe(PROMPT_KEY);
  });

  it("notes the payload prompt while the session log holds only the previous turn's prompt", async () => {
    const f = fixture();
    seedLarge();
    // The loop claims the current message at pre-step and appends it only after
    // the step's context refresh, so the log still ends with the PREVIOUS turn.
    f.setSession(session(root, [userMessage("compression rollback", 1)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload({ messages: [claimedMessage(PROMPT)] }));

    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content[0].text).toBe(PROMPT);
    expect(f.offers).toEqual([{
      sessionId: SESSION,
      promptKey: PROMPT_KEY,
      queries: ["release notes"],
    }]);
    expect(f.notes).toEqual([{ sessionId: SESSION, promptKey: PROMPT_KEY, text: PROMPT }]);
  });

  it("parses a fenced JSON response", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm(fenced(["release notes", "rollout"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers[0]?.queries).toEqual(["release notes", "rollout"]);
  });

  it("parses prose-wrapped JSON and a single-string queries value", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm('Here you go: {"queries": "release notes"} — done.');
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers[0]?.queries).toEqual(["release notes"]);
  });

  it("reads text from a block-end chunk when there is no delta", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm(() => blockEndOnly(fenced(["release notes"])));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers[0]?.queries).toEqual(["release notes"]);
  });

  it("uses the text deltas and ignores the repeated block-end text", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    // A real stream emits the response as deltas and then repeats the
    // assembled text in a block-end; the offer must not see it twice.
    const { llm } = fakeLlm(() => deltaThenBlockEnd(fenced(["release notes"]), fenced(["release notes"])));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers).toHaveLength(1);
    expect(f.offers[0]?.queries).toEqual(["release notes"]);
  });

  it("does not append block-end text once a delta has carried text", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    // The block-end alone would parse, so only the delta-first rule keeps the
    // response unoffered: block-end is the fallback, never an addition.
    const { llm } = fakeLlm(() => deltaThenBlockEnd("the model returned no list", fenced(["block-only query"])));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers).toEqual([]);
  });

  it("sanitizes, de-duplicates and caps the offered queries", async () => {
    const f = fixture({ maxQueries: 2 });
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm(JSON.stringify({
      queries: ["  Deployment   migration ", "deployment MIGRATION", "", "x".repeat(81), "rollout", 42],
    }));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers[0]?.queries).toEqual(["Deployment migration", "rollout"]);
  });

  it("makes no offer for invalid JSON or an empty query list", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const invalid = fakeLlm("the model forgot the format");
    f.install(invalid.llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);

    const empty = fakeLlm(JSON.stringify({ queries: [] }));
    f.install(empty.llm);
    await f.invoke(f.listeners[0], f.payload({ messages: [claimedMessage("a fresh prompt here")] }));
    expect(f.offers).toEqual([]);
  });

  it("returns the decision when the scout stream yields no usable text", async () => {
    const silent = fixture();
    seedLarge();
    silent.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const empty = fakeLlm(() => (async function* () {
      yield { type: "finish", reason: "stop" };
    })());
    silent.install(empty.llm);

    const emptyOutcome = await silent.invoke(silent.listeners[0], silent.payload());

    expect(empty.calls).toHaveLength(1);
    expect(silent.offers).toEqual([]);
    expect(emptyOutcome.result).toBe(emptyOutcome.decision);

    // Whitespace-only output has no JSON to parse either: it is still a miss,
    // not an offer of blank queries.
    const blank = fixture();
    blank.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const whitespace = fakeLlm(() => textChunks("  \n\t "));
    blank.install(whitespace.llm);

    const blankOutcome = await blank.invoke(blank.listeners[0], blank.payload());

    expect(whitespace.calls).toHaveLength(1);
    expect(blank.offers).toEqual([]);
    expect(blankOutcome.result).toBe(blankOutcome.decision);
  });

  it("waits the 3-second default deadline before giving up on the scout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      seedLarge();
      f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
      const llm: DshMemoryScoutLlm = {
        stream(options) {
          return (async function* () {
            await new Promise<void>((resolve) => {
              const signal = options.signal;
              if (signal === undefined || signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            options.signal?.throwIfAborted();
            yield { type: "text-delta", index: 0, text: fenced(["release notes"]) };
          })();
        },
      };
      f.install(llm);

      let settled = false;
      const pending = f.invoke(f.listeners[0], f.payload());
      pending.then(() => {
        settled = true;
      });

      // A live turn's model needs longer than the old 1.5-second deadline but
      // less than the 3-second one, so the default must still be waiting here.
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      expect(f.offers).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      const { result, decision } = await pending;

      expect(f.offers).toEqual([]);
      expect(result).toBe(decision);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the decision when the scout call times out", async () => {
    const f = fixture({ timeoutMs: 10 });
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const llm: DshMemoryScoutLlm = {
      stream(options) {
        return (async function* () {
          await new Promise<void>((resolve) => {
            const signal = options.signal;
            if (signal === undefined || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          options.signal?.throwIfAborted();
          yield { type: "text-delta", index: 0, text: fenced(["release notes"]) };
        })();
      },
    };
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);
  });

  it("returns the decision at the deadline when the stream ignores the abort", async () => {
    const f = fixture({ timeoutMs: 20 });
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: DshMemoryScoutRequest[] = [];
    const llm: DshMemoryScoutLlm = {
      stream(options) {
        requests.push(options);
        return (async function* () {
          // Ignores options.signal entirely: only the deadline race can end
          // the listener's wait.
          await gate;
          yield { type: "text-delta", index: 0, text: fenced(["late query"]) };
        })();
      },
    };
    f.install(llm);

    const started = Date.now();
    const { result, decision } = await f.invoke(f.listeners[0], f.payload());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);

    // Let the parked stream yield its late chunk: the deadline still wins.
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.offers).toEqual([]);
  });

  it("returns the decision when the turn signal is already aborted", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const llm: DshMemoryScoutLlm = {
      stream(options) {
        return (async function* () {
          options.signal?.throwIfAborted();
          yield { type: "text-delta", index: 0, text: fenced(["release notes"]) };
        })();
      },
    };
    f.install(llm);
    const controller = new AbortController();
    controller.abort();

    const { result, decision } = await f.invoke(
      f.listeners[0],
      f.payload({ signal: controller.signal }),
    );

    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);
  });

  it("returns the decision when the scout stream throws", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const llm: DshMemoryScoutLlm = {
      stream() {
        throw new Error("provider unavailable");
      },
    };
    f.install(llm);

    const { result, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(f.offers).toEqual([]);
    expect(result).toBe(decision);
  });

  it("calls next exactly once and returns its decision unchanged", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    const { result, next, decision } = await f.invoke(f.listeners[0], f.payload());

    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toBe(decision);
  });

  it("does not call the model again on a second step or for the same prompt", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());
    await f.invoke(f.listeners[0], f.payload());
    await f.invoke(f.listeners[0], f.payload({ messages: [] }));

    expect(calls).toHaveLength(1);
    expect(f.offers).toHaveLength(1);
  });

  it("installs at most five queries by default", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm } = fakeLlm(JSON.stringify({
      queries: ["one", "two", "three", "four", "five", "six", "seven"],
    }));
    f.install(llm);

    await f.invoke(f.listeners[0], f.payload());

    expect(f.offers[0]?.queries).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("removes the listener when the disposer runs", async () => {
    const f = fixture();
    seedLarge();
    f.setSession(session(root, [userMessage(PROMPT, PROMPT_SEQ)]));
    const { llm, calls } = fakeLlm(fenced(["release notes"]));
    const dispose = f.install(llm);
    expect(f.listeners).toHaveLength(1);

    dispose();
    dispose();

    expect(f.listeners).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
