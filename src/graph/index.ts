// ── Graph Engine v2: parsing & structural validation ───────────────────
//
// Public barrel for the v2 graph declaration surface. It currently has ZERO
// in-repo consumers (`grep -rn "graph/index" src tests scripts package.json`
// finds none — the tools layer imports `parser-v2.ts` / `validator-v2.ts` /
// `templates.ts` directly), but this package publishes `dist/`, so the
// re-exports are deliberately retained as an external entry point rather than
// deleted on a grep (FIX-PLAN B24 / B17: never remove a published export on
// grep evidence alone). Whether this barrel should stay a supported module
// entry is a maintainer decision; nothing in-repo depends on it either way.
export {
  parseGraph,
  type GraphDocument,
  type GraphParseResult,
} from "./parser-v2.ts";
export {
  validateGraphDeclaration,
  hasCycle as hasCycleV2,
  type GraphValidationResult,
} from "./validator-v2.ts";
export { expandTemplate } from "./templates.ts";
