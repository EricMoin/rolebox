# Node runtime and development

The CLI, build scripts, tests, and CI use Node.js 26.4 or newer and npm. The
version used in CI is recorded in `.node-version`; `package-lock.json` pins the
dependency tree.

```sh
npm ci
npm run build
npm run typecheck
npm run typecheck:tests
```

Published entry points contain compiled ESM JavaScript. Development scripts use
`tsx` to load TypeScript; installed consumers do not need that loader.

The OpenTUI sidebar requires `--experimental-ffi` when its host runs on Node.
Its Solid components are compiled using the universal JSX transform and share
the client Solid runtime with OpenTUI. Ordinary CLI and MCP commands need no FFI
flag. Embedded hosts retain control of their own runtime.

The SQLite driver uses only `node:sqlite`, and worker subprocesses use Node.js.
OpenTUI's upstream dependency is named `bun-ffi-structs`, but its Node backend
uses `node:ffi`; the name does not require installing another runtime.

## Verification

Run module-scoped slices during development:

```sh
npm test -- tests/memory/
npm test -- tests/cli/commands/install.test.ts
npm run test:tui
```

Vitest uses isolated fork workers. Tests have separate temporary directories and
log destinations, and subprocess fixtures use Node. Mock factories that depend
on local state use `vi.doMock` before dynamically importing their consumers.

The browser acceptance runner builds the package, checks the affected modules,
and drives all 23 browser tools on Chromium, Firefox, and WebKit. It also tests
the built Node MCP server, host adapters, cancellation, CDP ownership, and clean
shutdown. Install browser binaries first:

```sh
npx playwright install chromium firefox webkit
npm run test:browse:e2e
```

The package check packs an isolated copy, installs the tarball in a temporary
consumer, checks public ESM exports and declarations, starts its MCP server,
and loads its TUI with Node FFI:

```sh
npm run test:package
```

The installed Pi and dsh SDKs also run deterministic local model fixtures. These
checks exercise graph execution, accepted inputs, cancellation, node retries,
approvals, plugin reload and process recovery. The dsh check uses the host's
real workspace-write sandbox and verifies that a file outside its writable
roots cannot be changed. It needs a supported POSIX sandbox backend:

```sh
npm run test:hosts:e2e
```

CI runs the complete core and TUI suites on Linux, macOS, and Windows, plus
ordered mock-isolation guards, randomized suites, Linux browser acceptance and
macOS real SDK host acceptance.
The complete suite remains a CI or explicitly requested pre-release check.
