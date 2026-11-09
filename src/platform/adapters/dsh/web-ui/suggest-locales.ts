/**
 * Locale dictionaries for the composer draft-suggestion control.
 *
 * The Web client's composer slot hands a registered entry the `t` seat of the
 * namespace it declares as its `locale`, so the pill's short label, its tooltip
 * and the hint card's eyebrow/actions follow the ACTIVE dsh UI locale with no
 * per-component language switch: register `en` (the registry fallback) and
 * `zh`, and every other installed language resolves through its fallback chain
 * to English.
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
 * The single copy table: short pill labels, tooltip titles and bodies, the
 * hint-card eyebrow and its two action labels, one body per disabled reason,
 * the automatic-suggestions switch, and the transient notice a MANUAL request
 * raises when it yields no draft.
 */
export const SUGGEST_COPY = {
  "label.idle": { en: "Suggest", zh: "建议" },
  "label.loading": { en: "Suggesting", zh: "生成中" },
  "title.idle": { en: "Suggest the next message", zh: "建议下一条消息" },
  "body.idle": {
    en: "Asks the configured fast model for one likely next message and shows it in a card above - nothing is written into the composer until you choose Fill.",
    zh: "让配置的快模型生成一条可能的下一条消息并显示在上方卡片中；在你选择“填入”前不会写入输入框。",
  },
  "title.loading": { en: "Generating a suggestion", zh: "正在生成建议" },
  "body.loading": {
    en: "Reading the conversation tail with the configured fast model. Typing cancels it.",
    zh: "正在用配置的快模型读取对话尾部；开始输入会取消。",
  },
  "title.ready": { en: "Suggestion ready", zh: "建议已就绪" },
  "body.ready": {
    en: "Choose Fill in the card above to write it into the composer, or Dismiss to ignore it. Nothing is inserted until you choose.",
    zh: "在上方卡片中选择“填入”写入输入框，或选择“忽略”放弃这条建议；在你选择前不会写入任何内容。",
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
  "notice.none": { en: "No suggestion right now", zh: "暂时没有合适的建议" },
  "notice.none.body": {
    en: "Try again after the next turn, or type your own message.",
    zh: "可以等下一轮再试，或直接输入你的内容。",
  },
  "card.eyebrow": { en: "Suggestion", zh: "建议" },
  "card.fill": { en: "Fill", zh: "填入" },
  "card.dismiss": { en: "Dismiss", zh: "忽略" },
  "settings.title": { en: "Suggestion settings", zh: "建议设置" },
  "auto.label": { en: "Automatic suggestions", zh: "自动建议" },
  "auto.on": { en: "On", zh: "已开启" },
  "auto.off": { en: "Off", zh: "已关闭" },
  "auto.description": {
    en: "You can still click Suggest to request one manually.",
    zh: "关闭后仍可点击“建议”手动生成。",
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
