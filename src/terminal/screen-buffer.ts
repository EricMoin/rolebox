/**
 * screen-buffer.ts — a lightweight VT100/xterm screen emulator.
 *
 * Full-screen TUI programs (vim, htop, pi, …) repaint regions of the screen
 * in place with cursor-addressing escape sequences. An append-only stream
 * buffer is nearly useless for reading them: the interesting content is the
 * CURRENT SCREEN STATE, not the raw byte stream. This class maintains a
 * cols×rows character grid fed from the session's output stream so callers
 * can take a rendered snapshot at any time (think `tmux capture-pane`).
 *
 * Supported (enough for real TUIs): cursor movement (CUP/CUU/CUD/CUF/CUB/
 * CNL/CPL/CHA/VPA), erase (ED/EL/ECH), insert/delete (ICH/DCH/IL/DL),
 * scrolling (SU/SD, DECSTBM scroll region, IND/RI/NEL), alternate screen
 * (?1049/?47/?1047), save/restore cursor (DECSC/DECRC, CSI s/u), tabs,
 * wide (CJK) characters, and OSC/DCS/APC/PM/SOS string skipping.
 *
 * It also auto-answers the terminal queries TUIs commonly block on when no
 * real terminal is present: DSR 6 (cursor position), DA1/DA2, XTWINOPS
 * 14/16/18 (sizes), and OSC 10/11 color queries.
 *
 * SGR attributes (colors/bold) are intentionally discarded — snapshots are
 * plain text for LLM consumption.
 *
 * This module MUST NOT import any platform SDK.
 */

export interface ScreenOptions {
  cols: number;
  rows: number;
  /** Callback used to answer terminal queries (written back to the app's stdin). */
  respond?: (data: string) => void;
}

type ParserState = "ground" | "esc" | "csi" | "osc" | "str" | "charset";

/** Approximate wcwidth: 2 for common East-Asian wide ranges, 0 for combining. */
export function charWidth(cp: number): number {
  // Zero-width: combining marks, ZWSP/ZWNJ/ZWJ, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  ) {
    return 0;
  }
  // Wide: CJK & friends.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

interface SavedScreen {
  lines: string[][];
  curX: number;
  curY: number;
}

export class TerminalScreen {
  cols: number;
  rows: number;

  /**
   * Count of screen-painting control operations seen (cursor addressing,
   * erase, scroll-region…). Heuristic signal that the program is a
   * full-screen TUI rather than a line-oriented REPL.
   */
  paintOps = 0;

  private lines: string[][];
  private curX = 0;
  private curY = 0;
  private savedX = 0;
  private savedY = 0;
  private scrollTop = 0;
  private scrollBottom: number;
  private altSaved: SavedScreen | null = null;
  private respond: ((data: string) => void) | null;

  // Parser state (persisted across feed() calls so chunk-split sequences work).
  private state: ParserState = "ground";
  private csiParams = "";
  private csiIntermediates = "";
  private oscBuf = "";
  private strEsc = false; // saw ESC inside an OSC/DCS/… string (awaiting ST's `\`)

  constructor(opts: ScreenOptions) {
    this.cols = Math.max(2, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.scrollBottom = this.rows - 1;
    this.respond = opts.respond ?? null;
    this.lines = [];
    for (let i = 0; i < this.rows; i++) this.lines.push(this.blankLine());
  }

  get altActive(): boolean {
    return this.altSaved !== null;
  }

  cursor(): { x: number; y: number } {
    return { x: this.curX, y: this.curY };
  }

  private blankLine(): string[] {
    return new Array<string>(this.cols).fill(" ");
  }

  /** Rendered plain-text snapshot of the current screen. */
  snapshot(): string {
    const rendered = this.lines.map((cells) => cells.join("").replace(/\s+$/u, ""));
    // Drop trailing blank lines but keep interior layout.
    let end = rendered.length;
    while (end > 0 && rendered[end - 1] === "") end--;
    return rendered.slice(0, end).join("\n");
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, cols);
    rows = Math.max(1, rows);
    for (const target of [this.lines, this.altSaved?.lines]) {
      if (!target) continue;
      for (const line of target) {
        if (line.length > cols) line.length = cols;
        while (line.length < cols) line.push(" ");
      }
      while (target.length > rows) target.pop();
      while (target.length < rows) target.push(new Array<string>(cols).fill(" "));
    }
    this.cols = cols;
    this.rows = rows;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.curX = Math.min(this.curX, cols - 1);
    this.curY = Math.min(this.curY, rows - 1);
  }

  reset(): void {
    this.altSaved = null;
    this.lines = [];
    for (let i = 0; i < this.rows; i++) this.lines.push(this.blankLine());
    this.curX = 0;
    this.curY = 0;
    this.savedX = 0;
    this.savedY = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.state = "ground";
  }

  feed(data: string): void {
    for (const ch of data) {
      switch (this.state) {
        case "ground":
          this.feedGround(ch);
          break;
        case "esc":
          this.feedEsc(ch);
          break;
        case "csi":
          this.feedCsi(ch);
          break;
        case "osc":
          this.feedString(ch, /* dispatchOsc */ true);
          break;
        case "str":
          this.feedString(ch, false);
          break;
        case "charset":
          this.state = "ground"; // consume the designation character
          break;
      }
    }
  }

  // ── Ground / printing ──────────────────────────────────────────────────────

  private feedGround(ch: string): void {
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) {
      this.state = "esc";
      return;
    }
    if (code === 0x9b) {
      this.startCsi();
      return;
    }
    if (code === 0x0d) {
      this.curX = 0;
      return;
    }
    if (code === 0x0a || code === 0x0b || code === 0x0c) {
      this.lineFeed();
      return;
    }
    if (code === 0x08) {
      this.curX = Math.max(0, this.curX - 1);
      return;
    }
    if (code === 0x09) {
      this.curX = Math.min(this.cols - 1, (Math.floor(this.curX / 8) + 1) * 8);
      return;
    }
    if (code < 0x20 || code === 0x7f) return; // other C0 / DEL — ignore
    this.putChar(ch, code);
  }

  private putChar(ch: string, code: number): void {
    const w = charWidth(code);
    if (w === 0) return;
    if (this.curX + w > this.cols) {
      this.curX = 0;
      this.lineFeed();
    }
    const line = this.lines[this.curY];
    line[this.curX] = ch;
    if (w === 2 && this.curX + 1 < this.cols) line[this.curX + 1] = "";
    this.curX += w;
  }

  private lineFeed(): void {
    if (this.curY === this.scrollBottom) {
      this.scrollUp(1);
    } else {
      this.curY = Math.min(this.rows - 1, this.curY + 1);
    }
  }

  private reverseLineFeed(): void {
    if (this.curY === this.scrollTop) {
      this.scrollDown(1);
    } else {
      this.curY = Math.max(0, this.curY - 1);
    }
  }

  private scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.scrollTop, 1);
      this.lines.splice(this.scrollBottom, 0, this.blankLine());
    }
  }

  private scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.scrollBottom, 1);
      this.lines.splice(this.scrollTop, 0, this.blankLine());
    }
  }

  // ── ESC dispatch ───────────────────────────────────────────────────────────

  private feedEsc(ch: string): void {
    switch (ch) {
      case "[":
        this.startCsi();
        return;
      case "]":
        this.state = "osc";
        this.oscBuf = "";
        this.strEsc = false;
        return;
      case "P":
      case "X":
      case "^":
      case "_":
        this.state = "str";
        this.strEsc = false;
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.state = "charset";
        return;
      case "7":
        this.savedX = this.curX;
        this.savedY = this.curY;
        break;
      case "8":
        this.curX = Math.min(this.savedX, this.cols - 1);
        this.curY = Math.min(this.savedY, this.rows - 1);
        break;
      case "D":
        this.lineFeed();
        break;
      case "M":
        this.reverseLineFeed();
        break;
      case "E":
        this.curX = 0;
        this.lineFeed();
        break;
      case "c":
        this.reset();
        return;
      default:
        break; // '=', '>', '\\' (ST) and anything else — ignore
    }
    this.state = "ground";
  }

  // ── CSI ────────────────────────────────────────────────────────────────────

  private startCsi(): void {
    this.state = "csi";
    this.csiParams = "";
    this.csiIntermediates = "";
  }

  private feedCsi(ch: string): void {
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) {
      // Broken sequence — restart escape parsing.
      this.state = "esc";
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.csiParams += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.csiIntermediates += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.dispatchCsi(ch);
      this.state = "ground";
      return;
    }
    // Anything else (C0 inside CSI etc.) — abort the sequence.
    this.state = "ground";
  }

  private dispatchCsi(final: string): void {
    let raw = this.csiParams;
    let prefix = "";
    if (raw.length > 0 && "<=>?".includes(raw[0])) {
      prefix = raw[0];
      raw = raw.slice(1);
    }
    const params = raw.split(";").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    const p = (i: number, def: number): number => (params[i] > 0 ? params[i] : def);

    if ("HfJKLM@PXSTrd".includes(final)) this.paintOps++;

    if (prefix === "?" && (final === "h" || final === "l")) {
      this.handleDecMode(params, final === "h");
      return;
    }
    if (prefix !== "" && final !== "c" && final !== "n") {
      // Private-prefixed sequences we don't model (kitty keyboard protocol
      // `CSI > … u` / `CSI < u`, DECRQM, …) — ignore safely.
      return;
    }

    switch (final) {
      case "A":
        this.curY = Math.max(0, this.curY - p(0, 1));
        break;
      case "B":
      case "e":
        this.curY = Math.min(this.rows - 1, this.curY + p(0, 1));
        break;
      case "C":
      case "a":
        this.curX = Math.min(this.cols - 1, this.curX + p(0, 1));
        break;
      case "D":
        this.curX = Math.max(0, this.curX - p(0, 1));
        break;
      case "E":
        this.curX = 0;
        this.curY = Math.min(this.rows - 1, this.curY + p(0, 1));
        break;
      case "F":
        this.curX = 0;
        this.curY = Math.max(0, this.curY - p(0, 1));
        break;
      case "G":
      case "`":
        this.curX = Math.min(this.cols - 1, Math.max(0, p(0, 1) - 1));
        break;
      case "H":
      case "f":
        this.curY = Math.min(this.rows - 1, Math.max(0, p(0, 1) - 1));
        this.curX = Math.min(this.cols - 1, Math.max(0, p(1, 1) - 1));
        break;
      case "d":
        this.curY = Math.min(this.rows - 1, Math.max(0, p(0, 1) - 1));
        break;
      case "J":
        this.eraseDisplay(params[0] ?? 0);
        break;
      case "K":
        this.eraseLine(params[0] ?? 0);
        break;
      case "L":
        this.insertLines(p(0, 1));
        break;
      case "M":
        this.deleteLines(p(0, 1));
        break;
      case "@":
        this.insertChars(p(0, 1));
        break;
      case "P":
        this.deleteChars(p(0, 1));
        break;
      case "X":
        this.eraseChars(p(0, 1));
        break;
      case "S":
        this.scrollUp(p(0, 1));
        break;
      case "T":
        this.scrollDown(p(0, 1));
        break;
      case "r": {
        const top = Math.max(0, p(0, 1) - 1);
        const bottom = Math.min(this.rows - 1, p(1, this.rows) - 1);
        if (top < bottom) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
        } else {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.curX = 0;
        this.curY = 0;
        break;
      }
      case "s":
        if (prefix === "" && raw === "") {
          this.savedX = this.curX;
          this.savedY = this.curY;
        }
        break;
      case "u":
        if (prefix === "" && raw === "") {
          this.curX = Math.min(this.savedX, this.cols - 1);
          this.curY = Math.min(this.savedY, this.rows - 1);
        }
        // `CSI ? u` / `CSI > … u` / `CSI < u` (kitty keyboard) — ignored above.
        break;
      case "n":
        // DSR — device status report. TUIs block on the cursor-position reply.
        if (prefix === "" && params[0] === 6) {
          this.respond?.(`\u001b[${this.curY + 1};${this.curX + 1}R`);
        } else if (prefix === "" && params[0] === 5) {
          this.respond?.(`\u001b[0n`);
        }
        break;
      case "c":
        // DA — device attributes.
        if (prefix === ">") {
          this.respond?.(`\u001b[>0;276;0c`); // xterm-like DA2
        } else if (prefix === "" && (params[0] ?? 0) === 0) {
          this.respond?.(`\u001b[?62;22c`); // VT220 with ANSI color
        }
        break;
      case "t":
        // XTWINOPS size reports.
        if (params[0] === 18) this.respond?.(`\u001b[8;${this.rows};${this.cols}t`);
        else if (params[0] === 14) this.respond?.(`\u001b[4;${this.rows * 16};${this.cols * 8}t`);
        else if (params[0] === 16) this.respond?.(`\u001b[6;16;8t`);
        break;
      default:
        break; // SGR (m), mode sets we don't model, etc. — ignore
    }
  }

  private handleDecMode(params: number[], set: boolean): void {
    for (const mode of params) {
      if (mode === 1049 || mode === 47 || mode === 1047) {
        if (set && !this.altSaved) {
          this.altSaved = { lines: this.lines, curX: this.curX, curY: this.curY };
          this.lines = [];
          for (let i = 0; i < this.rows; i++) this.lines.push(this.blankLine());
          this.curX = 0;
          this.curY = 0;
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        } else if (!set && this.altSaved) {
          this.lines = this.altSaved.lines;
          this.curX = Math.min(this.altSaved.curX, this.cols - 1);
          this.curY = Math.min(this.altSaved.curY, this.rows - 1);
          this.altSaved = null;
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
      }
      // ?25 (cursor visibility), ?2004 (bracketed paste), ?1000-1006 (mouse),
      // ?7 (wraparound) … — ignored.
    }
  }

  // ── Erase / insert / delete ────────────────────────────────────────────────

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.curY + 1; y < this.rows; y++) this.lines[y] = this.blankLine();
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.curY; y++) this.lines[y] = this.blankLine();
    } else {
      for (let y = 0; y < this.rows; y++) this.lines[y] = this.blankLine();
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.curY];
    if (mode === 0) {
      for (let x = this.curX; x < this.cols; x++) line[x] = " ";
    } else if (mode === 1) {
      for (let x = 0; x <= Math.min(this.curX, this.cols - 1); x++) line[x] = " ";
    } else {
      this.lines[this.curY] = this.blankLine();
    }
  }

  private insertLines(n: number): void {
    if (this.curY < this.scrollTop || this.curY > this.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.scrollBottom, 1);
      this.lines.splice(this.curY, 0, this.blankLine());
    }
  }

  private deleteLines(n: number): void {
    if (this.curY < this.scrollTop || this.curY > this.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.curY, 1);
      this.lines.splice(this.scrollBottom, 0, this.blankLine());
    }
  }

  private insertChars(n: number): void {
    const line = this.lines[this.curY];
    for (let i = 0; i < n; i++) {
      line.splice(this.curX, 0, " ");
      line.pop();
    }
  }

  private deleteChars(n: number): void {
    const line = this.lines[this.curY];
    for (let i = 0; i < n; i++) {
      line.splice(this.curX, 1);
      line.push(" ");
    }
  }

  private eraseChars(n: number): void {
    const line = this.lines[this.curY];
    for (let x = this.curX; x < Math.min(this.cols, this.curX + n); x++) line[x] = " ";
  }

  // ── OSC / DCS / APC / PM / SOS strings ─────────────────────────────────────

  private feedString(ch: string, dispatchOsc: boolean): void {
    if (this.strEsc) {
      this.strEsc = false;
      if (ch === "\\") {
        if (dispatchOsc) this.dispatchOsc();
        this.state = "ground";
        return;
      }
      // Lone ESC inside the string — treat as a fresh escape.
      this.state = "esc";
      this.feedEsc(ch);
      return;
    }
    if (ch === "\u001b") {
      this.strEsc = true;
      return;
    }
    if (ch === "\u0007") {
      if (dispatchOsc) this.dispatchOsc();
      this.state = "ground";
      return;
    }
    if (dispatchOsc && this.oscBuf.length < 4096) this.oscBuf += ch;
  }

  private dispatchOsc(): void {
    // Answer OSC 10/11 (fg/bg color) queries — some TUIs block on them.
    const m = /^(1[01]);\?$/.exec(this.oscBuf);
    if (m) {
      const color = m[1] === "10" ? "rgb:d4d4/d4d4/d4d4" : "rgb:1e1e/1e1e/1e1e";
      this.respond?.(`\u001b]${m[1]};${color}\u001b\\`);
    }
    this.oscBuf = "";
  }
}
