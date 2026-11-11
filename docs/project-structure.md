# Repository structure

This page describes the source checkout. For installed role and skill directories,
see [Configuration directory structure](directory-structure.md).

## Top-level directories

| Directory | Responsibility |
| --- | --- |
| `src/` | Runtime modules and harness entry points |
| `tests/` | Module tests, integration scenarios and test helpers |
| `scripts/` | Build, package, compatibility and acceptance commands |
| `skills/`, `functions/`, `examples/` | Packaged configuration guides and reusable assets |
| `docs/` | Feature and contributor documentation |
| `dist/` | Generated build output; never edit it directly |

## Platform adapters

`src/entries/` contains the published harness entry points. Shared host contracts
and the adapters implementing them live under `src/platform/`:

```text
src/platform/
├── ports/                 # Session, tool, event and registration contracts
├── system/                # Operating-system facts and process command rules
├── model-catalog/         # Host model discovery
├── worker-tools/          # Shared graph-worker tool surfaces
└── adapters/
    ├── dsh/
    │   ├── index.ts       # Existing adapter exports
    │   ├── roles/
    │   ├── session/
    │   ├── context/
    │   ├── memory/
    │   ├── execution/
    │   ├── hooks/
    │   ├── tools/
    │   └── web/
    │       ├── routes/
    │       └── ui/
    ├── pi/
    │   ├── index.ts
    │   ├── service-stack.ts
    │   ├── roles/
    │   ├── session/
    │   ├── execution/
    │   ├── hooks/
    │   └── tools/
    ├── codex/
    │   ├── index.ts
    │   ├── runtime.ts
    │   ├── session.ts
    │   ├── tool-policy.ts
    │   ├── mcp/
    │   ├── app-server/
    │   ├── installation/
    │   ├── graph/
    │   └── desktop/
    ├── opencode/
    └── opencode2/
```

Adapter roots hold their facade and host-wide composition. Put implementation
modules in the area that owns their behavior: session lifecycle in `session/`,
worker execution in `execution/`, and HTTP routes in `web/routes/`. DSH browser
components belong in `web/ui/`, apart from the Node host implementation.
The smaller OpenCode adapters retain their existing flat layout.

Shared contracts, capabilities, registry and tool assembly remain in the common
platform layer. Keep host SDK details inside their adapter. Use direct imports
between implementation modules; do not add a barrel merely to shorten a path.
Published package exports remain defined by `package.json`, not by directory names.

Native desktop drivers follow the same ownership rule under
`src/computer/drivers/{darwin,linux,win32}/`. Each platform owns its script manifest
and `scripts/` directory; the build inlines those scripts into the library and TUI.

## Tests follow source ownership

```text
tests/
├── platform/
│   ├── adapters/<host>/<area>/
│   ├── model-catalog/
│   ├── system/
│   └── worker-tools/
├── entries/<host>/        # Harness startup and entry wiring
├── function/
├── copilot/
├── loader/
├── resolver/
├── sync/
├── terminal/
├── scripts/               # Tests of repository commands
├── integration/           # Scenarios spanning modules or hosts
├── helpers/               # Shared test scaffolding
├── logger.test.ts         # Corresponds to src/logger.ts
└── project-config.test.ts # Corresponds to src/project-config.ts
```

Other module tests retain their matching directories, such as `tests/graph/`,
`tests/dispatch/`, `tests/computer/` and `tests/tui/`. A test covering several parts
of one module can stay in that module; cross-host scenarios belong in
`tests/integration/`. Keep feature-specific fixtures with their tests.

Name tests for their subject without repeating the host prefix. For example,
`src/platform/adapters/dsh/session/session-focus.ts` is covered under
`tests/platform/adapters/dsh/session/session-focus.test.ts`.

Run the affected slices and the project type checks:

```sh
npm test -- tests/platform/adapters/dsh/
npm test -- tests/function/
npm run typecheck
npm run typecheck:tests
```

When moving a module, update static and dynamic imports, mocks, fixture URLs,
source-scanning guards, script and CI test selections, and documentation links.
Changes to emitted paths also need a build and packed-consumer verification.
Keep Vitest isolation enabled and leave the full repository suite to CI.
