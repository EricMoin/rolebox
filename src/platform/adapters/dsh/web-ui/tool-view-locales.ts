/**
 * Locale dictionaries for the rolebox Tool-call rows.
 *
 * The Web client's keyed `tool.call.toolview` slot hands a registered entry the
 * `t` seat of the namespace it declared, so every row title follows the ACTIVE
 * dsh UI locale with no per-component language switch: register `en` (the
 * fallback locale) and `zh`, and every other installed language resolves
 * through its fallback chain to English.
 *
 * The two dictionaries are DERIVED from one copy table rather than written out
 * twice, so a key can never exist in one language and be missing in the other
 * (the failure mode: a row renders a raw `verb.declare.run` key in one locale).
 *
 * Vocabulary shape, not per-tool sentences:
 *   - `VERB_COPY` carries the running form, the completed form and the Chinese
 *     stem for each action ("Declaring/Declared/声明");
 *   - `NOUN_COPY` names the object ("graph", "图结构");
 *   - the templates glue them: English needs a space, Chinese prefixes the
 *     tense (`正在…`, `已…`) and concatenates.
 *
 * A tool whose tense or object has no natural fit gets its own verb/noun entry
 * here instead of a special case in the component.
 *
 * @module
 */

/** Locale namespace the tool rows register their `t` seat under. */
export const TOOL_VIEW_NS = "rolebox.tools";

/** One action's forms: English running/completed, Chinese stem. */
export interface VerbCopy {
  /** English present participle ("Declaring"). */
  readonly run: string;
  /** English completed form ("Declared"). */
  readonly done: string;
  /** Chinese stem; the templates add 正在 / 已. */
  readonly zh: string;
}

/** English running form, completed form and Chinese stem per verb. */
export const VERB_COPY = {
  read: { run: "Reading", done: "Read", zh: "读取" },
  write: { run: "Writing", done: "Wrote", zh: "写入" },
  edit: { run: "Editing", done: "Edited", zh: "编辑" },
  list: { run: "Listing", done: "Listed", zh: "列出" },
  recall: { run: "Recalling", done: "Recalled", zh: "检索" },
  search: { run: "Searching", done: "Searched", zh: "搜索" },
  update: { run: "Updating", done: "Updated", zh: "更新" },
  inspect: { run: "Inspecting", done: "Inspected", zh: "查看" },
  validate: { run: "Validating", done: "Validated", zh: "校验" },
  send: { run: "Sending", done: "Sent", zh: "发送" },
  control: { run: "Controlling", done: "Controlled", zh: "控制" },
  load: { run: "Loading", done: "Loaded", zh: "加载" },
  declare: { run: "Declaring", done: "Declared", zh: "声明" },
  submit: { run: "Submitting", done: "Submitted", zh: "提交" },
  audit: { run: "Auditing", done: "Audited", zh: "审计" },
  create: { run: "Creating", done: "Created", zh: "创建" },
  add: { run: "Adding", done: "Added", zh: "添加" },
  remove: { run: "Removing", done: "Removed", zh: "移除" },
  delete: { run: "Deleting", done: "Deleted", zh: "删除" },
  resume: { run: "Resuming", done: "Resumed", zh: "恢复" },
  start: { run: "Starting", done: "Started", zh: "启动" },
  stop: { run: "Stopping", done: "Stopped", zh: "停止" },
  fork: { run: "Forking", done: "Forked", zh: "派生" },
  open: { run: "Opening", done: "Opened", zh: "打开" },
  close: { run: "Closing", done: "Closed", zh: "关闭" },
  capture: { run: "Capturing", done: "Captured", zh: "截取" },
  click: { run: "Clicking", done: "Clicked", zh: "点击" },
  type: { run: "Typing", done: "Typed", zh: "输入" },
  press: { run: "Pressing", done: "Pressed", zh: "按键" },
  hover: { run: "Hovering", done: "Hovered", zh: "悬停" },
  select: { run: "Selecting", done: "Selected", zh: "选择" },
  upload: { run: "Uploading", done: "Uploaded", zh: "上传" },
  scroll: { run: "Scrolling", done: "Scrolled", zh: "滚动" },
  wait: { run: "Waiting", done: "Waited", zh: "等待" },
  evaluate: { run: "Evaluating", done: "Evaluated", zh: "执行" },
  handle: { run: "Handling", done: "Handled", zh: "处理" },
  manage: { run: "Managing", done: "Managed", zh: "管理" },
  focus: { run: "Focusing", done: "Focused", zh: "聚焦" },
  move: { run: "Moving", done: "Moved", zh: "移动" },
  drag: { run: "Dragging", done: "Dragged", zh: "拖拽" },
  check: { run: "Checking", done: "Checked", zh: "检查" },
  navigate: { run: "Navigating", done: "Navigated", zh: "导航" },
  run: { run: "Running", done: "Ran", zh: "执行" },
} as const satisfies Record<string, VerbCopy>;

/** {@link VERB_COPY} key — the action half of a row title. */
export type ToolViewVerb = keyof typeof VERB_COPY;

/** One object's English name and Chinese name. */
export interface NounCopy {
  /** English noun phrase, singular. */
  readonly en: string;
  /** Chinese noun phrase. */
  readonly zh: string;
}

/** English and Chinese name per object. */
export const NOUN_COPY = {
  graph: { en: "graph", zh: "图结构" },
  "graph status": { en: "graph status", zh: "图状态" },
  "graph run": { en: "graph run", zh: "图运行" },
  "graph store": { en: "graph store", zh: "图存储" },
  "node outcome": { en: "node outcome", zh: "节点结果" },
  memory: { en: "memory", zh: "记忆" },
  "memory entries": { en: "memory entries", zh: "记忆条目" },
  session: { en: "session", zh: "会话" },
  sessions: { en: "sessions", zh: "会话" },
  "session diff": { en: "session diff", zh: "会话差异" },
  team: { en: "team", zh: "团队" },
  roles: { en: "team roles", zh: "团队角色" },
  "team event": { en: "team event", zh: "团队事件" },
  member: { en: "member", zh: "成员" },
  role: { en: "role", zh: "角色" },
  loop: { en: "loop", zh: "循环" },
  loops: { en: "loops", zh: "循环" },
  "loop status": { en: "loop status", zh: "循环状态" },
  "loop output": { en: "loop output", zh: "循环输出" },
  "loop history": { en: "loop history", zh: "循环历史" },
  skill: { en: "skill", zh: "技能" },
  file: { en: "file", zh: "文件" },
  page: { en: "page", zh: "页面" },
  script: { en: "script", zh: "脚本" },
  "page snapshot": { en: "page snapshot", zh: "页面快照" },
  screen: { en: "screen", zh: "屏幕" },
  terminal: { en: "terminal", zh: "终端" },
  command: { en: "command", zh: "命令" },
  asset: { en: "asset", zh: "资产" },
  assets: { en: "assets", zh: "资产" },
  reference: { en: "reference", zh: "参考" },
  references: { en: "references", zh: "参考" },
  signal: { en: "signal", zh: "信号" },
  text: { en: "text", zh: "文本" },
  key: { en: "key", zh: "按键" },
  option: { en: "option", zh: "选项" },
  console: { en: "console", zh: "控制台" },
  network: { en: "network", zh: "网络" },
  cookies: { en: "cookies", zh: "Cookie" },
  dialog: { en: "dialog", zh: "对话框" },
  downloads: { en: "downloads", zh: "下载" },
  history: { en: "history", zh: "历史" },
  window: { en: "window", zh: "窗口" },
  pointer: { en: "pointer", zh: "指针" },
  tabs: { en: "tabs", zh: "标签页" },
  browser: { en: "browser", zh: "浏览器" },
  permissions: { en: "permissions", zh: "权限" },
  displays: { en: "displays", zh: "显示器" },
  windows: { en: "windows", zh: "窗口" },
  "computer status": { en: "computer status", zh: "电脑状态" },
} as const satisfies Record<string, NounCopy>;

/** {@link NOUN_COPY} key — the object half of a row title. */
export type ToolViewNoun = keyof typeof NOUN_COPY;

/** Plain string dictionary registered for one locale id. */
export type ToolViewDictionary = Record<string, string>;

/** Title templates and chrome shared by the derived dictionaries. */
const CHROME_EN: ToolViewDictionary = {
  "title.run": "{verb} {noun}",
  "title.done": "{verb} {noun}",
  "count.nodes": "{n} nodes",
  "count.edges": "{n} edges",
  "count.loopGroups": "{n} loop groups",
  "count.files": "{n} files",
  "details.show": "Show call details",
  "details.hide": "Hide call details",
  "details.args": "Arguments",
  "details.result": "Result",
  "details.error": "Error",
  "details.empty": "No details recorded for this call.",
};

const CHROME_ZH: ToolViewDictionary = {
  "title.run": "正在{verb}{noun}",
  "title.done": "已{verb}{noun}",
  "count.nodes": "{n} 个节点",
  "count.edges": "{n} 条边",
  "count.loopGroups": "{n} 个循环组",
  "count.files": "{n} 个文件",
  "details.show": "展开调用详情",
  "details.hide": "收起调用详情",
  "details.args": "参数",
  "details.result": "结果",
  "details.error": "错误",
  "details.empty": "这次调用没有记录详情。",
};

/**
 * Derive one flat dictionary from the copy tables.
 * @param chrome - the language's template/chrome strings.
 * @param verbOf - projects one verb entry into the language's two forms.
 * @param nounOf - projects one noun entry into the language's name.
 * @returns the flat `Record<string,string>` the locale service registers.
 */
function buildDictionary(
  chrome: ToolViewDictionary,
  verbOf: (copy: VerbCopy) => { run: string; done: string },
  nounOf: (copy: NounCopy) => string,
): ToolViewDictionary {
  const dictionary: ToolViewDictionary = { ...chrome };
  for (const [verb, copy] of Object.entries(VERB_COPY)) {
    const forms = verbOf(copy as VerbCopy);
    dictionary[`verb.${verb}.run`] = forms.run;
    dictionary[`verb.${verb}.done`] = forms.done;
  }
  for (const [noun, copy] of Object.entries(NOUN_COPY)) {
    dictionary[`noun.${noun}`] = nounOf(copy as NounCopy);
  }
  return dictionary;
}

/** English dictionary (the fallback locale for every other language). */
export const en: ToolViewDictionary = buildDictionary(
  CHROME_EN,
  copy => ({ run: copy.run, done: copy.done }),
  copy => copy.en,
);

/** Chinese dictionary; the templates carry the 正在 / 已 tense prefixes. */
export const zh: ToolViewDictionary = buildDictionary(
  CHROME_ZH,
  copy => ({ run: copy.zh, done: copy.zh }),
  copy => copy.zh,
);
