/**
 * PiProcessSessionAdapter — pi 0.81.x agent-run JSON event stream tests.
 *
 * Feeds realistic newline-delimited JSON event lines from the pi 0.81.1
 * `--mode json` vocabulary into _handleJsonEvent via an adapter record
 * obtained from create(), and verifies the parsed message state:
 *
 *   1. Assistant text accumulates exactly once across many text_delta
 *      message_update events, and message_end's finalized content does not
 *      double-count on top of the delta-assembled text.
 *   2. No tool part is left in "running" or "pending" state after
 *      tool_execution_end is processed.
 *   3. _extractLastAssistantText returns non-empty finalized text after
 *      message_end.
 *   4. message_end with stopReason "error" propagates the errorMessage
 *      through detectCompletion as an error signal.
 *   5. detectCompletion reports "completed" with idle session status after
 *      a fully successful event stream.
 *
 * Fixture shapes mirror the field names actually read by the rewrite of
 * _handleJsonEvent in src/platform/adapters/pi/process-session.ts
 * (event.message, event.assistantMessageEvent{type, contentIndex, delta},
 * message.content array on message_end, toolCallId/toolName/args/partial
 * Result/result/isError on tool_execution_*, stopReason/errorMessage on the
 * finalized message).
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PiProcessSessionAdapter } from "../src/platform/adapters/pi/process-session.ts";
import { detectCompletion } from "../src/dispatch/completion/completion-detector.ts";
import type {
  SessionMessageSnapshot,
  TaskEventState,
} from "../src/dispatch/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Serialize event fixtures into a single newline-delimited JSON stream,
 * mirroring what `pi --mode json` emits on stdout (one object per line).
 */
function jsonl(...events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

/**
 * Feed a JSONL stream through the adapter's _handleJsonEvent, following the
 * production stdout loop: split lines, trim, skip blanks, JSON.parse each.
 */
function feedJsonl(
  adapter: PiProcessSessionAdapter,
  record: any,
  stream: string,
): void {
  for (const line of stream.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    (adapter as any)._handleJsonEvent(JSON.parse(trimmed), record);
  }
}

/**
 * Create a session via the public create() path and return its internal
 * ProcessRecord (the established (adapter as any) access convention).
 */
async function createRecord(
  adapter: PiProcessSessionAdapter,
): Promise<any> {
  const info = await adapter.create({ directory: "/tmp/rolebox-test-project" });
  if (!info) throw new Error("adapter.create() returned null");
  return (adapter as any).processes.get(info.id);
}

/** Find the most recent assistant message in a ProcessRecord. */
function lastAssistantMessage(record: any): any {
  const msgs = record.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].info?.role === "assistant") return msgs[i];
  }
  return undefined;
}

/** Collect text parts from a parsed Message. */
function textParts(msg: any): Array<{ text?: string }> {
  return (msg?.parts ?? []).filter((p: any) => p.type === "text");
}

/** Collect every tool part across all messages of a ProcessRecord. */
function toolParts(record: any): any[] {
  const out: any[] = [];
  for (const msg of record.messages ?? []) {
    for (const part of msg.parts ?? []) {
      if (part.type === "tool") out.push(part);
    }
  }
  return out;
}

/** Minimal TaskEventState accepted by detectCompletion's pollState param. */
function defaultEventState(): TaskEventState {
  return {
    lastMessageCount: 0,
    lastProgressUpdate: Date.now(),
    hasProducedOutput: false,
    messageCountAtStart: 0,
    lastEventAt: Date.now(),
    consecutiveFetchFailures: 0,
  };
}

// ── Fixtures — successful agent-run stream (pi 0.81.1 shapes) ───────────────

const SESSION_ID = "ses_pi_0001";
const MESSAGE_ID = "msg_assistant_0001";
const TOOL_CALL_ID = "toolu_call_abc123";

/** text_delta payloads — assembled exactly, in order. */
const DELTAS = [
  "Implement a REST ",
  "endpoint that ",
  "sums two numbers.",
];
const FINAL_ASSISTANT_TEXT = "Implement a REST endpoint that sums two numbers.";
const TOOL_OUTPUT = "README.md\nsrc/\ntests/\n";

/** pi 0.81.x lifecycle no-op event. */
const AGENT_START_EVENT = {
  type: "agent_start",
  agentRunId: "agent_run_0001",
  sessionID: SESSION_ID,
  timestamp: 1700000000000,
};

/** message_start — role comes from event.message.role, not event.role. */
const MESSAGE_START_EVENT = {
  type: "message_start",
  id: "evt_msg_start_0001",
  messageID: MESSAGE_ID,
  sessionID: SESSION_ID,
  message: { role: "assistant", timestamp: 1700000001000 },
};

/** message_update deltas — assistantMessageEvent { text_delta, delta }. */
const MESSAGE_UPDATE_EVENTS = DELTAS.map((delta, i) => ({
  type: "message_update",
  id: `evt_msg_update_000${i + 1}`,
  messageID: MESSAGE_ID,
  sessionID: SESSION_ID,
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
}));

/**
 * message_end — finalized message content replaces the delta-built parts.
 * The toolCall entry id matches toolCallId in the tool_execution_* events.
 */
const MESSAGE_END_EVENT = {
  type: "message_end",
  id: "evt_msg_end_0001",
  messageID: MESSAGE_ID,
  sessionID: SESSION_ID,
  message: {
    role: "assistant",
    content: [
      { type: "text", text: FINAL_ASSISTANT_TEXT },
      {
        type: "toolCall",
        id: TOOL_CALL_ID,
        name: "bash",
        arguments: { command: "ls -la" },
        providerSpecific: { type: "function" },
      },
    ],
    stopReason: "tool_use",
    timestamp: 1700000002000,
  },
};

/** tool_execution_start — keyed by toolCallId. */
const TOOL_EXECUTION_START_EVENT = {
  type: "tool_execution_start",
  id: "evt_tool_start_0001",
  toolCallId: TOOL_CALL_ID,
  toolName: "bash",
  args: { command: "ls -la" },
};

/** tool_execution_update — merges partialResult into the tool part state. */
const TOOL_EXECUTION_UPDATE_EVENT = {
  type: "tool_execution_update",
  id: "evt_tool_update_0001",
  toolCallId: TOOL_CALL_ID,
  toolName: "bash",
  args: { command: "ls -la" },
  partialResult: "README.md\nsrc/\n",
};

/** tool_execution_end — final result, not an error. */
const TOOL_EXECUTION_END_EVENT = {
  type: "tool_execution_end",
  id: "evt_tool_end_0001",
  toolCallId: TOOL_CALL_ID,
  toolName: "bash",
  result: TOOL_OUTPUT,
  isError: false,
};

/** agent_end — lifecycle no-op marking the run as settled. */
const AGENT_END_EVENT = { type: "agent_end", sessionID: SESSION_ID };

/** The full successful 0.81.1 stream, as one line per event. */
const SUCCESS_STREAM = jsonl(
  AGENT_START_EVENT,
  MESSAGE_START_EVENT,
  ...MESSAGE_UPDATE_EVENTS,
  MESSAGE_END_EVENT,
  TOOL_EXECUTION_START_EVENT,
  TOOL_EXECUTION_UPDATE_EVENT,
  TOOL_EXECUTION_END_EVENT,
  AGENT_END_EVENT,
);

// ── Fixtures — errored agent-run stream ────────────────────────────────────

const ERROR_SESSION_ID = "ses_pi_0002";
const ERROR_MESSAGE_ID = "msg_assistant_0002";

/** message_start for the errored run. */
const ERROR_MESSAGE_START_EVENT = {
  type: "message_start",
  id: "evt_err_start_0001",
  messageID: ERROR_MESSAGE_ID,
  sessionID: ERROR_SESSION_ID,
  message: { role: "assistant", timestamp: 1700000101000 },
};

/** message_end whose finalized message carries stopReason "error". */
const ERROR_MESSAGE_END_EVENT = {
  type: "message_end",
  id: "evt_err_end_0001",
  messageID: ERROR_MESSAGE_ID,
  sessionID: ERROR_SESSION_ID,
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: "Pi worker crashed",
    timestamp: 1700000102000,
  },
};

/** Errored 0.81.1 stream, as one line per event. */
const ERROR_STREAM = jsonl(
  ERROR_MESSAGE_START_EVENT,
  ERROR_MESSAGE_END_EVENT,
  AGENT_END_EVENT,
);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiProcessSessionAdapter — pi 0.81.x JSON event stream", () => {
  let adapter: PiProcessSessionAdapter;

  beforeEach(() => {
    adapter = new PiProcessSessionAdapter();
  });

  it("assistant text accumulates exactly once — deltas stream, then message_end finalizes without double-counting", async () => {
    const record = await createRecord(adapter);

    // ── Stage 1: lifecycle no-op + message_start opens one message shell.
    feedJsonl(adapter, record, jsonl(AGENT_START_EVENT, MESSAGE_START_EVENT));
    expect(record.messages).toHaveLength(1);
    expect(record.messages[0].info.role).toBe("assistant");
    expect(record.messages[0].info.id).toBe(MESSAGE_ID);

    // ── Stage 2: several text_delta updates accumulate into ONE text part.
    feedJsonl(adapter, record, jsonl(...MESSAGE_UPDATE_EVENTS));
    const midMsg = lastAssistantMessage(record);
    const midTextParts = textParts(midMsg);
    expect(midTextParts).toHaveLength(1);
    expect(midTextParts[0].text).toBe(FINAL_ASSISTANT_TEXT);

    // ── Stage 3: message_end replaces the delta-built parts with the
    //    finalized content. The recorded text must equal the assembled
    //    content EXACTLY ONCE — not the delta text with the finalized
    //    content appended on top, and not two stacked copies.
    feedJsonl(adapter, record, jsonl(MESSAGE_END_EVENT));
    expect(record.messages).toHaveLength(1); // no extra shell stacked

    const finalized = lastAssistantMessage(record);
    const textPartList = textParts(finalized);
    expect(textPartList).toHaveLength(1); // exactly one text part
    expect(textPartList[0].text).toBe(FINAL_ASSISTANT_TEXT);

    // Sum of ALL text in the message must equal the content once — a
    // duplicated append would double this.
    const totalText = textPartList
      .map((p) => p.text ?? "")
      .join("");
    expect(totalText).toBe(FINAL_ASSISTANT_TEXT);
    expect(finalized.info.finish).toBe("tool_use");
  });

  it("no tool part is left in running or pending state after tool_execution_end", async () => {
    const record = await createRecord(adapter);

    // Feed everything BEFORE the tool end event: the tool part adopted from
    // message_end's toolCall content is mid-execution and must be running.
    feedJsonl(
      adapter,
      record,
      jsonl(
        AGENT_START_EVENT,
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
        TOOL_EXECUTION_START_EVENT,
        TOOL_EXECUTION_UPDATE_EVENT,
      ),
    );

    let tools = toolParts(record);
    expect(tools).toHaveLength(1);
    expect(tools[0].callID).toBe(TOOL_CALL_ID);
    expect(tools[0].tool).toBe("bash");
    expect(tools[0].state.status).toBe("running");
    expect(tools[0].state.input).toEqual({ command: "ls -la" });
    expect(tools[0].state.partialResult).toBe("README.md\nsrc/\n");

    // ── Process tool_execution_end (+ lifecycle no-op).
    feedJsonl(
      adapter,
      record,
      jsonl(TOOL_EXECUTION_END_EVENT, AGENT_END_EVENT),
    );

    tools = toolParts(record);
    expect(tools).toHaveLength(1); // still exactly one tool part
    for (const part of tools) {
      expect(part.state.status).toBe("completed");
      expect(part.state.status === "running").toBe(false);
      expect(part.state.status === "pending").toBe(false);
    }
    expect(tools[0].state.output).toBe(TOOL_OUTPUT);
    expect(typeof tools[0].state.time.end).toBe("number");
  });

  it("_extractLastAssistantText returns the finalized assistant text after message_end", async () => {
    const record = await createRecord(adapter);

    feedJsonl(
      adapter,
      record,
      jsonl(
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
      ),
    );

    const extracted = (adapter as any)._extractLastAssistantText(
      record.messages,
    );
    expect(typeof extracted).toBe("string");
    expect(extracted).not.toBe("");
    expect(extracted).toBe(FINAL_ASSISTANT_TEXT);
  });

  it("message_end with stopReason 'error' propagates the error through detectCompletion", async () => {
    const record = await createRecord(adapter);

    feedJsonl(adapter, record, ERROR_STREAM);

    // Parser state: the finalized message's stopReason/errorMessage lands on
    // the message info as finish/error.
    const errMsg = lastAssistantMessage(record);
    expect(errMsg).toBeDefined();
    expect(errMsg.info.finish).toBe("error");
    expect(errMsg.info.error).toBe("Pi worker crashed");

    // Detector contract: detectCompletion(messages, sessionStatus,
    // pollState, skipStabilityGating) returns the error signal for an idle
    // session whose last assistant message carries info.error.
    const snapshots = record.messages as unknown as SessionMessageSnapshot[];
    const signal = detectCompletion(
      snapshots,
      { type: "idle" },
      defaultEventState(),
      true,
    );
    expect(signal.type).toBe("error");
    expect((signal as { message: string }).message).toBe("Pi worker crashed");
  });

  it("detectCompletion reports completed with idle status after a successful stream", async () => {
    const record = await createRecord(adapter);

    feedJsonl(adapter, record, SUCCESS_STREAM);

    // Sanity on the rebuilt snapshot: assistant output present, tool settled.
    const last = lastAssistantMessage(record);
    expect(textParts(last)).toHaveLength(1);
    expect(toolParts(record).every((p) => p.state.status === "completed"))
      .toBe(true);

    const snapshots = record.messages as unknown as SessionMessageSnapshot[];
    const signal = detectCompletion(
      snapshots,
      { type: "idle" },
      defaultEventState(),
      true,
    );
    expect(signal).toEqual({ type: "completed" });
  });

  it("detectCompletion reports not_ready while the session status is busy", async () => {
    const record = await createRecord(adapter);

    feedJsonl(adapter, record, SUCCESS_STREAM);

    const snapshots = record.messages as unknown as SessionMessageSnapshot[];
    const signal = detectCompletion(
      snapshots,
      { type: "busy" },
      defaultEventState(),
      true,
    );
    expect(signal).toEqual({ type: "not_ready" });
  });

  // ── status() in-flight-tool guard (bug #2: no false idle while a node
  // ── executes shell commands) ────────────────────────────────────────────

  it("status() returns busy when the last message has a running tool part", async () => {
    const record = await createRecord(adapter);

    // Feed everything up to (but excluding) tool_execution_end: the adopted
    // tool part stays mid-execution (running) — status() must report busy so
    // the node is never surfaced idle while the shell command is in flight.
    feedJsonl(
      adapter,
      record,
      jsonl(
        AGENT_START_EVENT,
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
        TOOL_EXECUTION_START_EVENT,
      ),
    );

    const status = await adapter.status(record.id);
    expect(status).toEqual({ type: "busy" });
  });

  it("status() returns busy when the last message has an in-flight toolCall before execution starts", async () => {
    const record = await createRecord(adapter);

    // message_end's toolCall content builds a tool part with status "running"
    // before tool_execution_start ever fires. status() must report busy in
    // that window too — never a false idle while a node's shell command is
    // queued/executing.
    feedJsonl(
      adapter,
      record,
      jsonl(
        AGENT_START_EVENT,
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
      ),
    );

    const status = await adapter.status(record.id);
    expect(status).toEqual({ type: "busy" });
  });

  it("status() returns idle when the last message tool part is completed", async () => {
    const record = await createRecord(adapter);

    feedJsonl(adapter, record, SUCCESS_STREAM);

    const status = await adapter.status(record.id);
    expect(status).toEqual({ type: "idle" });
  });

  // ── turn_end early completion (pi 0.81.1 never exits json -p children) ──

  /** turn_end — the completion signal, mirroring the live 0.81.1 payload. */
  const TURN_END_EVENT = {
    type: "turn_end",
    sessionID: SESSION_ID,
    turnIndex: 0,
    willRetry: false,
  };

  it("turn_end resolves the pending promptSync wait with the accumulated assistant text", async () => {
    const record = await createRecord(adapter);

    const resolved: unknown[] = [];
    const kills: unknown[] = [];
    record.resolve = (value: unknown) => {
      resolved.push(value);
    };
    record.proc = { killed: false, kill: (sig: unknown) => kills.push(sig) };
    record.exitCode = null;

    feedJsonl(
      adapter,
      record,
      jsonl(
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
        TURN_END_EVENT,
      ),
    );

    expect(resolved).toHaveLength(1);
    const result = resolved[0] as { parts: Array<{ type: string; text?: string }> };
    expect(result.parts[0].type).toBe("text");
    expect(result.parts[0].text).toBe(FINAL_ASSISTANT_TEXT);
    expect(record.resolve).toBeNull();

    // The still-running child is terminated instead of idling until the
    // 600s timeout (pi 0.81.1 json -p never exits on its own).
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("turn_end emits exactly one session.idle — duplicates and later exits do not re-emit", async () => {
    const record = await createRecord(adapter);
    const emitted: Array<{ type: string; rawType: unknown }> = [];
    (adapter as any).setEventBridge({
      emit: (event: { type: string; rawType: unknown }) => {
        emitted.push(event);
        return Promise.resolve();
      },
    });

    feedJsonl(
      adapter,
      record,
      jsonl(
        MESSAGE_START_EVENT,
        ...MESSAGE_UPDATE_EVENTS,
        MESSAGE_END_EVENT,
        TURN_END_EVENT,
        // duplicated turn_end (defensive: agent-core re-emits messages)
        TURN_END_EVENT,
      ),
    );

    expect(record.idleEmitted).toBe(true);
    const idles = emitted.filter((e) => e.type === "session.idle");
    expect(idles).toHaveLength(1);
    expect(idles[0].rawType).toBe("pi.turn_end");
    expect(idles[0] as unknown as { properties: { sessionID: string } })
      .toMatchObject({ properties: { sessionID: record.id } });
  });
});
