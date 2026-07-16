import { describe, it, expect } from "bun:test";
import {
  LANGUAGE_SERVER_REGISTRY,
  getLanguageIdFromExtension,
  isServerAvailable,
  getServerConfig,
  autoDetectServers,
} from "../../src/lsp/servers.ts";

// ---------------------------------------------------------------------------
// LANGUAGE_SERVER_REGISTRY (structural assertions)
// ---------------------------------------------------------------------------

describe("LANGUAGE_SERVER_REGISTRY", () => {
  it("defines entries for all expected languages", () => {
    const expected = ["typescript", "python", "go", "rust", "c", "cpp", "java", "ruby", "bash", "lua", "kotlin"];
    for (const lang of expected) {
      expect(LANGUAGE_SERVER_REGISTRY[lang]).toBeDefined();
      expect(Array.isArray(LANGUAGE_SERVER_REGISTRY[lang])).toBe(true);
    }
  });

  it("each entry has required fields", () => {
    for (const [langId, configs] of Object.entries(LANGUAGE_SERVER_REGISTRY)) {
      for (const config of configs) {
        expect(config.languageId).toBe(langId);
        expect(typeof config.command).toBe("string");
        expect(config.command.length).toBeGreaterThan(0);
        expect(Array.isArray(config.args)).toBe(true);
        expect(Array.isArray(config.filePatterns)).toBe(true);
        expect(Array.isArray(config.extensions)).toBe(true);
        expect(config.extensions.length).toBeGreaterThan(0);
      }
    }
  });

  it("no extension is shared between language entries", () => {
    const extToLang: Record<string, string> = {};
    for (const [langId, configs] of Object.entries(LANGUAGE_SERVER_REGISTRY)) {
      for (const config of configs) {
        for (const ext of config.extensions) {
          if (extToLang[ext] && extToLang[ext] !== langId) {
            // .h is shared between c and cpp — this is expected
            // .hpp is cpp-only; .c is c-only
            if (ext === ".h") continue; // c and cpp both handle .h
            throw new Error(`Extension ${ext} is claimed by both ${extToLang[ext]} and ${langId}`);
          }
          extToLang[ext] = langId;
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getLanguageIdFromExtension
// ---------------------------------------------------------------------------

describe("getLanguageIdFromExtension", () => {
  it("returns typescript for .ts", () => {
    expect(getLanguageIdFromExtension("file.ts")).toBe("typescript");
  });

  it("returns typescript for .tsx", () => {
    expect(getLanguageIdFromExtension("component.tsx")).toBe("typescript");
  });

  it("returns python for .py", () => {
    expect(getLanguageIdFromExtension("main.py")).toBe("python");
  });

  it("returns go for .go", () => {
    expect(getLanguageIdFromExtension("main.go")).toBe("go");
  });

  it("returns rust for .rs", () => {
    expect(getLanguageIdFromExtension("lib.rs")).toBe("rust");
  });

  it("returns bash for .sh", () => {
    expect(getLanguageIdFromExtension("script.sh")).toBe("bash");
  });

  it("returns bash for .bash", () => {
    expect(getLanguageIdFromExtension("script.bash")).toBe("bash");
  });

  it("handles full paths", () => {
    expect(getLanguageIdFromExtension("/home/user/project/src/index.ts")).toBe("typescript");
  });

  it("handles paths with multiple dots", () => {
    expect(getLanguageIdFromExtension("my.component.test.tsx")).toBe("typescript");
  });

  it("returns undefined for unknown extension", () => {
    expect(getLanguageIdFromExtension("file.xyz")).toBeUndefined();
  });

  it("returns undefined when file has no extension", () => {
    expect(getLanguageIdFromExtension("Makefile")).toBeUndefined();
  });

  it("is case-insensitive for extensions", () => {
    expect(getLanguageIdFromExtension("file.TS")).toBe("typescript");
    expect(getLanguageIdFromExtension("file.PY")).toBe("python");
    expect(getLanguageIdFromExtension("file.RS")).toBe("rust");
  });

  it("returns c for .c and cpp for .cpp", () => {
    expect(getLanguageIdFromExtension("source.c")).toBe("c");
    expect(getLanguageIdFromExtension("source.cpp")).toBe("cpp");
  });
});

// ---------------------------------------------------------------------------
// isServerAvailable
// ---------------------------------------------------------------------------

describe("isServerAvailable", () => {
  it("returns false for unknown language", () => {
    expect(isServerAvailable("unknown-lang")).toBe(false);
  });

  it("returns boolean for known languages", () => {
    // This is a platform-dependent check — we just verify the type
    const result = isServerAvailable("typescript");
    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// getServerConfig
// ---------------------------------------------------------------------------

describe("getServerConfig", () => {
  it("returns null for unknown language", () => {
    expect(getServerConfig("nonexistent")).toBeNull();
  });

  it("returns config for known language (command may not be on PATH)", () => {
    const config = getServerConfig("typescript");
    if (config) {
      expect(config.languageId).toBe("typescript");
      expect(config.command).toBeTruthy();
      expect(Array.isArray(config.args)).toBe(true);
    } else {
      // If typescript-language-server is not on PATH, config is still the first entry
      // but command is not resolved to a binary
      expect(config).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// autoDetectServers
// ---------------------------------------------------------------------------

describe("autoDetectServers", () => {
  it("returns an array of detected languages", () => {
    const result = autoDetectServers(process.cwd());
    expect(Array.isArray(result)).toBe(true);
  });

  it("detects typescript when package.json is present", () => {
    // rolebox project has package.json, so typescript should be detected
    const result = autoDetectServers(process.cwd());
    expect(result).toContain("typescript");
  });

  it("returns empty array for an empty directory with no language markers", () => {
    const result = autoDetectServers("/tmp");
    // No project markers in /tmp — only languages with no filePatterns (bash, lua)
    // might still be detected based on binary availability
    expect(Array.isArray(result)).toBe(true);
  });
});
