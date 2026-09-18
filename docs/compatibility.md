# Compatibility

> Part of the rolebox documentation. See [README](../README.md) for overview.

Works alongside oh-my-openagent. Rolebox roles appear in the agent list and skills are discoverable by the skill tool. No conflicts.

## Pi parity status

Rolebox's Pi extension (`src/entries/pi.ts`) registers the full shared opencode tool surface through `PiLightweightServiceStack`; parity is enforced by `tests/pi-parity.test.ts`.

On Pi, rolebox resolves its directories under the pi config directory (`$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`): roles load from `{cwd}/rolebox` when present, else `~/.pi/agent/rolebox`; global skills resolve from `~/.pi/agent/skills`. Deploy installed roles there with `rolebox sync pi`. The dsh plugin resolves the same layout under `$DSH_HOME` / `~/.dsh` (see [dsh-plugin-contract.md](dsh-plugin-contract.md) §5.1); use `rolebox sync dsh`.

## Codex parity status

Rolebox's Codex integration (`src/platform/adapters/codex/`, served by `rolebox mcp` / `src/entries/codex.ts`) exposes the canonical tool intersection for a harness with no session client and no dispatch backend, plus `load_role_skill` — 15 tools. Parity is enforced by `tests/platform/codex-mcp.test.ts`; `tests/platform/codex-platform.test.ts` covers path resolution and registration detection, and `tests/cli/codex-sync.test.ts` covers the generated plugin bundle.

On Codex, rolebox resolves its directories under the Codex home (`$CODEX_HOME` when set, otherwise `~/.codex`): roles load from `{cwd}/rolebox` when present, else `~/.codex/rolebox`; global skills resolve from `~/.codex/skills`. Deploy installed roles there with `rolebox sync codex`, which also writes the local plugin marketplace and registers it in `~/.codex/config.toml`. See [codex.md](codex.md).

## Parity matrix

| Tool surface | Opencode | Pi | Codex |
| --- | --- | --- | --- |
| hashline_read / hashline_edit | ✓ | ✓ | ✓ |
| memory_write / memory_recall / memory_list / memory_update | ✓ | ✓ | ✓ (no `memory_update`) |
| web_search / web_read / web_fetch | ✓ | ✓ | ✓ |
| signal | ✓ | ✓ | ✓ |
| interactive_terminal | ✓ | ✓ | ✓ |
| asset_search / asset_inspect / asset_validate | ✓ | ✓ | ✓ |
| reference_search | ✓ | ✓ | ✓ |
| load_role_skill | — (native skill tool) | ✓ | ✓ |
| session_list / session_read / session_search / session_info / session_diff / session_fork | ✓ | ✓ | — (not over MCP) |
| graph_create / graph_add_node / graph_add_edge / graph_add_loop / graph_run / graph_status / graph_cancel / graph_approve | ✓ | ✓ | — (not over MCP) |
| task_search / task_budget / task_graph / task_chronology / task_export (task_retry withheld) | ✓ | ✓ | — (not over MCP) |
| lsp_* (32 tools) | ✓ | ✓ | — (not over MCP) |
| function_graph / skill_compose / context_assemble | ✓ | ✓ | — (not over MCP) |
| asset_hot_reload | ✓ | — (opencode-only) | — (opencode-only) |
| dispatch_* / loop_* | — (withheld) | — (withheld) | — (not over MCP) |
| task_retry | — (withheld) | — (withheld) | — (withheld) |

Remaining platform-inherent gaps (hot reload, extensions, recovery engine, TUI) are explicit non-goals on Pi and Codex — see [limitations.md](limitations.md).
