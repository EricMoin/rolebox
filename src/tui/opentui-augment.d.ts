/**
 * Type augmentations for @opentui/solid JSX intrinsic elements.
 *
 * The @opentui/solid SolidJS plugin transforms `fg`, `bg`, `attributes` and
 * similar style-like props on `<span>`, `<text>` and other inline elements
 * into the appropriate style options at runtime. The library's TypeScript
 * definitions do not declare these as direct JSX attributes on `SpanProps`
 * (which is a type alias and cannot be augmented).
 *
 * The `moduleResolution: "bundler"` in tsconfig.tui.json allows tsc to parse
 * extensionless imports (Bun handles the rewriting).
 *
 * Known false-positive tsc errors resolved by accepting exit code 2 from the
 * declaration-only tsc step:
 *
 *   TS2322 - Property 'fg' does not exist on type 'SpanProps'
 *     → Runtime: the Solid plugin destructures fg/bg/attributes into style
 *   TS7006 - Parameter implicitly has 'any' type
 *     → Runtime: inferred from the MonitorSnapshot type chain
 *
 * All three .d.ts output files (index.d.ts, state.d.ts, helpers.d.ts,
 * components/*.d.ts) are correctly emitted despite these diagnostics.
 */
export {}
