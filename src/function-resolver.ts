import type { FunctionMetadata, ResolvedFunction } from "./types";
import { parseFrontmatter } from "./skill-resolver";

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
    const candidates: { source: ResolvedFunction["source"]; path: string }[] = [
      { source: "role-local", path: `${roleDir}/functions/${name}.md` },
      { source: "global", path: `${globalFunctionsDir}/${name}.md` },
      { source: "built-in", path: `${builtinDir}/${name}.md` },
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
      });

      matched = true;
      break;
    }

    if (!matched) {
      console.warn(
        `Function "${name}" not found in any of the searched locations.`,
      );
    }
  }

  return resolved;
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
