// ── Graph Engine v2: parsing & structural validation ───────────────────
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
