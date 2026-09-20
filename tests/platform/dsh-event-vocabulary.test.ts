/// <reference types="bun-types" />

/**
 * Guard — every `SessionEvent` sub-type the dsh event bridge maps must be a real member of
 * the harness's session-event catalog.
 *
 * `DSH_SESSION_EVENT_TYPE_MAP` (`src/platform/adapters/dsh/event-bridge.ts`) keys the
 * `type` discriminators carried inside `session/event` payloads. Those are not cordis bus
 * names, so `keyof Events` cannot check them, and the installed `SessionEventType` union is
 * incomplete (sub-types declared by service packages that are not installed are missing).
 * This test therefore guards the key set against the authoritative generated runtime catalog
 * `KNOWN_SESSION_EVENT_TYPES` from the installed `@deepseek-ai/dsh-session`.
 *
 * Only this direction is a violation: a catalog entry with no adapter mapping is expected —
 * unmapped sub-types resolve to `"unknown"` by design.
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  DSH_SESSION_EVENT_TYPE_MAP,
  mapDshEventType,
} from "../../src/platform/adapters/dsh/event-bridge.ts";

/** Entries of `types` the harness catalog does not declare — the dead-vocabulary set. */
function deadKeys(types: readonly string[]): string[] {
  return types.filter((type) => !KNOWN_SESSION_EVENT_TYPES.has(type));
}

const MAPPED_SUB_TYPES = Object.keys(DSH_SESSION_EVENT_TYPE_MAP);

describe("dsh session-event vocabulary guard", () => {
  it("the authoritative catalog and the adapter table are both non-empty", () => {
    // Vacuity guard: a missing/renamed export or an empty catalog would let the membership
    // check below pass without checking anything.
    expect(KNOWN_SESSION_EVENT_TYPES.size).toBeGreaterThan(0);
    expect(MAPPED_SUB_TYPES.length).toBeGreaterThan(0);
  });

  it("maps only catalog-declared SessionEvent sub-types (no dead keys)", () => {
    expect(deadKeys(MAPPED_SUB_TYPES)).toEqual([]);
  });

  it("positive control: the same check flags a fabricated sub-type key", () => {
    // Proves the assertion above has teeth — a fabricated key (never a catalog member) is
    // reported by the exact function the guard uses.
    expect(deadKeys([...MAPPED_SUB_TYPES, "rolebox/not-a-real-event"])).toEqual([
      "rolebox/not-a-real-event",
    ]);
  });

  it("does not re-add the removed assistant/chunk key", () => {
    // `assistant/chunk` is absent from the catalog (it survives only in legacy fixtures) and
    // could never reach a session log, so the adapter dropped it as a dead key. If the
    // catalog assertion below ever fails, dsh has started declaring the event and the
    // removal should be re-evaluated rather than blindly restored.
    expect(KNOWN_SESSION_EVENT_TYPES.has("assistant/chunk")).toBe(false);
    expect(MAPPED_SUB_TYPES).not.toContain("assistant/chunk");
    expect(mapDshEventType("assistant/chunk")).toBe("unknown");
  });
});
