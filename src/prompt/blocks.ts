/**
 * Injected-block constructor — `src/prompt/blocks.ts`
 *
 * ONE producer for the markdown sections injected into a system prompt. A block
 * is declared as data ({@link InjectBlock}) and rendered by
 * {@link renderInjectBlock}; this module owns heading level, blank-line layout,
 * inline-code wrapping, table-cell escaping and body fencing, so no caller
 * assembles its own markdown and every block gets the same safety rules.
 * `src/prompt/builder.ts` maps domain objects to declarations and calls the
 * renderer.
 *
 * @module
 */

/** One bullet: ``- <label in code> — <value>``, plus an optional `sub` line. */
export interface InjectItem {
  /**
   * Rendered as an inline code span. Omitted → the bullet is `- <value>`
   * (no empty code span, no dangling separator).
   */
  label?: string;
  /** Bullet text (the whole bullet when `label` is absent). */
  value: string;
  /**
   * Indented continuation line under the bullet. Rendered as prose; a caller
   * that wants an inline code span inside it composes one with
   * {@link injectCode}, so the wrapping rule stays here.
   */
  sub?: string;
}

/** Table form: one header row, one divider row, then the data rows. */
export interface InjectTable {
  header: string[];
  rows: string[][];
}

/** A declarative prompt block. */
export interface InjectBlock {
  /** Rendered as `<level> <title>`, normalized to one line. */
  title: string;
  /** Heading level, default 2 (`##`). */
  level?: 2 | 3;
  /**
   * Prose under the title. A string is emitted verbatim (documented
   * instruction wording, hard line breaks included); an array emits one
   * paragraph per entry.
   */
  instruction?: string | string[];
  /**
   * Directory stated ONCE for every item, rendered as
   * ``Base directory: `<base>` `` between the instruction and the items. The
   * renderer carries no domain rule here: a caller sets it only when it is a
   * real directory its item values resolve against, and otherwise keeps the
   * location per item (`sub`). Omitted → no line and no extra blank line.
   */
  base?: string;
  /** Bullet form. An empty array renders the whole block as `""`. */
  items?: InjectItem[];
  /** Table form. An empty `rows` renders the whole block as `""`. */
  table?: InjectTable;
  /** Verbatim content (function/artifact body), inside a tilde fence. */
  body?: string;
  /** Nested blocks rendered after this block's own parts, blank-line separated. */
  sections?: InjectBlock[];
}

/**
 * Normalize one value for inline markdown injection.
 *
 * - Collapses whitespace, so a multi-line value cannot break a bullet, a
 *   table row or a heading.
 * - `table: true` escapes backslashes BEFORE pipes: `\|` alone leaves a
 *   preceding backslash unescaped, and GFM then reads `\\|` as an escaped
 *   backslash followed by a REAL cell delimiter, which splits the row.
 */
export function injectText(value: unknown, opts: { table?: boolean } = {}): string {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (opts.table) text = text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return text;
}

/**
 * Wrap a value in an inline code span, widening the backtick delimiter when
 * the value itself contains backticks (CommonMark's padded form), so a name,
 * id or path survives verbatim instead of being mangled.
 */
export function injectCode(value: unknown): string {
  const text = injectText(value);
  let ticks = "`";
  while (text.includes(ticks)) ticks += "`";
  return ticks === "`" ? `\`${text}\`` : `${ticks} ${text} ${ticks}`;
}

/**
 * Verbatim body inside a tilde fence. Bodies are markdown that already carries
 * its own ``` fences, and a heading inside a body would collide with the
 * section headings around it (bodies use `##`/`###`), so the fence is tildes.
 *
 * The delimiter is widened past the longest line-leading tilde run in the
 * content: a bare `~~~` line inside the body would otherwise close the fence
 * early and leak the remainder as top-level prompt markdown. `---` is not a
 * CommonMark code fence (it lexes as a thematic break), so tilde widening is
 * the only correct escape here.
 */
export function injectFence(content: string): string {
  const runs = content.match(/^ {0,3}(~{3,})/gm) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.trimStart().length), 0);
  const delimiter = "~".repeat(Math.max(3, longest + 1));
  return `${delimiter}\n${content}\n${delimiter}`;
}

/**
 * Render one block. A block declaring an empty `items` or an empty
 * `table.rows` renders `""`, so an empty injection list is omitted instead of
 * emitting a bare heading.
 */
export function renderInjectBlock(block: InjectBlock): string {
  if (block.items && block.items.length === 0) return "";
  if (block.table && block.table.rows.length === 0) return "";

  const level = block.level ?? 2;
  const parts: string[] = [`${"#".repeat(level)} ${injectText(block.title)}`];

  if (block.instruction !== undefined) {
    const paragraphs = Array.isArray(block.instruction) ? block.instruction : [block.instruction];
    parts.push(...paragraphs);
  }
  if (block.base !== undefined) {
    parts.push(`Base directory: ${injectCode(block.base)}`);
  }
  if (block.items && block.items.length > 0) {
    parts.push(renderItems(block.items));
  }
  if (block.table) {
    parts.push(renderTable(block.table));
  }
  if (block.body !== undefined) {
    parts.push(injectFence(block.body));
  }
  for (const section of block.sections ?? []) {
    const rendered = renderInjectBlock(section);
    if (rendered) parts.push(rendered);
  }

  return parts.join("\n\n");
}

/** One `- item` line per entry; `sub` is an indented continuation line. */
function renderItems(items: InjectItem[]): string {
  return items
    .map((item) => {
      const bullet = item.label !== undefined
        ? `- ${injectCode(item.label)} — ${injectText(item.value)}`
        : `- ${injectText(item.value)}`;
      return item.sub !== undefined ? `${bullet}\n  ${injectText(item.sub)}` : bullet;
    })
    .join("\n");
}

/** Header, divider and data rows, with every cell escaped through `injectText`. */
function renderTable(table: InjectTable): string {
  const cell = (value: unknown) => injectText(value, { table: true });
  const header = `| ${table.header.map((value) => cell(value)).join(" | ")} |`;
  const divider = `| ${table.header.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) => `| ${row.map((value) => cell(value)).join(" | ")} |`);
  return [header, divider, ...rows].join("\n");
}
