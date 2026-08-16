import { existsSync } from "node:fs";
import path from "node:path";
import { createSubLogger } from "../logger.ts";
import type { LspServerConfig } from "./types.ts";

const log = createSubLogger("lsp:servers");

export const LANGUAGE_SERVER_REGISTRY: Record<string, LspServerConfig[]> = {
  typescript: [
    {
      languageId: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      rootUri: "",
      filePatterns: ["tsconfig.json", "package.json"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    },
  ],
  python: [
    {
      languageId: "python",
      command: "pyright-langserver",
      args: ["--stdio"],
      rootUri: "",
      filePatterns: ["pyproject.toml", "setup.py", "requirements.txt"],
      extensions: [".py"],
    },
  ],
  go: [
    {
      languageId: "go",
      command: "gopls",
      args: [],
      rootUri: "",
      filePatterns: ["go.mod"],
      extensions: [".go"],
    },
  ],
  rust: [
    {
      languageId: "rust",
      command: "rust-analyzer",
      args: [],
      rootUri: "",
      filePatterns: ["Cargo.toml"],
      extensions: [".rs"],
    },
  ],
  c: [
    {
      languageId: "c",
      command: "clangd",
      args: [],
      rootUri: "",
      filePatterns: ["compile_commands.json", "CMakeLists.txt"],
      extensions: [".c", ".h"],
    },
  ],
  cpp: [
    {
      languageId: "cpp",
      command: "clangd",
      args: [],
      rootUri: "",
      filePatterns: ["compile_commands.json", "CMakeLists.txt"],
      extensions: [
        ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h",
      ],
    },
  ],
  java: [
    {
      languageId: "java",
      command: "jdtls",
      args: ["-data", "jdtls-workspace"],
      rootUri: "",
      filePatterns: ["pom.xml", "build.gradle", "build.gradle.kts"],
      extensions: [".java"],
    },
  ],
  ruby: [
    {
      languageId: "ruby",
      command: "solargraph",
      args: ["stdio"],
      rootUri: "",
      filePatterns: ["Gemfile"],
      extensions: [".rb"],
    },
  ],
  bash: [
    {
      languageId: "bash",
      command: "bash-language-server",
      args: ["start"],
      rootUri: "",
      filePatterns: [],
      extensions: [".sh", ".bash", ".zsh", ".ksh"],
    },
  ],
  lua: [
    {
      languageId: "lua",
      command: "lua-language-server",
      args: [],
      rootUri: "",
      filePatterns: [".luarc.json"],
      extensions: [".lua"],
    },
  ],
  kotlin: [
    {
      languageId: "kotlin",
      command: "kotlin-lsp",
      args: ["--stdio"],
      rootUri: "",
      filePatterns: ["build.gradle.kts", "build.gradle", "settings.gradle.kts"],
      extensions: [".kt", ".kts"],
    },
  ],
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [langId, configs] of Object.entries(LANGUAGE_SERVER_REGISTRY)) {
    for (const config of configs) {
      for (const ext of config.extensions) {
        if (!map[ext]) map[ext] = langId;
      }
    }
  }
  return map;
})();

export function getLanguageIdFromExtension(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}

function findCommandOnPath(command: string): string | null {
  const isWin = process.platform === "win32";

  // Dual-runtime guard: Bun.which is Bun-only. Pi loads this module via jiti
  // in a Node.js process where the Bun global does not exist, so under Node we
  // fall back to a portable PATH lookup. Matches the isBunRuntime() pattern
  // in src/memory/db-driver.ts.
  if (typeof (globalThis as any).Bun !== "undefined") {
    const resolved = (globalThis as any).Bun?.which?.(command);
    if (resolved) return resolved;
  } else {
    // Node-portable PATH lookup: walk each PATH dir, trying the command name
    // (plus PATHEXT extensions on Windows, defaulting to exe/cmd/bat/com).
    const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
    const extensions = isWin
      ? (process.env.PATHEXT ?? ".exe;.cmd;.bat;.com").split(";")
      : [""];

    for (const dir of pathDirs) {
      if (!dir) continue;
      for (const ext of extensions) {
        const candidate = path.join(dir, command + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const commonPaths = [
    path.join(home, ".local", "bin", command),
    path.join(home, ".local", "bin", command + (isWin ? ".cmd" : "")),
    "/usr/local/bin/" + command,
    "/opt/homebrew/bin/" + command,
    "/usr/bin/" + command,
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

export function autoDetectServers(directory: string): string[] {
  const detected: string[] = [];
  const searchDirs = [directory, process.cwd()];

  for (const [langId, configs] of Object.entries(LANGUAGE_SERVER_REGISTRY)) {
    for (const config of configs) {
      const binaryPath = findCommandOnPath(config.command);
      if (!binaryPath) {
        continue;
      }

      if (config.filePatterns.length === 0 && config.extensions.length > 0) {
        if (!detected.includes(langId)) {
          detected.push(langId);
          log.info(`Detected ${langId} server: ${config.command} at ${binaryPath}`);
        }
        break;
      }

      let projectFound = false;
      for (const searchDir of searchDirs) {
        for (const pattern of config.filePatterns) {
          if (existsSync(path.join(searchDir, pattern))) {
            projectFound = true;
            break;
          }
        }
        if (projectFound) break;
      }

      if (!detected.includes(langId)) {
        detected.push(langId);
        log.info(`Detected ${langId} server: ${config.command} at ${binaryPath}`);
      }
      break;
    }
  }

  return detected;
}

export function getServerConfig(languageId: string): LspServerConfig | null {
  const configs = LANGUAGE_SERVER_REGISTRY[languageId];
  if (!configs || configs.length === 0) return null;

  for (const config of configs) {
    const binaryPath = findCommandOnPath(config.command);
    if (binaryPath) {
      return { ...config, command: binaryPath };
    }
  }

  return configs[0];
}

export function isServerAvailable(languageId: string): boolean {
  const configs = LANGUAGE_SERVER_REGISTRY[languageId];
  if (!configs) return false;
  for (const config of configs) {
    if (findCommandOnPath(config.command)) return true;
  }
  return false;
}
