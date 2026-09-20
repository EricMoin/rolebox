/// <reference types="bun-types" />

/**
 * Guard — the pi adapter maps exactly the event vocabulary the host can deliver.
 *
 * `PI_EVENT_TYPE_MAP` (`src/platform/adapters/pi/event-bridge.ts`) keys the Extension API
 * event names rolebox translates into canonical events. Unlike dsh, pi-coding-agent 0.86.0
 * exports **no runtime event-name catalog** (probe: 59 `export declare const` in its
 * `.d.ts`, none an event array/Set), so membership is enforced at compile time by the
 * `satisfies` guard on that table and on the parser switch vocabularies
 * (`PiJsonEventType`). This test guards what the compiler cannot: the mapped key set stays
 * exactly the audited vocabulary, the two dead keys the two-source audit removed cannot be
 * silently re-added, and the lookup still resolves real names while rejecting fabricated
 * ones.
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import {
  PI_EVENT_TYPE_MAP,
  mapPiEventType,
} from "../../src/platform/adapters/pi/event-bridge.ts";

/** Event names the pi Extension API declares and rolebox maps. */
const EXPECTED_HOST_EVENT_TYPES = [
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_start",
  "message_update",
  "message_end",
  "tool_call",
  "tool_result",
] as const;

/**
 * Pi literals the two-source audit found in NEITHER the installed package's `.d.ts` NOR its
 * runtime `.js` (pi-coding-agent 0.86.0): `step-finish` 0 hits in both; `reasoning` 0
 * in the `.d.ts` and only provider-response item types inside non-exported bundle chunks.
 * A mapping for either could never fire, so both were removed.
 */
const DEAD_EVENT_TYPES = ["step-finish", "reasoning"] as const;

const MAPPED_EVENT_TYPES = Object.keys(PI_EVENT_TYPE_MAP);

/** Entries of `types` the adapter table does not map — the dead-vocabulary set. */
function deadKeys(types: readonly string[]): string[] {
  return types.filter((type) => !(type in PI_EVENT_TYPE_MAP));
}

describe("pi event vocabulary guard", () => {
  it("the mapped table and the expected vocabulary are both non-empty", () => {
    // Vacuity guard: a missing/renamed export or an empty expectation would let the
    // membership check below pass without checking anything.
    expect(MAPPED_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(EXPECTED_HOST_EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it("maps exactly the audited host-declared vocabulary (no drift either way)", () => {
    expect([...MAPPED_EVENT_TYPES].sort()).toEqual(
      [...EXPECTED_HOST_EVENT_TYPES].sort(),
    );
  });

  it("maps every mapped key to a concrete canonical type", () => {
    for (const type of MAPPED_EVENT_TYPES) {
      expect(mapPiEventType(type)).not.toBe("unknown");
    }
  });

  it("does not map the dead keys the two-source audit removed", () => {
    expect(deadKeys(DEAD_EVENT_TYPES)).toEqual([...DEAD_EVENT_TYPES]);
    for (const type of DEAD_EVENT_TYPES) {
      expect(MAPPED_EVENT_TYPES).not.toContain(type);
      expect(mapPiEventType(type)).toBe("unknown");
    }
  });

  it("positive control: the same check flags a fabricated event name", () => {
    // Proves the assertion above has teeth — a fabricated key (never host-declared) is
    // reported by the exact function the guard uses.
    expect(deadKeys([...MAPPED_EVENT_TYPES, "rolebox/not-a-pi-event"])).toEqual([
      "rolebox/not-a-pi-event",
    ]);
    expect(mapPiEventType("rolebox/not-a-pi-event")).toBe("unknown");
  });
});
