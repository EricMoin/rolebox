import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { codexRecord } from "../../../../../platform/adapters/codex/app-server/app-server.ts";
import { DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES, probeCodexDesktopBridge, type CodexDesktopBinding } from "../../../../../platform/adapters/codex/desktop/bridge.ts";
import { CodexParentNotifications } from "../../../../../platform/adapters/codex/graph/parent-notifications.ts";

export function readCodexDesktopBinding(path: string): CodexDesktopBinding {
  try {
    const binding = codexRecord(JSON.parse(readFileSync(path, "utf8")));
    if (!binding || ["pluginRoot", "nodePath", "pipePath"].some(key => typeof binding[key] !== "string")) throw new Error();
    return { pluginRoot: binding.pluginRoot as string, nodePath: binding.nodePath as string, pipePath: binding.pipePath as string };
  } catch { throw new Error("Desktop binding must be JSON with pluginRoot, nodePath and pipePath strings"); }
}

export default defineCommand({
  meta: { name: "probe", description: "Probe the original Codex desktop MCP through an explicit desktop binding (experimental, Unix)" },
  args: {
    binding: { type: "string", required: true, description: "JSON file containing the current desktop binding" },
    thread: { type: "string", description: "Existing desktop thread ID; defaults to CODEX_THREAD_ID" },
    socket: { type: "string", description: "Existing shared app-server Unix socket; defaults to rolebox parent discovery" },
    "peer-log": { type: "string", description: "Current desktop main-process log for new peer rejection evidence" },
    "timeout-ms": { type: "string", default: "10000", description: "MCP probe deadline, 1–60000 milliseconds" },
    "max-response-bytes": { type: "string", default: String(DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES), description: "Maximum bytes per MCP response line, 1024–104857600" },
    report: { type: "string", description: "Write the sanitized JSON report to this file" },
  },
  async run({ args }) {
    const threadId = args.thread?.trim() || process.env.CODEX_THREAD_ID?.trim();
    if (!threadId) throw new Error("Provide --thread or run inside the target Codex chat");
    const binding = readCodexDesktopBinding(args.binding);
    const parent = new CodexParentNotifications({ env: { ...process.env,
      ...(args.socket ? { ROLEBOX_CODEX_PARENT_SOCKET: args.socket } : {}) } });
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const bridge = await probeCodexDesktopBridge({ binding, threadId, parent,
        peerLogPath: args["peer-log"], timeoutMs: Number(args["timeout-ms"]),
        maxResponseBytes: Number(args["max-response-bytes"]), signal: abort.signal });
      const report = { bridge, parentNotificationAvailableAfter: (await parent.inspect(threadId)).available,
        hostConfigurationChanged: false };
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (args.report) {
        mkdirSync(dirname(args.report), { recursive: true });
        writeFileSync(args.report, text, { mode: 0o600 }); chmodSync(args.report, 0o600);
      }
      process.stdout.write(text);
      if (bridge.status !== "ready") process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); parent.close();
    }
  },
});
