/**
 * tsc has no notion of bun's cache-busted query-string specifiers.
 *
 * tests/helpers/paths-mock.ts statically imports the REAL src/cli/paths.ts
 * through `../../src/cli/paths.ts?real` so that a `mock.module("src/cli/paths")`
 * registered by another test file cannot shadow it. Both the static form and
 * the distinct specifier are load-bearing there (see that file's header for
 * why), so the specifier cannot be rewritten into something tsc resolves.
 * The type checker therefore cannot resolve it (TS2307), and every consumer of
 * the helper inherited the error.
 *
 * This declares the specifier's runtime identity — it IS src/cli/paths.ts —
 * using the real module's type rather than `any`, so a change to that module's
 * export surface breaks this declaration instead of silently detyping the
 * spread in createPathsMockPayload().
 */
declare module "*?real" {
  export * from "../src/cli/paths.ts";
}
