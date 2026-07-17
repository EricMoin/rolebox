import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { functionRuntime } from "../function/runtime-state.ts";
import { functionSessionState } from "../function/session-state.ts";
import { ArtifactStore } from "../function/artifact-store.ts";
import { recordSignal, hasSignal, getSignalPayload } from "./signal-ledger.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("signal-tool");

/**
 * Signal types that satisfy `continue_until` conditions.
 * When one of these fires, the signal_observed(…) condition returns true,
 * which may trigger phase="complete" on the next idle cycle.
 */
const TERMINATING_SIGNALS = new Set(["answer", "revise_needed", "escalate"]);

/**
 * Signal types that trigger a pausing transition.
 * These record the signal in the ledger AND set an evidence tag `paused`
 * so the FSM's transition system can detect the pause.
 */
const PAUSING_SIGNALS = new Set(["need_approval", "blocked", "need_clarification"]);

/**
 * Signal types that trigger a non-terminating handoff transition.
 * Recorded in the ledger with the handoff target payload, but does NOT
 * satisfy completion conditions by itself.
 */
const HANDOFF_SIGNALS = new Set(["handoff"]);

/**
 * Informational-only signal types. Recorded in the ledger but satisfy
 * no completion or pause conditions.
 */
const INFO_SIGNALS = new Set(["progress"]);

const ALL_SIGNAL_TYPES = new Set([
  ...TERMINATING_SIGNALS,
  ...PAUSING_SIGNALS,
  ...HANDOFF_SIGNALS,
  ...INFO_SIGNALS,
]);

export function createSignalTool() {
  return defineTool({
    description:
      "Emit an out-of-band control signal. Use this to indicate state transitions " +
      "(completion, approval requests, handoffs, etc.) without embedding signals in text content. " +
      "The 'type' determines what state transition occurs; 'payload' carries optional structured data " +
      "for the signal consumer.",
    args: {
      type: z.enum([
        "answer",
        "need_approval",
        "blocked",
        "need_clarification",
        "handoff",
        "progress",
        "revise_needed",
        "escalate",
      ]),
      payload: z.record(z.string(), z.unknown()).optional(),
    },
    async execute(input, context) {
      const { type, payload } = input;
      const sessionID = context.sessionID;

      // ── Safety net: reject unrecognized types ────────────────────────────
      // (Zod already catches at parse time; this guards against direct calls.)
      if (!ALL_SIGNAL_TYPES.has(type)) {
        throw new Error(`Unrecognized signal type: "${type}". Valid types: ${Array.from(ALL_SIGNAL_TYPES).join(", ")}`);
      }

      // ── Record the signal on every active function ───────────────────────
      const activeFns = functionSessionState.getActive(sessionID);
      const artifacts = new ArtifactStore(context.directory);
      let recordedOnCount = 0;

      for (const fnName of activeFns) {
        const st = functionRuntime.get(sessionID, fnName);
        if (!st) continue;

        // 1. Write the signal and its payload to the ledger
        recordSignal(st, type, payload);
        st.kv["__signal_type"] = type;

        // 2. Pausing signals: set evidence tag + mark phase as gated
        if (PAUSING_SIGNALS.has(type)) {
          st.evidenceObserved["paused"] = true;
          st.phase = "gated";
        }

        functionRuntime.markDirty();
        recordedOnCount++;

        log.debug("signal recorded", { fnName, type, phase: st.phase });
      }

      // ── Artifact capture: write payload when any active function
      //    has an observe spec with capture_payload_as for the signal tool ──
      //    (The observe system also handles this, but we do it here for
      //    direct-tool-call scenarios where observe may not fire.)
      if (payload !== undefined && activeFns.size > 0) {
        // Look up function specs to find capture_payload_as declarations
        // We import roleFunctionsMap lazily to avoid circular deps at module load
        try {
          const { roleFunctionsMap } = await import("../resolver/registry.ts");
          for (const [roleId, fns] of roleFunctionsMap) {
            for (const fn of fns) {
              if (!activeFns.has(fn.name)) continue;
              for (const obs of fn.observe ?? []) {
                if (obs.capture_payload_as && obs.tool === "signal") {
                  artifacts.write(sessionID, obs.capture_payload_as, JSON.stringify(payload));
                }
              }
            }
          }
        } catch (err) {
          log.warn("artifact capture: could not resolve roleFunctionsMap", err);
        }
      }

      // ── Build a meaningful response ──────────────────────────────────────
      const fnCount = activeFns.size;
      if (fnCount === 0) {
        return `signal: ${type} acknowledged (no active functions)`;
      }

      const parts: string[] = [`signal: ${type} acknowledged`];
      parts.push(`recorded on ${recordedOnCount} function(s)`);

      if (PAUSING_SIGNALS.has(type)) {
        parts.push("→ function paused");
      } else if (TERMINATING_SIGNALS.has(type)) {
        parts.push("→ satisfies continue_until condition");
      } else if (HANDOFF_SIGNALS.has(type)) {
        const target = payload?.["target"] ?? payload?.["subagent"] ?? "(unspecified)";
        parts.push(`→ handoff to ${target}`);
      } else if (INFO_SIGNALS.has(type)) {
        parts.push("→ informational (no state transition)");
      }

      return parts.join(" | ");
    },
  });
}
