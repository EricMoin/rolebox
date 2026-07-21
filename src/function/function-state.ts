import { defineTool, type CanonicalToolContext } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { functionRuntime } from "./runtime-state.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { roleFunctionsMap } from "../resolver/registry.ts";
import type { ResolvedFunction } from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("search:function-state");

/**
 * Build a flat name → spec lookup from all entries in roleFunctionsMap.
 * First registration wins for name collisions across roles.
 */
function buildFnSpecMap(): Map<string, ResolvedFunction> {
  const map = new Map<string, ResolvedFunction>();
  for (const [, fns] of roleFunctionsMap) {
    for (const fn of fns) {
      if (!map.has(fn.name)) {
        map.set(fn.name, fn);
      }
    }
  }
  return map;
}

export function createFunctionStateTool(directory: string) {
  const artifactStore = new ArtifactStore(directory);


  return defineTool({
    description:
      "Query the current session's function state machine — lists active functions, their phase, gate status, evidence tags, artifact status (produced/consumed), continuation count, and pending transitions. Rolebox-specific: opencode has no native concept of function state machines.",
    args: {
      session_id: z
        .string()
        .optional()
        .describe("Session ID to inspect (defaults to current tool context session)"),
      include_artifacts: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include artifact file status for each function (default true)"),
      include_evidence: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include evidence observation tags (default true)"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("Output format: 'markdown' for human-readable, 'json' for machine parsing"),
    },
    async execute(input, context: CanonicalToolContext) {
      const sessionID = input.session_id ?? context.sessionID;
      const states = functionRuntime.all(sessionID);
      const fnSpecMap = buildFnSpecMap();

      if (states.size === 0) {
        if (input.format === "json") {
          return JSON.stringify({ sessionID, activeFunctions: [] }, null, 2);
        }
        return `## Function State: \`${sessionID}\`\n\nNo active functions in this session.`;
      }

      // Collect all session artifacts once if needed
      const allArtifacts = input.include_artifacts !== false
        ? new Set(artifactStore.list(sessionID))
        : null;

      // ── Build structured data for both JSON and markdown ────────────────
      const stateEntries: Array<{
        fnName: string;
        phase: string;
        gate: unknown;
        gateSatisfied: boolean | null;
        evidence: Record<string, boolean> | null;
        artifact: { produces: string; consumes: string; convention: string } | null;
        continuationCount: number;
      }> = [];

      for (const [fnName, st] of states) {
        const spec = fnSpecMap.get(fnName);
        stateEntries.push({
          fnName,
          phase: st.phase,
          gate: spec?.gate ?? null,
          gateSatisfied: spec?.gate !== undefined ? st.gateSatisfied : null,
          evidence: input.include_evidence !== false ? Object.fromEntries(
            Object.entries(st.evidenceObserved).map(([k, v]) => [k, v]),
          ) : null,
          artifact: (input.include_artifacts !== false && spec) ? {
            produces: spec.produces ?? "",
            consumes: spec.consumes ?? "",
            convention: allArtifacts?.has(fnName) ? fnName : "",
          } : null,
          continuationCount: st.continuationCount,
        });
      }

      if (input.format === "json") {
        const jsonOutput: Record<string, unknown> = {
          sessionID,
          activeFunctions: stateEntries.map((e) => ({
            function: e.fnName,
            phase: e.phase,
            gate: e.gate,
            gateSatisfied: e.gateSatisfied,
            evidenceObserved: e.evidence,
            produces: e.artifact?.produces || undefined,
            consumes: e.artifact?.consumes || undefined,
            continuationCount: e.continuationCount,
          })),
        };
        if (allArtifacts && allArtifacts.size > 0) {
          jsonOutput.artifacts = Array.from(allArtifacts).sort();
        }
        return JSON.stringify(jsonOutput, null, 2);
      }

      // ── Main table (markdown) ───────────────────────────────────────────
      const header = "| Function | Phase | Gate | Evidence | Artifacts | Cont. |";
      const separator = "|---|---|---|---|---|---|";
      const rows: string[] = [];

      for (const entry of stateEntries) {
        const { fnName, phase, gateSatisfied, evidence, artifact, continuationCount } = entry;

        const gateStr = gateSatisfied === null ? "—" : gateSatisfied ? "✅" : "❌";
        let evidenceStr = "—";
        if (evidence && Object.keys(evidence).length > 0) {
          evidenceStr = Object.entries(evidence)
            .map(([tag, v]) => (v ? `✅ ${tag}` : `⏳ ${tag}`))
            .join(", ");
        }
        let artifactStr = "—";
        if (artifact && allArtifacts) {
          const parts: string[] = [];
          if (artifact.produces) {
            parts.push(`${allArtifacts.has(artifact.produces) ? "✅" : "⏳"} produces:\`${artifact.produces}\``);
          }
          if (artifact.consumes) {
            parts.push(`${allArtifacts.has(artifact.consumes) ? "✅" : "⏳"} consumes:\`${artifact.consumes}\``);
          }
          if (artifact.convention && allArtifacts.has(artifact.convention)) {
            parts.push(`✅ \`${artifact.convention}\``);
          }
          if (parts.length > 0) artifactStr = parts.join(", ");
        }

        rows.push(
          `| ${fnName} | ${phase} | ${gateStr} | ${evidenceStr} | ${artifactStr} | ${continuationCount} |`,
        );
      }

      let output =
        `## Function State: \`${sessionID}\`\n\n${header}\n${separator}\n${rows.join("\n")}`;

      // ── All session artifacts section ───────────────────────────────────
      if (allArtifacts && allArtifacts.size > 0) {
        const artifactList = Array.from(allArtifacts).sort();
        const artifactRows = artifactList.map((name) => `- \`${name}\` ✅`);
        output += `\n\n### Session Artifacts (${allArtifacts.size})\n\n${artifactRows.join("\n")}`;
      }

      // ── Pending transitions section ─────────────────────────────────────
      const transitionBlocks: string[] = [];
      for (const [fnName, st] of states) {
        const spec = fnSpecMap.get(fnName);
        if (!spec?.transitions || spec.transitions.length === 0) continue;

        const gateNote =
          spec.gate !== undefined
            ? st.gateSatisfied
              ? "✅ gate satisfied"
              : "❌ gate blocked"
            : "— no gate defined";

        transitionBlocks.push(`### ${fnName} — ${gateNote}`);
        for (let i = 0; i < spec.transitions.length; i++) {
          const t = spec.transitions[i];
          const whenRaw =
            typeof t.when === "string"
              ? t.when
              : JSON.stringify(t.when);
          const activate =
            t.activate?.length
              ? t.activate.map((a) => `\`${a}\``).join(", ")
              : "—";
          const deactivate =
            t.deactivate?.length
              ? t.deactivate.map((d) => `\`${d}\``).join(", ")
              : "—";
          transitionBlocks.push(`- **${i + 1}.** when: \`${whenRaw}\``);
          transitionBlocks.push(`  - activate: ${activate}`);
          transitionBlocks.push(`  - deactivate: ${deactivate}`);
        }
      }

      if (transitionBlocks.length > 0) {
        output += `\n\n## Pending Transitions\n\n${transitionBlocks.join("\n")}`;
      }

      return output;
    },
  });
}
