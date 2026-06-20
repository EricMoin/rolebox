/**
 * Parse `|fn|` function activation syntax from user messages.
 *
 * Only matches `|fn|` patterns at the very start of the text.
 * Mid-sentence `|fn|` is NOT activation and is left untouched.
 */
export function parseFunctionActivation(text: string): {
  functions: string[];
  cleanedText: string;
} {
  const functions: string[] = [];
  let remaining = text;
  const pattern = /^\|([a-z][a-z0-9-]*)\|/;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(remaining)) !== null) {
    functions.push(match[1]);
    remaining = remaining.slice(match[0].length);
  }

  if (functions.length > 0) {
    remaining = remaining.trimStart();
  }

  return { functions, cleanedText: remaining };
}
