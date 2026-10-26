/**
 * CJK-aware memory search normalization.
 *
 * The memory index is an FTS5 table with the default `unicode61` tokenizer,
 * which treats a run of Han characters as ONE token: `记忆机制需要保存关键点`
 * indexes as the single token `记忆机制需要保存关键点`, so a search for
 * `记忆机制` or `压缩` finds nothing. The index therefore keeps the original
 * title/content/tags verbatim AND appends the deduped 2-character bigrams of
 * every Han run (`记忆机制` → `记忆 忆机 机制`). A Chinese query is rewritten
 * to the same bigrams joined as an FTS `OR` expression, so a short term
 * matches inside a longer phrase while Latin/number tokens keep their normal
 * tokenizer behavior. Bigrams (not trigrams) are the smallest window that
 * matches a 2-character term.
 *
 * Two query builders share that tokenization but answer different questions.
 * {@link memorySearchQuery} rewrites whatever text a caller hands to the
 * `memory_recall` tool and keeps non-Han FTS syntax untouched.
 * {@link memoryPromptQuery} is for turn recall: a long instruction preamble
 * would otherwise fill the fixed 24-term budget before the entities the
 * question asks about are ever searched, so it first extracts the prompt's
 * task/question part ({@link memoryPromptQueryText}) and then drops English
 * function words ({@link memoryPromptTerms}).
 *
 * @module
 */

/** A maximal run of code points in the Han script. */
const HAN_RUN = /\p{Script=Han}+/gu;

/** A single Han code point (used by the query tokenizer). */
const HAN_CHAR = /\p{Script=Han}/u;

/** Letters, numbers and combining marks — the token alphabet FTS indexes. */
const SEARCH_TOKEN = /[\p{L}\p{N}\p{M}]+/gu;

/** Upper bound on the terms one CJK query expands to. */
const MAX_QUERY_TERMS = 24;

/** A labelled task/question line: its whole line wins the extraction. */
const PROMPT_QUESTION_LINE = /^\s*(?:question|q|task|request|问题|任务|请求)\s*[:：]\s*(.+)$/gimu;

/** Prompt length above which a final question paragraph may be extracted. */
const LONG_PROMPT_CHARS = 400;

/** A question mark marking the prompt's final paragraph as the task. */
const QUESTION_MARK = /[?？]/;

/**
 * English function words that carry no retrieval signal in a prompt.
 *
 * Only the prompt path filters them: a tool query keeps every token it was
 * given, because its caller explicitly asked to search for those words.
 */
const PROMPT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "her", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "she", "so",
  "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "you", "your", "do", "does", "did", "can", "could",
  "should", "would", "about", "also", "just", "only", "over", "such", "use",
  "used", "using",
]);

/** True when the text contains at least one Han-script code point. */
export function hasCjk(text: string): boolean {
  return HAN_CHAR.test(text);
}

/** Fields indexed by {@link memorySearchText}. */
export interface MemorySearchTextInput {
  title: string;
  content: string;
  tags?: readonly string[];
}

/**
 * Build the text indexed for one memory entry.
 *
 * The original title, content and tags are kept byte-for-byte (joined by
 * newlines) so Latin, number and exact-token searches keep working; a newline
 * then separates the deduped CJK bigrams of all three parts. A Han run of one
 * character indexes as that character; a longer run indexes as every
 * 2-character window. Text with no Han characters is returned unchanged.
 */
export function memorySearchText(input: MemorySearchTextInput): string {
  const original = [input.title, input.content, ...(input.tags ?? [])].join("\n");
  const terms = cjkTerms(original);
  return terms.length === 0 ? original : `${original}\n${terms.join(" ")}`;
}

/**
 * Rewrite a caller's query for the memory index — the tool/store path.
 *
 * A query with no Han characters is returned unchanged, preserving explicit
 * FTS syntax and ordinary Latin tokenization. A query containing Han text is
 * tokenized: every Han run contributes its 2-character bigrams (a single
 * character contributes itself) FIRST, then non-Han tokens are lowercased, so
 * a mixed query cannot spend the 24-term budget on Latin words before the
 * Chinese entity is searched. Duplicates are dropped, the list is capped at
 * 24 terms and every term is quoted, joined with ` OR `. Returns `''` when no
 * term remains.
 *
 * @param query - The caller's search text.
 * @returns The FTS5 match expression.
 */
export function memorySearchQuery(query: string): string {
  if (!hasCjk(query)) return query;
  const { han, latin } = tokenTerms(query);
  const unique = dedupe([...han, ...latin]).slice(0, MAX_QUERY_TERMS);
  if (unique.length === 0) return "";
  return unique.map(quoteTerm).join(" OR ");
}

/**
 * Extract the part of a prompt that carries the actual task.
 *
 * A long instruction preamble can crowd an entity out of the fixed 24-term
 * budget, so retrieval searches the prompt's own question instead:
 *
 * 1. When a line is labelled `Question:` / `Q:` / `Task:` / `Request:` /
 *    `问题:` / `任务:` / `请求:` (case-insensitive), the text from the LAST
 *    such line through the end of the prompt wins.
 * 2. Otherwise, for a long prompt (more than 400 characters) whose last
 *    non-empty blank-line-separated paragraph contains `?` or `？`, that
 *    final paragraph wins.
 * 3. Otherwise the whole prompt is used.
 *
 * The result is trimmed, so a whitespace-only prompt yields `''`.
 *
 * @param text - The user-authored prompt.
 * @returns The task/question slice to tokenize.
 */
export function memoryPromptQueryText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  let start = -1;
  for (const match of trimmed.matchAll(PROMPT_QUESTION_LINE)) {
    start = match.index;
  }
  if (start >= 0) return trimmed.slice(start).trim();
  if (trimmed.length > LONG_PROMPT_CHARS) {
    const paragraphs = trimmed.split(/\n\s*\n/).filter(paragraph => paragraph.trim().length > 0);
    const last = paragraphs[paragraphs.length - 1];
    if (last !== undefined && QUESTION_MARK.test(last)) return last.trim();
  }
  return trimmed;
}

/**
 * The retrieval terms a prompt contributes, tuned for a human task statement.
 *
 * The prompt is narrowed by {@link memoryPromptQueryText} first, then
 * tokenized: every Han run contributes its 2-character bigrams (a single
 * character contributes itself) BEFORE any non-Han token, so neither a long
 * Latin preamble nor a Latin-heavy question can spend the budget before a
 * Chinese entity. Non-Han tokens are lowercased and dropped when shorter than
 * two characters or when they are English function words (`this`, `the`,
 * `what`, ...); domain words such as `cobalt`, `sentinel`, `memory` or `code`
 * stay. Duplicates are dropped and the list is capped at 24 terms.
 *
 * @param text - The user-authored prompt.
 * @returns The deduped terms, Han terms first.
 */
export function memoryPromptTerms(text: string): string[] {
  const { han, latin } = tokenTerms(memoryPromptQueryText(text));
  const terms = [...han];
  for (const token of latin) {
    if (token.length < 2) continue;
    if (PROMPT_STOPWORDS.has(token)) continue;
    terms.push(token);
  }
  return dedupe(terms).slice(0, MAX_QUERY_TERMS);
}

/**
 * The FTS query for one user-authored prompt.
 *
 * {@link memoryPromptTerms} quoted and joined with ` OR `, so any one of the
 * prompt's entities is enough to retrieve an entry; returns `''` when the
 * prompt yields no usable term.
 *
 * @param text - The user-authored prompt.
 * @returns The FTS5 match expression, or `''`.
 */
export function memoryPromptQuery(text: string): string {
  const terms = memoryPromptTerms(text);
  if (terms.length === 0) return "";
  return terms.map(quoteTerm).join(" OR ");
}

/**
 * Count the distinct raw search terms a text yields.
 *
 * One term per non-Han token (lowercased) and one per overlapping 2-character
 * Han window (a single-character run counts as itself). This is the unfiltered
 * token/bigram count, not the prompt-tuned term list: turn recall and its
 * query scout gate on {@link memoryPromptTerms}, which extracts the task
 * first and drops function words.
 *
 * @param text - The text to count.
 * @returns The number of distinct raw terms.
 */
export function countSearchTerms(text: string): number {
  const { han, latin } = tokenTerms(text);
  return new Set([...han, ...latin]).size;
}

/** Deduped bigrams of every Han run in a text, in order of appearance. */
function cjkTerms(text: string): string[] {
  const terms: string[] = [];
  for (const run of text.match(HAN_RUN) ?? []) {
    for (const term of bigramsOf(run)) terms.push(term);
  }
  return dedupe(terms);
}

/**
 * Split a text into its Han bigrams and its lowercased non-Han tokens.
 *
 * A token that contains Han text contributes only the bigrams of its Han runs
 * (matching FTS indexing of a script run); everything else is a Latin/number
 * token.
 */
function tokenTerms(text: string): { han: string[]; latin: string[] } {
  const han: string[] = [];
  const latin: string[] = [];
  for (const token of text.match(SEARCH_TOKEN) ?? []) {
    const runs = token.match(HAN_RUN);
    if (runs === null) {
      latin.push(token.toLowerCase());
      continue;
    }
    for (const run of runs) {
      for (const term of bigramsOf(run)) han.push(term);
    }
  }
  return { han, latin };
}

/** The 1-character form of a single-character run, else every 2-char window. */
function bigramsOf(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length === 1) return [chars[0]];
  const terms: string[] = [];
  for (let index = 0; index + 1 < chars.length; index += 1) {
    terms.push(`${chars[index]}${chars[index + 1]}`);
  }
  return terms;
}

/** Keep the first occurrence of each term, preserving order. */
function dedupe(terms: readonly string[]): string[] {
  return [...new Set(terms)];
}

/** Quote one FTS5 string literal. */
function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}
