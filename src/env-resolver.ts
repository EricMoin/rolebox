/**
 * Environment variable resolver for rolebox.
 *
 * Replaces `{env:VARIABLE_NAME}` patterns in strings with the corresponding
 * environment variable value. If the variable is not set, the original pattern
 * is preserved and a warning is logged.
 */

const ENV_VAR_PATTERN = /(?<!\{env:)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replace `{env:VARIABLE_NAME}` placeholders with actual environment values.
 *
 * @param value - The string potentially containing env var placeholders.
 * @returns The resolved string with environment variables substituted.
 *          Unresolvable placeholders are left as-is.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(`[env-resolver] Environment variable "${varName}" is not set; keeping placeholder "${match}"`);
      return match;
    }
    return envValue;
  });
}

/**
 * Deep-resolve all string values in an object/array tree.
 *
 * Recursively walks through nested objects and arrays, resolving any
 * `{env:VARIABLE_NAME}` patterns found in string values.
 *
 * @param obj - The value to resolve (string, object, array, or primitive).
 * @returns A deeply resolved copy of the input.
 */
export function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVarsDeep(item));
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }

  return obj;
}
