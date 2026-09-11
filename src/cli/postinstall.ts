import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 24-bit ANSI helpers (self-contained, no imports from format.ts) ──

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const reset = () => `\x1b[0m`;

const sky400 = (s: string) => `\x1b[38;2;56;189;248m${s}\x1b[39m`;
const sky500 = (s: string) => `\x1b[38;2;14;165;233m${s}\x1b[39m`;
const sky600 = (s: string) => `\x1b[38;2;2;132;199m${s}\x1b[39m`;

// ── ASCII ROLEBOX wordmark (block letters with gradient) ──

const WORDMARK_LINES = [
  `  ██████╗  ██████╗ ██╗     ███████╗██████╗  ██████╗ ██╗  ██╗`,
  `  ██╔══██╗██╔═══██╗██║     ██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝`,
  `  ██████╔╝██║   ██║██║     █████╗  ██████╔╝██║   ██║ ╚███╔╝ `,
  `  ██╔══██╗██║   ██║██║     ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ `,
  `  ██║  ██║╚██████╔╝███████╗███████╗██████╔╝╚██████╔╝██╔╝ ██╗`,
  `  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝`,
];

const WORDMARK_COLORS = [sky600, sky600, sky500, sky500, sky400, sky400];

// ── Main ──

export function showWelcome(): void {
  // ── Guard: not a TTY ──────────────────────────────────────────
  if (!process.stdout.isTTY) return;
  // ── Guard: CI (core-js style) ─────────────────────────────────
  if (process.env["CI"]) return;
  // ── Guard: opt-out env var ────────────────────────────────────
  if (process.env["ROLEBOX_NO_WELCOME"]) return;

  try {
    // ── Read version from shipped package.json ──────────────────
    // Compiled file lives at dist/cli/postinstall.js, so package.json
    // is two directories up.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version: string;
      repository?: { url?: string };
    };
    const version = pkg.version ?? "unknown";
    const repoUrl =
      pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ??
      "https://github.com/EricMoin/rolebox";

    const cliName = "rolebox";

    // ── Build output lines ──────────────────────────────────────
    const lines: string[] = [];

    // ASCII wordmark with gradient
    for (let i = 0; i < WORDMARK_LINES.length; i++) {
      lines.push(WORDMARK_COLORS[i](WORDMARK_LINES[i]));
    }

    // Version line
    lines.push("");
    lines.push(`  ${bold(sky500(`${cliName} ${bold(`v${version}`)}`))}`);
    lines.push("");

    // Divider
    lines.push(`  ${dim("\u2500".repeat(40))}`);
    lines.push("");

    // Command list
    lines.push(`  ${bold(sky400("Quick start"))}`);
    lines.push(`    ${sky500("rolebox init")}      ${dim("initialize a new project")}`);
    lines.push(`    ${sky500("rolebox search")}    ${dim("search for available roles")}`);
    lines.push(`    ${sky500("rolebox install")}   ${dim("install a role from registry")}`);
    lines.push(`    ${sky500("rolebox --help")}    ${dim("show all commands and options")}`);
    lines.push("");

    // Docs link
    lines.push(`  ${dim("Documentation")}  ${sky400(repoUrl)}`);

    console.log("");
    for (const line of lines) {
      console.log(line);
    }
    console.log(reset());
  } catch {
    // Silently swallowed — must NEVER block install or emit errors
  }
}

// Allow running directly: node dist/cli/postinstall.js
showWelcome();
