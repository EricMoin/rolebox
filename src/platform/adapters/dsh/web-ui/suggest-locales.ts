/**
 * Locale dictionaries for the composer draft-suggestion control.
 *
 * The Web client's composer slot hands a registered entry the `t` seat of the
 * namespace it declares as its `locale`, so the pill's short label and its
 * tooltip follow the ACTIVE dsh UI locale with no per-component language
 * switch: register `en` (the registry fallback) and `zh`, and every other
 * installed language resolves through its fallback chain to English.
 *
 * The two dictionaries are DERIVED from one copy table rather than written out
 * twice, so a key can never exist in one language and be missing in the other
 * (the failure mode: a tooltip renders a raw `title.idle` key in one locale).
 *
 * @module
 */

/** Locale namespace the draft-suggestion entry declares and registers. */
export const SUGGEST_NS = "rolebox.suggest";

/** One key's copy in both shipped languages. */
export interface SuggestCopy {
  /** English copy (the registry fallback locale). */
  readonly en: string;
  /** Chinese copy. */
  readonly zh: string;
}

/**
 * The single copy table: short pill labels, tooltip titles and bodies, and one
 * body per disabled reason.
 */
export const SUGGEST_COPY = {
  "label.idle": { en: "Suggest", zh: "建议" },
  "label.loading": { en: "Suggesting", zh: "生成中" },
  "label.injected": { en: "Clear", zh: "清除" },
  "title.idle": { en: "Suggest the next message", zh: "建议下一条消息" },
  "body.idle": {
    en: "Fills the composer with a likely next message from this conversation - you decide whether to send it.",
    zh: "根据当前对话生成一条下一条消息并填入输入框，是否发送由你决定。",
  },
  "title.loading": { en: "Generating a suggestion", zh: "正在生成建议" },
  "body.loading": {
    en: "Reading the conversation tail with the configured fast model. Typing cancels it.",
    zh: "正在用配置的快模型读取对话尾部；开始输入会取消。",
  },
  "title.injected": { en: "Suggestion inserted", zh: "已填入建议" },
  "body.injected": {
    en: "This draft was filled automatically. Clearing it never sends it.",
    zh: "这条草稿是自动填入的；清除不会发送它。",
  },
  "title.disabled": { en: "Suggestion unavailable", zh: "建议不可用" },
  "body.disabled.blank": {
    en: "This session has no conversation yet.",
    zh: "当前会话还没有对话内容。",
  },
  "body.disabled.subagent": {
    en: "Subagent conversations do not offer suggestions.",
    zh: "子会话不提供建议。",
  },
  "body.disabled.config": {
    en: "Copilot draft suggestions are disabled for this role or host.",
    zh: "当前角色或宿主未启用 copilot 草稿建议。",
  },
  "body.disabled.draft": {
    en: "The composer already has your text - it is never overwritten.",
    zh: "输入框里已有你的内容，不会被覆盖。",
  },
} as const satisfies Record<string, SuggestCopy>;

/** Every copy key, derived from {@link SUGGEST_COPY}. */
export type SuggestKey = keyof typeof SUGGEST_COPY;

/** The registered key list, derived from the copy table. */
export const SUGGEST_KEYS = Object.keys(SUGGEST_COPY) as SuggestKey[];

/**
 * Derive one flat dictionary from the copy table.
 * @param locale - the language id to project.
 * @returns the flat `Record<string,string>` the locale service registers.
 */
function buildDictionary(locale: "en" | "zh"): Record<string, string> {
  const dictionary: Record<string, string> = {};
  for (const key of SUGGEST_KEYS) dictionary[key] = SUGGEST_COPY[key][locale];
  return dictionary;
}

/** English dictionary (the fallback locale for every other language). */
export const en: Record<string, string> = buildDictionary("en");

/** Chinese dictionary. */
export const zh: Record<string, string> = buildDictionary("zh");
