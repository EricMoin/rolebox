/// <reference types="bun-types" />

/**
 * UNIT TESTS for `scripts/npm-readme.ts` — the pack-time README rewriter that
 * gives npm's copy of the README absolute image URLs while the file on disk
 * stays branch-relative for GitHub.
 *
 * What is pinned here:
 *
 * 1. THE ROUND TRIP. `relative(absolute(md))` restores the original bytes, so
 *    `prepack`/`postpack` leave the working tree exactly as it was committed.
 * 2. ONLY `src` VALUES CHANGE. The five shields.io badges and every `href` are
 *    byte-identical after `absolute`, and foreign absolute URLs are untouched.
 * 3. IDEMPOTENCE. A second `absolute` or `relative` pass rewrites nothing.
 * 4. THE FAILURE PATH. A path absent from the passed commit/file set raises
 *    `MissingLocalImagesError` naming the path instead of producing a rewritten
 *    document — injected here, never shelled out to git.
 *
 * The real `README.md` is never mutated: every case passes its own markdown and
 * its own existence check.
 */

import { describe, expect, it } from "bun:test";

import {
  MissingLocalImagesError,
  absolute,
  deriveRepoSlug,
  relative,
} from "../scripts/npm-readme.ts";

const OWNER = "owner";
const REPO = "repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${SHA}`;

/**
 * The shields.io badges rolebox's README carries, in README order. The rewriter
 * must leave every one of them untouched; keep this list in step with
 * `README.md` when the badge row changes.
 */
const BADGES = [
  "https://img.shields.io/npm/v/rolebox",
  "https://img.shields.io/badge/dsh-0.2.1--alpha.3%2B-blue",
  "https://img.shields.io/github/actions/workflow/status/EricMoin/rolebox/ci.yml",
  "https://img.shields.io/github/stars/EricMoin/rolebox",
  "https://img.shields.io/npm/dm/rolebox",
  "https://img.shields.io/github/license/EricMoin/rolebox",
];

/** Local image paths, one banner plus screenshots, as the README spells them. */
const LOCAL_IMAGES = [
  "assets/banner.png",
  "assets/screenshots/role-picker.png",
  "assets/screenshots/monitor-tui.png",
];

/** A README with local images, shields.io badges and a relative `href`. */
const README = [
  '<p align="center">',
  `  <img alt="rolebox" src="${LOCAL_IMAGES[0]}" width="640">`,
  "</p>",
  "",
  ...BADGES.map((url, index) => `<a href="https://example.com/${index}"><img alt="badge ${index}" src="${url}"></a>`),
  "",
  `<a href="LICENSE">License</a>`,
  "",
  `  <img alt="picker" src="${LOCAL_IMAGES[1]}" width="880">`,
  `  <img alt="monitor" src="${LOCAL_IMAGES[2]}" width="900">`,
  "",
].join("\n");

/** The absolute-mode context with every local path treated as present. */
function existing(): { owner: string; repo: string; sha: string; exists: (path: string) => boolean } {
  return { owner: OWNER, repo: REPO, sha: SHA, exists: () => true };
}

/** Every `src` attribute value in `markdown`, in document order. */
function srcValues(markdown: string): string[] {
  return [...markdown.matchAll(/src="([^"]*)"/g)].map((match) => match[1] as string);
}

describe("deriveRepoSlug", () => {
  it("parses the scp-like origin form", () => {
    expect(deriveRepoSlug("git@github.com:EricMoin/rolebox.git")).toEqual({
      host: "github.com",
      owner: "EricMoin",
      repo: "rolebox",
    });
  });

  it("parses the https origin form, with or without the .git suffix", () => {
    expect(deriveRepoSlug("https://github.com/EricMoin/rolebox.git")).toEqual({
      host: "github.com",
      owner: "EricMoin",
      repo: "rolebox",
    });
    expect(deriveRepoSlug("https://github.com/EricMoin/rolebox")).toEqual({
      host: "github.com",
      owner: "EricMoin",
      repo: "rolebox",
    });
  });

  it("parses the ssh:// origin form", () => {
    expect(deriveRepoSlug("ssh://git@github.com/EricMoin/rolebox.git")).toEqual({
      host: "github.com",
      owner: "EricMoin",
      repo: "rolebox",
    });
  });

  it("fails loudly instead of guessing for an unusable origin", () => {
    expect(() => deriveRepoSlug("not-a-remote")).toThrow(/cannot derive/);
    expect(() => deriveRepoSlug("https://github.com/EricMoin")).toThrow(/cannot derive/);
  });
});

describe("absolute", () => {
  it("pins every local image to the SHA-pinned raw URL", () => {
    const result = absolute(README, existing());
    expect(result.rewritten).toBe(LOCAL_IMAGES.length);
    expect(result.content).toContain(`src="${RAW}/assets/banner.png"`);
    expect(result.content).toContain(`src="${RAW}/assets/screenshots/role-picker.png"`);
    expect(result.content).toContain(`src="${RAW}/assets/screenshots/monitor-tui.png"`);
    expect(result.content).not.toContain('src="assets/');
  });

  it("leaves the shields.io badges and every href byte-identical", () => {
    const result = absolute(README, existing());
    for (const badge of BADGES) {
      expect(result.content).toContain(`src="${badge}"`);
    }
    expect(srcValues(result.content).filter((src) => src.startsWith("https://img.shields.io/"))).toEqual(BADGES);
    expect(result.content).toContain('<a href="LICENSE">License</a>');
    expect(result.content).toContain('<a href="https://example.com/0">');
  });

  it("leaves foreign absolute image URLs alone", () => {
    const markdown = '<img src="https://example.com/other.png">\n<img src="assets/local.png">\n';
    const result = absolute(markdown, existing());
    expect(result.content).toContain('src="https://example.com/other.png"');
    expect(result.content).toContain(`src="${RAW}/assets/local.png"`);
    expect(result.rewritten).toBe(1);
  });

  it("is idempotent", () => {
    const once = absolute(README, existing());
    const twice = absolute(once.content, existing());
    expect(twice.content).toBe(once.content);
    expect(twice.rewritten).toBe(0);
  });

  it("returns a README with no local images unchanged", () => {
    const markdown = [...BADGES.map((url) => `<img src="${url}">`)].join("\n");
    const result = absolute(markdown, existing());
    expect(result.content).toBe(markdown);
    expect(result.rewritten).toBe(0);
  });

  it("checks the repository path, not the ./ spelling", () => {
    const seen: string[] = [];
    const result = absolute('<img src="./assets/banner.png">', {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });
    expect(seen).toEqual(["assets/banner.png"]);
    expect(result.content).toBe(`<img src="${RAW}/assets/banner.png">`);
  });

  it("reports every path missing from the commit and writes nothing", () => {
    const present = new Set([LOCAL_IMAGES[0]]);
    let thrown: unknown;
    try {
      absolute(README, { ...existing(), exists: (path) => present.has(path) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingLocalImagesError);
    const error = thrown as MissingLocalImagesError;
    expect(error.missing).toEqual([LOCAL_IMAGES[1], LOCAL_IMAGES[2]]);
    expect(error.message).toContain(LOCAL_IMAGES[1]);
    expect(error.message).toContain(LOCAL_IMAGES[2]);
    expect(error.message).not.toContain(`src="${RAW}`);
  });
});

describe("relative", () => {
  it("undoes absolute byte-for-byte", () => {
    const pinned = absolute(README, existing()).content;
    const restored = relative(pinned, { owner: OWNER, repo: REPO });
    expect(restored.content).toBe(README);
    expect(restored.rewritten).toBe(LOCAL_IMAGES.length);
  });

  it("is idempotent", () => {
    const pinned = absolute(README, existing()).content;
    const once = relative(pinned, { owner: OWNER, repo: REPO });
    const twice = relative(once.content, { owner: OWNER, repo: REPO });
    expect(twice.content).toBe(once.content);
    expect(twice.rewritten).toBe(0);
  });

  it("returns a README with no local images unchanged", () => {
    const markdown = [...BADGES.map((url) => `<img src="${url}">`)].join("\n");
    const result = relative(markdown, { owner: OWNER, repo: REPO });
    expect(result.content).toBe(markdown);
    expect(result.rewritten).toBe(0);
  });

  it("leaves other repositories' and non-SHA raw URLs alone", () => {
    const foreign = [
      "https://raw.githubusercontent.com/other/repo/0123456789abcdef0123456789abcdef01234567/a.png",
      "https://raw.githubusercontent.com/owner/repo/main/a.png",
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${SHA}`,
    ];
    const markdown = foreign.map((url) => `<img src="${url}">`).join("\n");
    const result = relative(markdown, { owner: OWNER, repo: REPO });
    expect(result.rewritten).toBe(0);
    expect(result.content).toBe(markdown);
  });
});
