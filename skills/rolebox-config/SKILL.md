---
name: rolebox-config
description: Configure rolebox roles, models, skills, functions, references, subagents, memory, hooks, graphs and harness integration. Use when creating or changing rolebox configuration, choosing its features, or diagnosing settings that do not take effect.
---

# Configure rolebox

Use this guide for the rolebox version that shipped it. Read the relevant local
reference instead of searching rolebox implementation files. Host tools can have
an MCP prefix; use the names and schemas actually registered in the session.

## Choose the configuration surface

| Goal | Read |
| --- | --- |
| Locate configuration, install/sync roles, select a host, set model aliases, project defaults or automatic role activation | [Configuration and hosts](references/configuration.md) |
| Author `role.yaml`, choose models, restrict tools, configure memory or nested subagents | [Roles](references/roles.md) |
| Add skills, reusable functions, activation rules or reference documents | [Assets and functions](references/assets.md) |
| Dispatch work, declare outcome graphs, set worker budgets or form a role team | [Orchestration](references/orchestration.md) |
| Configure hooks, error recovery, Copilot, notifications, browser/desktop access or LSP | [Runtime features](references/runtime.md) |

## Apply a change

1. Identify the active harness and workspace. Resolve environment overrides before
   selecting a file. A workspace `rolebox/` directory takes precedence over the
   harness's `rolebox/` directory; these trees are not merged.
2. Read the existing configuration and the relevant reference. Keep unrelated
   values. A directory name is a role ID; `name` is its display name.
3. Write the smallest supported configuration. Use an installed provider/model ID
   or configure an alias; an alias does not install a provider or credentials.
4. Verify YAML/JSON parsing and any referenced files, then reload/restart the host
   and inspect role/tool discovery. Use `asset_validate` when available for role
   resources. Its result does not validate every runtime option or host policy.
5. Report the changed files, how to activate the behavior, and what was actually
   verified. A setting being accepted by a parser does not prove it is effective.

`rolebox-config` is a global built-in skill, available even before any roles are
installed. Installation syncs it to existing harness homes; host startup and
`rolebox sync <target>` repair its link as well. Regular files/directories at the
destination are preserved. If installation scripts were disabled or a host was
installed later, run the sync command and restart that host for skill discovery.

Do not edit this installed skill to configure a role: it links into the package
and updates with rolebox. Put user configuration in the locations described by
the references. Configure only the task the user authorized; enabling a workflow
does not grant permission for external actions or override host permissions.
