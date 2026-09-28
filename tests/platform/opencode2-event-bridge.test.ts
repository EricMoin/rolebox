/// <reference types="bun-types" />

/**
 * opencode v2 event normalization.
 *
 * v2 events are envelopes `{ id, created, type, data, location?, metadata? }`
 * (src/platform/adapters/opencode2/event-bridge.ts documents the citations), so
 * each raw fixture below is the envelope a v2 server puts on
 * `ctx.event.subscribe()`, with the `data` shape the installed @opencode/schema
 * 2.0.18 declarations give that event.
 *
 * No case uses the network or a host.
 */

import { describe, it, expect } from "bun:test";
import {
  OPENCODE2_EVENT_TYPE_MAP,
  mapOpencode2EventType,
  normalizeOpencode2Event,
} from "../../src/platform/adapters/opencode2/event-bridge.ts";
import type { CanonicalEventType } from "../../src/platform/ports/event-bridge.ts";

/** One v2 envelope with an explicit data payload. */
function v2Event(type: string, data: unknown): unknown {
  return {
    id: "evt_1",
    created: 1_700_000_000_000,
    type,
    data,
    location: { directory: "/project" },
    metadata: { source: "test" },
  };
}

// ── The mapped vocabulary ──────────────────────────────────────────────────

describe("opencode2 event map", () => {
  it("maps only canonical types the platform layer declares", () => {
    const canonical: CanonicalEventType[] = [
      "session.idle",
      "session.status",
      "session.updated",
      "session.error",
      "session.created",
      "session.deleted",
      "message.created",
      "message.updated",
      "message.completed",
      "part.created",
      "part.updated",
      "unknown",
    ];

    for (const mapped of Object.values(OPENCODE2_EVENT_TYPE_MAP)) {
      expect(canonical).toContain(mapped);
    }
  });

  it("resolves every table key through mapOpencode2EventType", () => {
    for (const [rawType, expected] of Object.entries(OPENCODE2_EVENT_TYPE_MAP)) {
      expect(mapOpencode2EventType(rawType)).toBe(expected);
    }
  });

  it("resolves a v2 event the table does not carry to unknown", () => {
    // The permission events have no canonical counterpart at all: the canonical
    // set (src/platform/types.ts:89-101) has no permission variant, and the v1
    // table has no permission entry either.
    expect(mapOpencode2EventType("permission.asked")).toBe("unknown");
    expect(mapOpencode2EventType("permission.replied")).toBe("unknown");
    expect(mapOpencode2EventType("session.compacted")).toBe("unknown");
    // The message-level event the schema defines is NOT part of the plugin's
    // subscribe union (…/protocol/dist/groups/event.d.ts), which is why the
    // canonical message.updated has no v2 source — see the module comment.
    expect(mapOpencode2EventType("session.message.content.updated")).toBe("unknown");
    expect(mapOpencode2EventType("")).toBe("unknown");
  });
});

// ── Session lifecycle ──────────────────────────────────────────────────────

describe("opencode2 event normalization — session lifecycle", () => {
  it("normalizes session.idle with the session id", () => {
    // data = { sessionID } (…/schema/dist/session-status-event.d.ts, Idle)
    const event = normalizeOpencode2Event(v2Event("session.idle", { sessionID: "ses_1" }));

    expect(event.type).toBe("session.idle");
    expect(event.rawType).toBe("session.idle");
    expect(event.properties).toEqual({ sessionID: "ses_1" });
  });

  it("normalizes session.status with the status object the handler narrows", () => {
    // data = { sessionID, status: { type: "idle" | "retry" | "busy" } }
    const event = normalizeOpencode2Event(
      v2Event("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
    );

    expect(event.type).toBe("session.status");
    expect(event.properties["sessionID"]).toBe("ses_1");
    expect(event.properties["status"]).toEqual({ type: "busy" });
  });

  it("normalizes session.execution.failed onto the canonical session.error", () => {
    const error = { type: "provider_error", message: "boom", status: 500 };
    const event = normalizeOpencode2Event(
      v2Event("session.execution.failed", { sessionID: "ses_1", error }),
    );

    expect(event.type).toBe("session.error");
    expect(event.rawType).toBe("session.execution.failed");
    expect(event.properties["sessionID"]).toBe("ses_1");
    expect(event.properties["error"]).toEqual(error);
  });

  it("reconstructs the v1 info.id shape for session.deleted", () => {
    // data = { sessionID } — v1's payload was { info: Session } and
    // src/hooks/event-handler.ts:188 reads properties.info.id.
    const event = normalizeOpencode2Event(v2Event("session.deleted", { sessionID: "ses_9" }));

    expect(event.type).toBe("session.deleted");
    expect(event.properties["info"]).toEqual({ id: "ses_9" });
    // The v2 field is kept too: the custom/built-in hook phases read it.
    expect(event.properties["sessionID"]).toBe("ses_9");
  });

  it("normalizes session.created with the session snapshot fields", () => {
    const event = normalizeOpencode2Event(
      v2Event("session.created", {
        sessionID: "ses_2",
        projectID: "proj_1",
        slug: "quiet-otter",
        title: "New session",
        version: "2",
      }),
    );

    expect(event.type).toBe("session.created");
    expect(event.properties["sessionID"]).toBe("ses_2");
    expect(event.properties["projectID"]).toBe("proj_1");
    expect(event.properties["slug"]).toBe("quiet-otter");
  });

  it("normalizes session.inbox.delivered onto the canonical message.created", () => {
    const event = normalizeOpencode2Event(
      v2Event("session.inbox.delivered", { sessionID: "ses_3", inboxID: "inb_1" }),
    );

    expect(event.type).toBe("message.created");
    expect(event.properties).toEqual({ sessionID: "ses_3", inboxID: "inb_1" });
  });
});

// ── Part streams ───────────────────────────────────────────────────────────

describe("opencode2 event normalization — part streams", () => {
  const partStreams: Array<[string, Record<string, unknown>]> = [
    ["session.text.started", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 0 }],
    ["session.text.delta", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 1, delta: "hi" }],
    ["session.text.ended", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 2 }],
    ["session.reasoning.started", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 0 }],
    ["session.reasoning.delta", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 1, delta: "hmm" }],
    ["session.reasoning.ended", { sessionID: "ses_4", assistantMessageID: "msg_1", ordinal: 2 }],
    ["session.tool.called", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: false }],
    ["session.tool.input.started", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1" }],
    ["session.tool.input.delta", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1", delta: "{" }],
    ["session.tool.input.ended", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1" }],
    ["session.tool.progress", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1" }],
    ["session.tool.success", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1", content: [], executed: true }],
    ["session.tool.failed", { sessionID: "ses_4", assistantMessageID: "msg_1", id: "call_1", executed: true }],
  ];

  for (const [rawType, data] of partStreams) {
    it(`normalizes ${rawType} onto part.updated with its session id`, () => {
      const event = normalizeOpencode2Event(v2Event(rawType, data));

      expect(event.type).toBe("part.updated");
      expect(event.rawType).toBe(rawType);
      expect(event.properties["sessionID"]).toBe("ses_4");
    });
  }
});

// ── Unknown and malformed input ────────────────────────────────────────────

describe("opencode2 event normalization — unmapped and malformed input", () => {
  it("preserves an unmapped event verbatim under unknown", () => {
    const event = normalizeOpencode2Event(
      v2Event("permission.asked", { sessionID: "ses_5", action: "bash", resources: ["rm -rf /"] }),
    );

    expect(event.type).toBe("unknown");
    expect(event.rawType).toBe("permission.asked");
    expect(event.properties).toEqual({
      sessionID: "ses_5",
      action: "bash",
      resources: ["rm -rf /"],
    });
  });

  it("never throws on a non-event payload", () => {
    for (const input of [null, undefined, 42, "session.idle", {}, { type: 7 }, { type: "x" }]) {
      const event = normalizeOpencode2Event(input);
      expect(event.type).toBe("unknown");
      expect(event.properties).toEqual({});
    }
  });

  it("reports the missing type as the literal unknown raw type", () => {
    expect(normalizeOpencode2Event({ data: { sessionID: "ses_6" } })).toEqual({
      type: "unknown",
      rawType: "unknown",
      properties: { sessionID: "ses_6" },
    });
  });

  it("treats a non-record data payload as empty properties", () => {
    for (const data of [undefined, null, "text", 3, ["a"]]) {
      expect(normalizeOpencode2Event(v2Event("session.idle", data)).properties).toEqual({});
    }
  });

  it("copies the payload instead of aliasing it", () => {
    const raw = v2Event("session.deleted", { sessionID: "ses_7" }) as {
      data: Record<string, unknown>;
    };

    const event = normalizeOpencode2Event(raw);

    expect(event.properties).not.toBe(raw.data);
    expect(raw.data["info"]).toBeUndefined();
    event.properties["sessionID"] = "mutated";
    expect(raw.data["sessionID"]).toBe("ses_7");
  });
});
