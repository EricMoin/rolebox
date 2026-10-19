# Worker tools

Graph workers separate the host's tool catalog, the node's grant, and the tools
shown to the model. A small initial tool set can therefore use custom tools and
MCP integrations without loading every schema into its context.

## Declare capability and presentation

```json
{
  "version": 3,
  "name": "document-research",
  "nodes": [{
    "id": "research",
    "agent": "researcher",
    "prompt": "Find the project documentation and report the relevant evidence.",
    "outcomes": [{ "id": "done" }],
    "tools": ["docs_*"],
    "toolPresentation": {
      "mode": "discover",
      "preload": ["docs_search"]
    }
  }],
  "edges": []
}
```

Use the actual registered tool names from your host. MCP naming conventions
vary between hosts; `docs_*` above is an example. Connect the MCP server or load
the custom tool through the host first. A grant does not register a tool, install
an integration, or supply credentials.

`tools` accepts exact names and trailing-star prefixes with a nonempty stem.
Names are trimmed, deduplicated and sorted; a declaration may contain at most 32
entries. A prefix can select a larger catalog. A bare `*` does not grant all
tools. The `graph_` namespace cannot be authorized through this list.

`toolPresentation` accepts the following modes:

| Mode | Initial model view | Additional capabilities |
| --- | --- | --- |
| `native` | The worker baseline and granted native tools | Direct host tool calls |
| `discover` | The baseline, preloaded tools and `graph_worker_tools` | Search/list the authorized catalog; describe a tool to load its schema |
| `code` | The baseline, preloaded tools, `graph_worker_tools` and `graph_worker_code` | Inspect schemas and compose authorized calls in JavaScript |

`preload` contains at most 32 exact host names, each already covered by `tools`.
It changes visibility only. Unknown configuration fields, invalid modes,
wildcard preloads and preloads outside the grant are rejected during compilation.

Omitting the presentation preserves the host's existing native behavior. Omitting
both fields preserves the existing worker baseline: dsh uses
`graph_worker_exec` and `graph_submit_outcome`; other hosts retain their native
worker tools. The configuration is part of the compiled plan revision and is
restored from that plan after a restart.

With an explicit presentation, Pi and OpenCode 2 use `bash` and
`graph_submit_outcome` as their baseline, then add the declared tools and the
selected discovery entry. dsh retains its two baseline entries in every mode.

## Discovery and invocation

`graph_worker_tools` lists or searches names, descriptions and sources. Results
are paginated and omit full schemas until a tool is described. A describe call
in discovery mode activates that tool where the host supports native activation.
The broker's call operation is available only when the host exposes invocation
through its complete execution pipeline. Otherwise, describe the tool and call
its native entry.

Only registered tools within the node's grant appear in the catalog. Listing by
source or paging through the catalog provides a fallback when a text search has
no matches. Calls recheck registration and authorization; discovery never changes
the grant. Ambiguous duplicate names are omitted rather than routed arbitrarily.
Source filtering is available when the adapter has source metadata. dsh does
not expose a reliable provider/source field, so its tools are searched by name
and description; use the registered namespace in the query instead of guessing
a provider identifier.

## Host support

| Host | Native | Discovery | Code invocation |
| --- | --- | --- | --- |
| dsh | Registered built-in, custom and MCP tools | Native schema activation and broker invocation | Granted host tools through the host registry |
| Pi | Tools actually loaded in the worker process | Native schema activation | Explicitly unsupported |
| OpenCode 1.x | Existing default behavior; explicit presentation unsupported | Explicitly unsupported | Explicitly unsupported |
| OpenCode 2 | Tools in the worker's actual session context | Native schema activation | Explicitly unsupported |

Pi and OpenCode do not provide an extension API for invoking tools through the
complete native execution pipeline, including other plugins' permission hooks.
Their adapters reject code mode before starting the worker and reject broker
call operations. Native calls continue through the host's normal tool pipeline.
OpenCode 1.x also lacks an independent tool-presentation hook: its prompt-level
tool switches change permission rules, and its exposed registry does not include
the complete MCP catalog. It therefore rejects any explicit `toolPresentation`
configuration and preserves existing default behavior and host permissions.
OpenCode 2 reads its catalog from the tools assembled for the worker's model
request, so custom and MCP tools are checked before the first model call and
the discovery catalog updates with subsequent turns.
Codex's rolebox MCP server
does not own worker sessions, so these graph presentation modes do not configure
Codex subagents.

Adapters invoke tools as the original worker through the host's available
execution boundary. Host permissions, approval handling and cancellation still
apply. A host that cannot execute a requested tool through that boundary reports
the limitation explicitly; a declared name is not evidence of host support.

## JavaScript composition

The `graph_worker_code` source is an async JavaScript function body:

```javascript
const matches = await tools.call("docs_search", { query: "project setup" });
emit(matches);
return { checked: true };
```

Inspect the tool's schema and return format before writing a workflow. The code
environment supports `tools.list`, `tools.describe`, `tools.call(name, args)` and
`tools.<registered_name>(args)`. Use `emit(value)` to return selected results,
including rich tool results. Intermediate values stay inside the execution
environment unless returned or emitted. Completion remains a separate
`graph_submit_outcome` call; scripts cannot call graph control or completion tools.

Each script runs in a disposable child process with a restricted VM environment
and limits on duration, calls and data volume. Cancellation or timeout terminates
the process and signals in-flight host calls, allowing up to one second for them
to settle. An error reports `pendingCalls` if a tool ignores cancellation and is
still running after that grace period. Returning before awaiting all host calls
also fails and cancels those calls. Execution does not roll back side effects.
This runtime is not an OS security boundary. Workspace commands continue to use
the host's native command tool and sandbox policy.

The broker preserves tool result structure, including errors and rich content.
Adapters translate rich results into their host's attachment/content format.
Transport-specific failures are surfaced instead of reported as successful calls.

## Validate a configuration

Keep task capability coverage separate from tool-presentation quality. A task
that needs an external integration cannot fairly compare against a baseline
that lacks that integration. Compare native, discovery and code modes with the
same grants and fixtures, then measure task success, total tokens, elapsed time,
tool-selection errors and argument retries for each model and workload.

Regression coverage lives under `tests/graph/worker-tool-presentation.test.ts`,
`tests/platform/worker-tools/`, and the host adapters' scoped test files. Run
those slices with `bun test --isolate`, followed by `bun run typecheck`.
