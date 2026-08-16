# Compatibility

> Part of the rolebox documentation. See [README](../README.md) for overview.

Works alongside oh-my-openagent. Rolebox roles appear in the agent list and skills are discoverable by the skill tool. No conflicts.

## Pi parity status

Rolebox's Pi extension (`src/pi-extension.ts`) registers the full shared opencode tool surface through `PiLightweightServiceStack`; parity is enforced by `tests/pi-parity.test.ts`.

| Tool surface | Opencode | Pi |
| --- | --- | --- |
| hashline_read / hashline_edit | ✓ | ✓ |
| memory_write / memory_recall / memory_list / memory_update | ✓ | ✓ |
| web_search / web_read / web_fetch | ✓ | ✓ |
| signal | ✓ | ✓ |
| asset_search / asset_inspect / asset_validate | ✓ | ✓ |
| reference_search | ✓ | ✓ |
| session_list / session_read / session_search / session_info / session_diff / session_fork | ✓ | ✓ |
| graph_create / graph_add_node / graph_add_edge / graph_add_loop / graph_run / graph_status / graph_cancel / graph_approve | ✓ | ✓ |
| task_search / task_budget / task_graph / task_concurrency / task_chronology / task_export (task_retry withheld) | ✓ | ✓ |
| lsp_* (32 tools) | ✓ | ✓ |
| function_graph / skill_compose / context_assemble | ✓ | ✓ |
| asset_hot_reload | ✓ | — (opencode-only) |
| dispatch_* / loop_* | — (withheld) | — (withheld) |
| task_retry | — (withheld) | — (withheld) |

Remaining platform-inherent gaps (hot reload, extensions, recovery engine, TUI) are explicit non-goals on Pi — see [limitations.md](limitations.md).
