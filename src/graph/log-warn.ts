// ── Graph engine warning logger ─────────────────────────────────────────────
//
// One dependency-free warning sink for the engine modules (B27). Each engine
// file used to carry its own private `logWarn` copy — three identical console
// calls kept local because importing the shared sub-logger (`src/logger.ts`)
// would add an import edge the leaf modules do not need. Consolidating them
// keeps the console call in exactly one place and gives every engine warning a
// single, greppable definition.
//
// This module is deliberately a leaf: ZERO imports, so any engine module may
// depend on it without creating a cycle.

/** Emit one engine warning on the console. */
export function logWarn(message: string): void {
  console.warn(message);
}
