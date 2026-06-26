import { join } from "node:path";
import type { FunctionMetadata, ResolvedFunction } from "./types.ts";
import { FunctionSource } from "./constants.ts";
import { parseFrontmatter } from "./skill-resolver.ts";
import { functionPath } from "./paths.ts";
import type { FunctionCall } from "./function-parser.ts";
import { createSubLogger } from "./logger.ts";

const log = createSubLogger("function-resolver");

/**
 * Resolve function names to their file locations using Bun.file().exists().
 *
 * For each function name, three candidate locations are checked in priority
 * order.  The first existing file wins.  Functions whose body is empty after
 * frontmatter are skipped.  Functions that cannot be found in any location
 * are silently skipped (a warning is logged).
 *
 * Resolution priority:
 *  1. {roleDir}/functions/{name}.md  (role-local)
 *  2. {globalFunctionsDir}/{name}.md (global)
 *  3. {builtinDir}/{name}.md         (built-in)
 */
export async function resolveFunctions(
  names: string[],
  roleDir: string,
  globalFunctionsDir: string,
  builtinDir: string,
): Promise<ResolvedFunction[]> {
  const resolved: ResolvedFunction[] = [];

  for (const name of names) {
    const roleFunctionsDir = join(roleDir, "functions");
    const candidates: { source: ResolvedFunction["source"]; path: string }[] = [
      { source: FunctionSource.RoleLocal, path: functionPath(roleFunctionsDir, name) },
      { source: FunctionSource.Global, path: functionPath(globalFunctionsDir, name) },
      { source: FunctionSource.BuiltIn, path: functionPath(builtinDir, name) },
    ];

    let matched = false;

    for (const candidate of candidates) {
      if (!(await Bun.file(candidate.path).exists())) {
        continue;
      }

      let content: string;
      try {
        content = await Bun.file(candidate.path).text();
      } catch {
        continue;
      }

      const { metadata, body } = parseFrontmatter(content);

      if (body.trim() === "") {
        continue;
      }

      resolved.push({
        name: metadata.name ?? name,
        description: metadata.description ?? "",
        content: body,
        filePath: candidate.path,
        source: candidate.source,
        params: (metadata as FunctionMetadata).params,
      });

      matched = true;
      break;
    }

    if (!matched) {
      const roleFuncDir = join(roleDir, "functions");
      log.warn(
        `Function "${name}" not found. Searched:\n` +
          `  1. ${functionPath(roleFuncDir, name)}\n` +
          `  2. ${functionPath(globalFunctionsDir, name)}\n` +
          `  3. ${functionPath(builtinDir, name)}\n` +
          `Create the file at any of these locations to enable this function.`,
      );
    }
  }

  return resolved;
}

/**
 * Apply parameter substitution to a function's content.
 *
 * Replaces `{param_name}` placeholders with values from the activation call.
 * Positional args (from colon syntax) are mapped to param declaration order.
 * Missing params fall back to their declared default values.
 * Unresolved placeholders (no value, no default) are left as-is.
 */
export function applyParams(
  fn: ResolvedFunction,
  call: FunctionCall,
): string {
  if (!fn.params || Object.keys(fn.params).length === 0) {
    return fn.content;
  }

  const paramNames = Object.keys(fn.params);
  const resolved: Record<string, string> = {};

  // Map positional args (_0, _1, ...) to declared param order
  for (let i = 0; i < paramNames.length; i++) {
    const paramName = paramNames[i];
    if (call.args[paramName] !== undefined) {
      // Named arg takes priority
      resolved[paramName] = call.args[paramName];
    } else if (call.args[`_${i}`] !== undefined) {
      // Positional arg by index
      resolved[paramName] = call.args[`_${i}`];
    } else {
      // Fall back to default from frontmatter
      resolved[paramName] = fn.params[paramName];
    }
  }

  let content = fn.content;
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== undefined && value !== "") {
      content = content.replaceAll(`{${key}}`, value);
    }
  }

  return content;
}

/**
 * Read a function file and extract its frontmatter metadata and body content.
 *
 * @throws If the file cannot be read.
 */
export async function loadFunctionContent(
  filePath: string,
): Promise<{ metadata: FunctionMetadata; content: string }> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    throw new Error(
      `Function file not found at "${filePath}". ` +
        `The file may have been deleted.`,
    );
  }

  const content = await file.text();
  const { metadata, body } = parseFrontmatter(content);

  return {
    metadata: {
      name: metadata.name,
      description: metadata.description ?? "",
    },
    content: body,
  };
}
