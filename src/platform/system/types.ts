/**
 * OS-level system adapter — the declared facts of one operating system.
 *
 * A graph-worker command path cannot guess its host: where an installed browser
 * cache lives, which environment variables make a home/config/cache/temp set
 * disposable, and which shell interprets a command string all differ per OS.
 * Declaring those facts here, one {@link SystemDescriptor} per system, replaces
 * the hardcoded macOS/POSIX assumptions a consumer would otherwise carry, so a
 * caller asks the platform instead of assuming one.
 */

/**
 * The operating systems rolebox declares.
 *
 * `posix` is the fallback for every platform not listed here — it carries
 * POSIX-family facts under its own id, so diagnostics say which system answered.
 */
export type SystemId = "darwin" | "linux" | "win32" | "posix";

/**
 * The disposable directory set a command runs with, plus the host environment
 * the descriptor may read conditional facts from.
 */
export interface DisposablePaths {
  /** Disposable home: what `HOME` (and the OS-specific equivalent) points at. */
  home: string;
  /** Disposable config directory. */
  config: string;
  /** Disposable cache directory. */
  cache: string;
  /** Disposable temporary directory, removed with the command. */
  temp: string;
  /** The ambient environment, for facts a descriptor forwards rather than invents. */
  env: NodeJS.ProcessEnv;
}

/**
 * One operating system's facts. Every member is a method or a value derived from
 * this descriptor alone, so the same descriptor answers identically on any host
 * running the tests.
 */
export interface SystemDescriptor {
  readonly id: SystemId;
  /** Human-readable label for diagnostics (never used to branch on). */
  readonly label: string;
  /**
   * Whether this OS lets Node fsync a DIRECTORY handle — the POSIX idiom that
   * makes a newly written directory entry (the new file's name) durable.
   * Windows has no equivalent through Node, so a caller skips the sync there and
   * relies on the filesystem's metadata journaling instead; the POSIX family
   * keeps the sync, so a crash cannot lose the entry.
   */
  readonly canSyncDirectoryEntries: boolean;
  /** The installed Playwright/Puppeteer cache locations under a REAL home. */
  browserCaches(home: string): { playwright: string; puppeteer: string };
  /** The variables that point software at the disposable directories. */
  disposableEnvironment(paths: DisposablePaths): Record<string, string>;
  /** The spawn vector that runs `command` through this system's shell. */
  commandShell(command: string, env: NodeJS.ProcessEnv): string[];
  /** One sentence of shell guidance for model-facing text. */
  readonly shellHint: string;
  /**
   * How this OS takes a screenshot, injects input, which helpers those
   * commands call, and how it reports whether input is permitted. Declared
   * per system so no consumer guesses a platform's driver, and built purely
   * so every plan is exercisable on any host.
   */
  readonly computerUse: ComputerUseFacts;
}

// ── Computer use ─────────────────────────────────────────────────────────────
//
// The facts a screen-driving tool needs from the OS: how one capture is started,
// how one input gesture is started, which helper binaries those commands call,
// and how the OS reports whether the permission they need has been granted.
//
// Building a command is a pure function of (request, environment): no plan reads
// this host's state, so every per-OS plan is exercisable anywhere through
// `setPlatformForTest`. A system that declares no driver answers
// {@link UnsupportedComputerUse} instead of inventing one.

/** One screen rectangle, in the OS's own coordinate space. */
export interface ComputerRegion {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ComputerDisplay {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly primary: boolean;
  readonly name?: string;
}

export interface ComputerCaptureGeometry {
  readonly bounds: ComputerRegion;
  readonly displays: readonly ComputerDisplay[];
}

export interface ComputerCaptureGuard {
  readonly target: Omit<ComputerCaptureRequest, "path">;
  readonly geometry: ComputerCaptureGeometry;
}

/** Where one screenshot is written, and what it must cover. */
export interface ComputerCaptureRequest {
  /** Absolute path the capture helper writes the PNG to. */
  readonly path: string;
  /** One window, by the OS's own window id. Mutually exclusive with `region`. */
  readonly windowId?: number;
  /** One rectangle of the screen, in absolute screen coordinates. */
  readonly region?: ComputerRegion;
  /**
   * The identifier from computer_displays on the current desktop. Display
   * ordering may change after a topology change; refresh discovery then.
   */
  readonly display?: number;
}

/** Desktop discovery and input operations, as the tool face receives them. */
export type ComputerInputRequest =
  | { readonly action: "windows"; readonly app?: string }
  | { readonly action: "displays" }
  | { readonly action: "focus"; readonly windowId: number }
  | {
      readonly action: "scroll";
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount: number;
      readonly x?: number;
      readonly y?: number;
      readonly windowId?: number;
      readonly captureGuard?: ComputerCaptureGuard;
    }
  | {
      readonly action: "drag";
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly durationMs: number;
      readonly windowId?: number;
      readonly captureGuard?: ComputerCaptureGuard;
    }
  | {
      readonly action: "click";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "right" | "middle";
      readonly clicks: 1 | 2;
      readonly windowId?: number;
      readonly captureGuard?: ComputerCaptureGuard;
    }
  | { readonly action: "move"; readonly x: number; readonly y: number; readonly windowId?: number; readonly captureGuard?: ComputerCaptureGuard }
  | { readonly action: "type"; readonly text: string; readonly windowId?: number }
  | { readonly action: "key"; readonly keys: readonly string[]; readonly windowId?: number };

/**
 * One resolved OS command, plus what running it needs.
 *
 * This is what the dry-run seam serializes: the exact `argv` a real run hands to
 * the spawn, the verbatim-arguments flag, and — for an interpreter command —
 * the readable `script` the argv carries.
 */
export interface ComputerPlan {
  /** `[executable, ...args]`, exactly as the spawn receives it. */
  readonly argv: readonly string[];
  /** Node's `windowsVerbatimArguments`: true only when `argv` is a quoted command line. */
  readonly windowsVerbatimArguments: boolean;
  /**
   * The interpreter text (`osascript -e`, `sh -c`, PowerShell) this argv
   * carries, kept readable for the dry-run report and for diagnostics.
   */
  readonly script?: string;
  /** Helper executables (or absolute paths) this plan needs to exist. */
  readonly requires: readonly string[];
  /** The mechanism for diagnostics: `screencapture`, `osascript`, `xdotool`, `powershell`. */
  readonly driver: string;
  /**
   * Remediation appended when the helper explicitly reports an OS permission
   * denial. Other execution failures must not be presented as missing grants.
   */
  readonly permissionHint?: string;
  /** Best-effort release after an interrupted gesture; never repeats the gesture. */
  readonly cleanupPlan?: ComputerPlan;
  /** Emitted only when a guarded input plan refuses before sending any input. */
  readonly inputGuardFailureMarker?: string;
}

/**
 * A plan, or one sentence naming why this system cannot build one.
 *
 * A refusal is a plain string so a per-OS builder never throws: the caller
 * turns it into the `Error: ...` text a tool returns.
 */
export type ComputerPlanOrRefusal = ComputerPlan | string;

/** The computer-use facts of a system that can drive its own screen. */
export interface SupportedComputerUse {
  readonly supported: true;
  /** Every helper binary the plans below may call, for diagnostics. */
  readonly requiredBinaries: readonly string[];
  /** One sentence naming how to install a missing helper on this system. */
  readonly installHint: string;
  /** How one screenshot is taken. */
  capturePlan(request: ComputerCaptureRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal;
  /** How one window listing or input gesture is performed. */
  inputPlan(request: ComputerInputRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal;
  /**
   * How this system reports whether input is permitted right now.
   *
   * The plan's output is read only when {@link SupportedComputerUse.readsProbeOutput}
   * is true; otherwise a successful exit is itself the answer.
   */
  permissionProbe(): ComputerPlanOrRefusal;
  /** Optional independent screen-capture permission probe; prints granted or not granted. */
  capturePermissionProbe?(): ComputerPlanOrRefusal;
  /** Optional request for the independent screen-capture grant; never a substitute for a probe. */
  capturePermissionPrompt?(): ComputerPlanOrRefusal;
  /**
   * How this system asks its OS to show its own grant prompt, when the grant is
   * requestable.
   *
   * Absent on a system whose input permission is not a requestable
   * per-application grant (linux, win32), where {@link permissionProbe} is the
   * only permission plan.
   */
  permissionPrompt?(): ComputerPlanOrRefusal;
  /**
   * Whether this system's probe prints a machine token that must be validated.
   *
   * True on darwin, whose probe prints exactly `granted` or `not granted`, so an
   * empty or unrecognized answer is never read as a grant. Absent on linux and
   * win32, where a successful exit is itself the grant and the output is prose
   * for the caller.
   */
  readonly readsProbeOutput?: boolean;
}

/** The computer-use facts of a system rolebox declares no driver for. */
export interface UnsupportedComputerUse {
  readonly supported: false;
  /** One sentence naming the platform and what to run instead. */
  readonly refusal: string;
}

/** One system's computer-use facts, supported or explicitly unsupported. */
export type ComputerUseFacts = SupportedComputerUse | UnsupportedComputerUse;
