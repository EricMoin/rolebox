import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";

export function createLspServersTool(
  clientManager: LspClientManager,
) {
  return defineTool({
    description:
      "List all detected and running language servers with status, PID, capabilities summary, and uptime.",
    args: {},
    async execute() {
      const running = clientManager.getRunningServers();
      const allDetected = clientManager.detectedLanguages;

      const lines = ["## Language Servers", ""];

      if (running.length === 0 && allDetected.length === 0) {
        return "No language servers detected or running.";
      }

      // Build a set of already-started language IDs
      const runningIds = new Set(running.map((s) => s.languageId));

      // Running servers
      if (running.length > 0) {
        lines.push("### Running");
        lines.push("");
        lines.push("| Language | PID | Status | Uptime | Capabilities |");
        lines.push("|----------|-----|--------|--------|--------------|");

        for (const server of running) {
          const uptimeMs = Date.now() - server.startedAt.getTime();
          const uptime = formatUptime(uptimeMs);
          const capSummary = summarizeCapabilities(server.capabilities);
          lines.push(
            `| ${server.languageId} | ${server.pid} | ${server.status} | ${uptime} | ${capSummary} |`,
          );
        }
        lines.push("");
      }

      // Detected but not running
      const notStarted = allDetected.filter((id) => !runningIds.has(id));
      if (notStarted.length > 0) {
        lines.push("### Detected (Not Started)");
        lines.push("");
        for (const id of notStarted) {
          lines.push(`- ${id}`);
        }
        lines.push("");
      }

      // Servers that have been started but are now dead/failed
      const deadOrFailed = running.filter(
        (s) => s.status === "dead" || s.status === "failed",
      );
      if (deadOrFailed.length > 0) {
        lines.push("### Stopped / Failed");
        lines.push("");
        for (const s of deadOrFailed) {
          lines.push(`- ${s.languageId} (PID ${s.pid}): ${s.status}`);
        }
        lines.push("");
      }

      return lines.join("\n");
    },
  });
}

export function createLspRestartServerTool(
  clientManager: LspClientManager,
) {
  return defineTool({
    description:
      "Restart a language server by language ID. " +
      "This shuts down the current server process and starts a fresh one. " +
      "Returns confirmation with new PID and status.",
    args: {
      languageId: z
        .string()
        .describe("Language ID of the server to restart (e.g. 'typescript', 'python', 'go')"),
    },
    async execute(input) {
      try {
        const langId = input.languageId;

        // Check if the language is in the detected set
        const registered = clientManager.detectedLanguages.includes(langId);
        if (!registered) {
          return `Language '${langId}' is not in the detected server list. Available: ${clientManager.detectedLanguages.join(", ") || "(none)"}`;
        }

        await clientManager.restartServer(langId);

        const servers = clientManager.getRunningServers();
        const server = servers.find((s) => s.languageId === langId);

        if (server) {
          return [
            `## Server Restarted: ${langId}`,
            "",
            `Status: ${server.status}`,
            `PID: ${server.pid}`,
            `Started at: ${server.startedAt.toISOString()}`,
          ].join("\n");
        }

        return `Server '${langId}' restart initiated but server not found in running list.`;
      } catch (err: any) {
        return `Error restarting server: ${err.message ?? String(err)}`;
      }
    },
  });
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function summarizeCapabilities(caps: any): string {
  if (!caps) return "N/A";
  const features: string[] = [];

  const textDoc = caps.textDocumentSync ? "sync" : null;
  if (textDoc) features.push(textDoc);

  const check = (path: string, label: string) => {
    const parts = path.split(".");
    let current: any = caps;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return;
      current = current[part];
    }
    if (current != null && current !== false) {
      features.push(label);
    }
  };

  check("completionProvider", "completion");
  check("hoverProvider", "hover");
  check("definitionProvider", "goto-def");
  check("referencesProvider", "references");
  check("documentHighlightProvider", "highlight");
  check("documentSymbolProvider", "symbols");
  check("codeActionProvider", "code-action");
  check("documentFormattingProvider", "format");
  check("renameProvider", "rename");
  check("foldingRangeProvider", "folding");
  check("selectionRangeProvider", "selection");
  check("semanticTokensProvider", "semantic-tokens");
  check("inlayHintProvider", "inlay-hints");
  check("codeLensProvider", "code-lens");
  check("callHierarchyProvider", "call-hierarchy");
  check("typeHierarchyProvider", "type-hierarchy");
  check("documentLinkProvider", "links");
  check("colorProvider", "colors");

  return features.length > 0 ? features.join(", ") : "basic";
}
