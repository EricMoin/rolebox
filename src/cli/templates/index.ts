/**
 * Template data structures for the `rolebox init` command.
 *
 * Defines the 4 built-in scaffold templates (minimal, standard, subagents,
 * collaboration) and the types that describe them.
 *
 * Each template is defined in its own module; this file re-exports
 * the public API for backward compatibility.
 *
 * @module
 */

export type { TemplateType, TemplateFile, Template, InitConfig } from "./types.ts";
export { minimalTemplate } from "./minimal.ts";
export { standardTemplate } from "./standard.ts";
export { subagentsTemplate } from "./subagents.ts";
export { collaborationTemplate } from "./collaboration.ts";

import type { TemplateType, Template } from "./types.ts";
import { minimalTemplate } from "./minimal.ts";
import { standardTemplate } from "./standard.ts";
import { subagentsTemplate } from "./subagents.ts";
import { collaborationTemplate } from "./collaboration.ts";

/**
 * Built-in scaffold templates indexed by `TemplateType`.
 *
 * Each template defines the set of files that `rolebox init` will create
 * when the user picks that option.
 */
export const templates: Record<TemplateType, Template> = {
  minimal: minimalTemplate,
  standard: standardTemplate,
  subagents: subagentsTemplate,
  collaboration: collaborationTemplate,
};
