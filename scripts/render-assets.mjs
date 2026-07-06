#!/usr/bin/env node
/**
 * Render rolebox brand assets (logo + banner) from SVG to PNG.
 *
 * Uses @resvg/resvg-js with system fonts (Space Grotesk Bold expected).
 * Outputs 2x-resolution PNGs for crisp display on high-DPI screens.
 *
 * Usage:
 *   bun run scripts/render-assets.mjs
 *   node scripts/render-assets.mjs
 *
 * Font requirement: Space Grotesk Bold must be discoverable via fontDirs
 * below. On macOS it lives at ~/Library/Fonts/SpaceGrotesk-Bold.ttf (if
 * installed globally). For CI portability, drop SpaceGrotesk-Bold.ttf into
 * assets/fonts/.
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ASSETS = join(ROOT, "assets");

// Candidate font directories — first existing wins for resvg font discovery.
const fontDirs = [
  join(ASSETS, "fonts"),                          // bundled fallback (portable)
  join(homedir(), "Library", "Fonts"),            // macOS user fonts
  "/Library/Fonts",                               // macOS system fonts
  "/usr/share/fonts",                             // Linux
  "/usr/local/share/fonts",                       // Linux (homebrew/manual)
  join(homedir(), ".fonts"),                       // Linux user fonts
].filter((d) => existsSync(d));

if (fontDirs.length === 0) {
  console.error("No font directories found. Install Space Grotesk or create assets/fonts/.");
  process.exit(1);
}

const hasSpaceGrotesk = fontDirs.some((d) => {
  try {
    return readdirSync(d).some((f) => /spacegrotesk/i.test(f));
  } catch {
    return false;
  }
});
console.log(`Font dirs: ${fontDirs.join(", ")}`);
console.log(`Space Grotesk detected: ${hasSpaceGrotesk}`);

/**
 * Render SVG to PNG at an exact target width (height derived from SVG ratio).
 * @param {string} svgPath
 * @param {string} pngPath
 * @param {number} targetWidth
 */
function renderAt(svgPath, pngPath, targetWidth) {
  const svg = readFileSync(svgPath, "utf-8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: targetWidth },
    background: "transparent",
    font: {
      loadSystemFonts: true,
      fontDirs,
      defaultFontFamily: "Space Grotesk",
    },
  });
  const png = resvg.render().asPng();
  writeFileSync(pngPath, png);
  const ratio = resvg.height / resvg.width;
  console.log(`  ${svgPath} -> ${pngPath}  (${targetWidth}x${Math.round(targetWidth * ratio)} PNG)`);
}

console.log("Rendering brand assets:");
// Logo: 1024px wide (2x of 512) — crisp for npm/favicons
renderAt(join(ASSETS, "logo.svg"), join(ASSETS, "logo.png"), 1024);
// Banner: 2560px wide (2x of 1280) — crisp on high-DPI README display
renderAt(join(ASSETS, "banner.svg"), join(ASSETS, "banner.png"), 2560);

console.log("Done.");
