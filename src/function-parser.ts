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
  // Matches consecutive |fn| patterns at the start. Handles both:
  //   shared-pipe:  |plan|review|    — one | closes plan AND opens review
  //   double-pipe:  |plan||execute|  — separate | for closing and opening
  // After the first |name|, each additional name pattern can optionally
  // start with | (double-pipe) or not (shared-pipe), followed by name and |.
  const fullPattern =
    /^\|[a-z][a-z0-9-]*\|(?:\|?[a-z][a-z0-9-]*\|)*/;
  const match = text.match(fullPattern);

  if (!match) {
    return { functions: [], cleanedText: text };
  }

  const matched = match[0];
  const functions = matched.split("|").filter(Boolean);
  const cleanedText = text.slice(matched.length).trimStart();

  return { functions, cleanedText };
}
