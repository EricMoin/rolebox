/**
 * Starting a resolved binary: the batch-script decision and the quoting that
 * makes the shell route safe.
 *
 * Nothing here runs a Windows command — it pins the PURE transformation the
 * spawn path applies, so the byte-identical POSIX vector and the win32 shell
 * vector are both checkable on any host through the platform seam. The runtime
 * end of it (a real `.cmd` stand-in really running) is
 * `tests/platform/pi-worker-sandbox.test.ts`, which executes on the platform
 * that has cmd.exe.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  escapeBatchArgument,
  escapeBatchCommand,
  needsCommandShell,
  resolveSpawnCommand,
} from "../../../src/platform/system/spawn-command.ts";
import { setPlatformForTest } from "../../../src/platform/system/index.ts";

afterEach(() => setPlatformForTest(undefined));

const COMSPEC = "C:\\Windows\\System32\\cmd.exe";
const PI_SHIM = "C:\\Users\\example\\AppData\\Roaming\\npm\\pi.cmd";

// ── Quoting one argument ────────────────────────────────────────────────────

describe("batch argument quoting", () => {
  it("keeps a space inside one argument", () => {
    expect(escapeBatchArgument("with space")).toBe('^"with^ space^"');
    expect(escapeBatchArgument("Task: fixture")).toBe('^"Task:^ fixture^"');
  });

  it("escapes the operators the command interpreter would otherwise act on", () => {
    // `&` would start a second command, `%NAME%` would be expanded, `|` would
    // pipe: each one carries a caret, and the argument's own quotes are caret
    // -escaped too, so the interpreter reads them as text.
    expect(escapeBatchArgument("a&b")).toBe('^"a^&b^"');
    expect(escapeBatchArgument("a|b")).toBe('^"a^|b^"');
    expect(escapeBatchArgument("a<b>c")).toBe('^"a^<b^>c^"');
    expect(escapeBatchArgument("pct%PATH%pct")).toBe('^"pct^%PATH^%pct^"');
  });

  it("escapes an embedded double quote with a backslash, for the callee's own parser", () => {
    expect(escapeBatchArgument('quote"inside')).toBe('^"quote\\^"inside^"');
    expect(escapeBatchArgument('trailing-quote"')).toBe('^"trailing-quote\\^"^"');
  });

  it("doubles a run of backslashes the way CreateProcess documents (2N)", () => {
    // "Backslashes are interpreted literally, unless they immediately precede a
    // double quote, in which case each pair of backslashes is interpreted as one
    // backslash" — so N trailing backslashes, which end up before the closing
    // quote, are written 2N, and N before an embedded quote become 2N plus the
    // backslash that escapes that quote.
    expect(escapeBatchArgument("trail\\")).toBe('^"trail\\\\^"');
    expect(escapeBatchArgument("trail\\\\")).toBe('^"trail\\\\\\\\^"');
    expect(escapeBatchArgument("a\\\\\"b")).toBe('^"a\\\\\\\\\\^"b^"');
    // Backslashes NOT next to a quote are literal and stay as they are.
    expect(escapeBatchArgument("back\\slash")).toBe('^"back\\slash^"');
    expect(escapeBatchArgument("C:\\Program Files\\pi.cmd")).toBe('^"C:\\Program^ Files\\pi.cmd^"');
  });

  it("quotes an empty argument instead of dropping it", () => {
    expect(escapeBatchArgument("")).toBe('^"^"');
  });
});

describe("batch command quoting", () => {
  it("caret-escapes the executable path, spaces included, without adding quotes", () => {
    expect(escapeBatchCommand("C:\\tools\\pi.cmd")).toBe("C:\\tools\\pi.cmd");
    expect(escapeBatchCommand("C:\\Program Files\\node_modules\\.bin\\pi.cmd"))
      .toBe("C:\\Program^ Files\\node_modules\\.bin\\pi.cmd");
  });
});

// ── The shell decision and the vectors it produces ──────────────────────────

describe("spawn vectors", () => {
  it("routes .cmd and .bat through the detected system's command shell on win32", () => {
    setPlatformForTest("win32");
    const vector = resolveSpawnCommand(PI_SHIM, ["--mode", "json"], { COMSPEC });
    expect(vector.windowsVerbatimArguments).toBe(true);
    expect(vector.argv[0]).toBe(COMSPEC);
    expect(vector.argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
    // One command string: the shim, then every argument quoted for cmd, all
    // wrapped in the outer pair `/s` strips.
    expect(vector.argv[4]).toBe(`"${PI_SHIM} ^"--mode^" ^"json^""`);
    expect(vector.argv).toHaveLength(5);
  });

  it("names the shell only for a batch extension, whatever the case", () => {
    setPlatformForTest("win32");
    expect(needsCommandShell(PI_SHIM)).toBe(true);
    expect(needsCommandShell("C:\\tools\\BUILD.BAT")).toBe(true);
    expect(needsCommandShell("C:\\tools\\pi.exe")).toBe(false);
    expect(needsCommandShell("C:\\tools\\pi")).toBe(false);
    setPlatformForTest("darwin");
    expect(needsCommandShell("/usr/local/bin/pi.cmd")).toBe(false);
  });

  it("starts an executable that is not a batch script directly", () => {
    setPlatformForTest("win32");
    expect(resolveSpawnCommand("C:\\tools\\pi.exe", ["-p", "Task: x"])).toEqual({
      argv: ["C:\\tools\\pi.exe", "-p", "Task: x"],
      windowsVerbatimArguments: false,
    });
  });

  it("keeps the POSIX vector exactly [executable, ...args]", () => {
    for (const id of ["darwin", "linux", "posix"] as const) {
      setPlatformForTest(id);
      const args = ["--mode", "json", "-p", "--no-session", "Task: a & b 100%"];
      expect(resolveSpawnCommand("/usr/local/bin/pi", args), id).toEqual({
        argv: ["/usr/local/bin/pi", ...args],
        windowsVerbatimArguments: false,
      });
      // A .cmd name is only a file name off Windows: it is never handed to a shell.
      expect(needsCommandShell("/usr/local/bin/pi.cmd"), id).toBe(false);
      expect(resolveSpawnCommand("/usr/local/bin/pi.cmd", ["-p"]), id).toEqual({
        argv: ["/usr/local/bin/pi.cmd", "-p"],
        windowsVerbatimArguments: false,
      });
    }
  });

  it("carries a prompt containing a space, a quote, % and & through the shell route", () => {
    setPlatformForTest("win32");
    const prompt = `Task: say "hi" & 100% done`;
    const vector = resolveSpawnCommand(PI_SHIM, ["-p", prompt], { COMSPEC });
    expect(vector.argv[4]).toBe(
      `"${PI_SHIM} ^"-p^" ^"Task:^ say^ \\^"hi\\^"^ ^&^ 100^%^ done^""`,
    );
  });
});
