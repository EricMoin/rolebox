/**
 * Locale dictionaries for the composer draft-suggestion control.
 *
 * The Web client's composer slot hands a registered entry the `t` seat of the
 * namespace it declares as its `locale`, so the pill's short label, its settings
 * and the hint card's eyebrow/actions follow the ACTIVE dsh UI locale with no
 * per-component language switch: register `en` (the registry fallback) and
 * `zh`, and every other installed language resolves through its fallback chain
 * to English.
 *
 * The two dictionaries are DERIVED from one copy table rather than written out
 * twice, so a key can never exist in one language and be missing in the other
 * (the failure mode: a control renders a raw `title.idle` key in one locale).
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
 * The single copy table: short pill labels, accessible state descriptions, the
 * hint-card eyebrow and its two action labels, one body per disabled reason,
 * the mode selector, and the transient notice a MANUAL request
 * raises when it yields no draft.
 */
export const SUGGEST_COPY = {
  "label.idle": { en: "Suggest", zh: "建议" },
  "label.loading": { en: "Suggesting", zh: "生成中" },
  "label.automated": { en: "Auto continue", zh: "自动接续" },
  "title.idle": { en: "Suggest the next message", zh: "建议下一条消息" },
  "title.automated": { en: "Automatic continuation is on", zh: "已开启全自动接续" },
  "title.loading": { en: "Generating a suggestion", zh: "正在生成建议" },
  "title.ready": { en: "Suggestion ready", zh: "建议已就绪" },
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
  "body.disabled.attachments": {
    en: "The composer has your attachments. Remove or send them before requesting a suggestion.",
    zh: "输入框里已有附件，请先移除或发送附件，再生成建议。",
  },
  "body.disabled.mode": {
    en: "Copilot is off. Choose a mode below to enable it.",
    zh: "Copilot 已关闭，可在下方选择模式重新开启。",
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
  "mode.label": { en: "Copilot mode", zh: "Copilot 模式" },
  "mode.none": { en: "Off", zh: "关闭" },
  "mode.manual": { en: "Manual suggestions", zh: "仅手动建议" },
  "mode.auto-advise": { en: "Automatic suggestions", zh: "自动建议" },
  "mode.auto-mated": { en: "Automatic continuation", zh: "全自动接续" },
  "mode.none.description": {
    en: "No suggestions or messages are generated.",
    zh: "不生成建议，也不自动发送消息。",
  },
  "mode.manual.description": {
    en: "Click Suggest to generate a draft.",
    zh: "点击“建议”生成草稿。",
  },
  "mode.auto-advise.description": {
    en: "Shows suggestions after each turn; you send them.",
    zh: "每轮结束后弹出建议，由你发送。",
  },
  "mode.auto-mated.description": {
    en: "Generates and sends messages after each turn.",
    zh: "每轮结束后自动生成并发送消息。",
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
