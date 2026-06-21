/**
 * A parsed function activation entry — name plus optional arguments.
 */
export interface FunctionCall {
  name: string;
  args: Record<string, string>;
}

/**
 * Parse `|fn|` function activation syntax from user messages.
 *
 * Only matches `|fn|` patterns at the very start of the text.
 * Mid-sentence `|fn|` is NOT activation and is left untouched.
 *
 * Supports parameterized activation:
 *   - Positional: |review:security,strict|  → mapped to param order in frontmatter
 *   - Key-value:  |review focus=security severity=strict|
 *   - Mixed:      |plan| |review:security|  → plan has no args, review has one
 */
export function parseFunctionActivation(text: string): {
  functions: string[];
  calls: FunctionCall[];
  cleanedText: string;
} {
  // Matches consecutive |fn| or |fn:args| or |fn key=val| patterns at the start.
  // The inner content between pipes can contain: letters, digits, hyphens, colons,
  // equals, commas, spaces (for key=val pairs), underscores, dots, slashes.
  const fullPattern =
    /^\|[a-z][a-z0-9-]*(?:[: ][^|]*)?\|(?:\|?[a-z][a-z0-9-]*(?:[: ][^|]*)?\|)*/;
  const match = text.match(fullPattern);

  if (!match) {
    return { functions: [], calls: [], cleanedText: text };
  }

  const matched = match[0];
  const cleanedText = text.slice(matched.length).trimStart();

  // Split into individual function segments.
  // Each segment is between pipes: |segment1|segment2| or |segment1||segment2|
  const segments = matched.split("|").filter(Boolean);

  const functions: string[] = [];
  const calls: FunctionCall[] = [];

  for (const segment of segments) {
    const call = parseSingleCall(segment);
    if (call) {
      functions.push(call.name);
      calls.push(call);
    }
  }

  return { functions, calls, cleanedText };
}

/**
 * Parse a single function segment like "review:security,strict"
 * or "review focus=security severity=strict" into a FunctionCall.
 */
function parseSingleCall(segment: string): FunctionCall | null {
  // Try colon syntax first: "name:arg1,arg2"
  const colonIdx = segment.indexOf(":");
  const spaceIdx = segment.indexOf(" ");

  if (colonIdx > 0 && (spaceIdx < 0 || colonIdx < spaceIdx)) {
    const name = segment.slice(0, colonIdx);
    if (!isValidName(name)) return null;
    const argsStr = segment.slice(colonIdx + 1);
    const positional = argsStr.split(",").map((s) => s.trim()).filter(Boolean);
    const args: Record<string, string> = {};
    for (let i = 0; i < positional.length; i++) {
      args[`_${i}`] = positional[i];
    }
    return { name, args };
  }

  // Try key=value syntax: "name key1=val1 key2=val2"
  if (spaceIdx > 0) {
    const name = segment.slice(0, spaceIdx);
    if (!isValidName(name)) return null;
    const rest = segment.slice(spaceIdx + 1).trim();
    const args = parseKeyValueArgs(rest);
    return { name, args };
  }

  // Plain name, no args
  if (!isValidName(segment)) return null;
  return { name: segment, args: {} };
}

/**
 * Parse "key1=val1 key2=val2" into a Record.
 */
function parseKeyValueArgs(str: string): Record<string, string> {
  const args: Record<string, string> = {};
  // Match key=value pairs. Value can be quoted or unquoted.
  const pattern = /([a-z][a-z0-9_-]*)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(str)) !== null) {
    args[m[1]] = m[2] ?? m[3];
  }
  return args;
}

function isValidName(s: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(s);
}
