/**
 * Graph domain — the neutral P1 model barrel
 *
 * The single import surface for the new domain model of P1:
 *
 * - `./join.ts` — the join vocabulary and its ONE resolver;
 * - `./budget.ts` — the declared budget specs and the consumption state;
 * - `./model.ts` — the field-ownership declarations for the P1 vocabulary;
 * - `./load-result.ts` — the load-result vocabulary (absent / valid / corrupt /
 *   unsupported / migration-required).
 *
 * Every module behind this barrel is a dependency leaf with respect to the
 * retired v2 type containers: none of them imports either one, and the record
 * references in `model.ts` are `import type` only, so importing the barrel
 * adds no runtime dependency.
 */

export * from "./budget.ts";
export * from "./join.ts";
export * from "./load-result.ts";
export * from "./model.ts";
