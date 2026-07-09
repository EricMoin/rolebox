import { tool, type ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import { functionRuntime } from "./runtime-state.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { roleFunctionsMap } from "../index.ts";
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


  return tool({
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
    },
    async execute(input, context: ToolContext) {
      const sessionID = input.session_id ?? context.sessionID;
      const states = functionRuntime.all(sessionID);
      const fnSpecMap = buildFnSpecMap();

      if (states.size === 0) {
        return `## Function State: \`${sessionID}\`\n\nNo active functions in this session.`;
      }

      // Collect all session artifacts once if needed
      const allArtifacts = input.include_artifacts !== false
        ? new Set(artifactStore.list(sessionID))
        : null;

      // ── Main table ──────────────────────────────────────────────────────
      const header = "| Function | Phase | Gate | Evidence | Artifacts | Cont. |";
      const separator = "|---|---|---|---|---|---|";
      const rows: string[] = [];

      for (const [fnName, st] of states) {
        const spec = fnSpecMap.get(fnName);

        // Gate column
        let gateStr: string;
        if (spec?.gate !== undefined) {
          gateStr = st.gateSatisfied ? "✅" : "❌";
        } else {
          gateStr = "—";
        }

        // Evidence column
        let evidenceStr = "—";
        if (input.include_evidence !== false) {
          const tags = Object.keys(st.evidenceObserved);
          if (tags.length > 0) {
            evidenceStr = tags
              .map((tag) => (st.evidenceObserved[tag] ? `✅ ${tag}` : `⏳ ${tag}`))
              .join(", ");
          }
        }

        // Artifact column
        let artifactStr = "—";
        if (input.include_artifacts !== false && allArtifacts) {
          const parts: string[] = [];
          // Artifact this function produces
          if (spec?.produces) {
            const exists = allArtifacts.has(spec.produces);
            parts.push(`${exists ? "✅" : "⏳"} produces:\`${spec.produces}\``);
          }
          // Artifact this function consumes
          if (spec?.consumes) {
            const exists = allArtifacts.has(spec.consumes);
            parts.push(`${exists ? "✅" : "⏳"} consumes:\`${spec.consumes}\``);
          }
          // Convention-based: artifact named after the function
          if (allArtifacts.has(fnName)) {
            parts.push(`✅ \`${fnName}\``);
          }
          if (parts.length > 0) artifactStr = parts.join(", ");
        }

        rows.push(
          `| ${fnName} | ${st.phase} | ${gateStr} | ${evidenceStr} | ${artifactStr} | ${st.continuationCount} |`,
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
