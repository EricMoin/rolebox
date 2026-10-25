/**
 * Inline glyphs for the rolebox Tool-call rows.
 *
 * The rolebox client bundle deliberately imports NO host UI package (it is a
 * structural plugin: `@deepseek-ai/*` stays external and untyped at build
 * time), so the icon set is inlined here instead of importing
 * `@deepseek-ai/dsh-client-ui-primitives`. Every glyph uses the same 16px
 * box, 1.4 stroke, round joins and `currentColor`, which is what makes a
 * rolebox row sit beside a host-built row without a visible seam.
 *
 * @module
 */

import type { ToolViewIcon } from "./tool-view-descriptors.ts";

/** One family glyph; `icon` selects the drawing, never a runtime image. */
export function ToolViewIcon({ icon }: { icon: ToolViewIcon }) {
  return (
    <svg
      className="rolebox-tool-icon"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph(icon)}
    </svg>
  );
}

/**
 * @param icon - family glyph id.
 * @returns the SVG children for that family.
 */
function glyph(icon: ToolViewIcon) {
  switch (icon) {
    case "graph":
      return (
        <>
          <circle cx="8" cy="3.4" r="1.8" />
          <circle cx="3.2" cy="12" r="1.8" />
          <circle cx="12.8" cy="12" r="1.8" />
          <path d="M6.7 4.9 4.3 10.3M9.3 4.9l2.4 5.4M5 12h6" />
        </>
      );
    case "memory":
      return (
        <>
          <ellipse cx="8" cy="4" rx="5.2" ry="2.1" />
          <path d="M2.8 4v8c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V4" />
          <path d="M2.8 8c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1" />
        </>
      );
    case "session":
      return (
        <>
          <path d="M13.2 8.4c0 2.6-2.3 4.6-5.2 4.6-.6 0-1.2-.1-1.7-.2L3 14l.7-2.4C2.7 10.8 2.2 9.7 2.2 8.4 2.2 5.8 4.5 3.8 8 3.8s5.2 2 5.2 4.6Z" />
          <path d="M5.9 8.2h.01M8 8.2h.01M10.1 8.2h.01" />
        </>
      );
    case "team":
      return (
        <>
          <circle cx="5.8" cy="5.6" r="2" />
          <path d="M2.4 13c.3-2.2 1.7-3.5 3.4-3.5S8.9 10.8 9.2 13" />
          <circle cx="11.3" cy="6.3" r="1.5" />
          <path d="M9.7 12.6c.2-1.6 1-2.5 1.9-2.5 1 0 1.8.9 2 2.5" />
        </>
      );
    case "loop":
      return (
        <>
          <path d="M12.8 7.9a4.8 4.8 0 1 1-1.5-3.2" />
          <path d="M12.9 2.9v2.4h-2.4" />
          <path d="M3.2 8.1a4.8 4.8 0 0 0 1.5 3.2" />
          <path d="M3.1 13.1v-2.4h2.4" />
        </>
      );
    case "skill":
      return (
        <>
          <path d="M8 2.2 9.3 6.4 13.5 7.7 9.3 9 8 13.2 6.7 9 2.5 7.7 6.7 6.4Z" />
          <path d="M12.6 2.6v2.1M11.6 3.6h2.1" />
        </>
      );
    case "page":
      return (
        <>
          <path d="M4 2.2h5l3 3v8.6H4Z" />
          <path d="M9 2.2v3h3" />
          <path d="M6 8.4h4M6 10.8h4" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.6" />
          <path d="M5 6.8 6.8 8.6 5 10.4M8.6 10.6h2.4" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M4 2.2h5l3 3v8.6H4Z" />
          <path d="M9 2.2v3h3" />
          <path d="M6 6.6h2M6 9h4M6 11.4h4" />
        </>
      );
    case "asset":
      return (
        <>
          <path d="m8 2.4 5 2.6-5 2.6-5-2.6Z" />
          <path d="M3 5v5l5 2.6 5-2.6V5" />
          <path d="M8 7.6v5" />
        </>
      );
    case "signal":
      return (
        <>
          <circle cx="8" cy="8" r="1.4" />
          <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
          <path d="M3.2 12.8a6.8 6.8 0 0 1 0-9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" />
        </>
      );
    case "computer":
      return (
        <>
          <rect x="2.2" y="3" width="11.6" height="8" rx="1.4" />
          <path d="M6 13.4h4M8 11v2.4" />
        </>
      );
    case "browse":
      return (
        <>
          <circle cx="8" cy="8" r="5.6" />
          <path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3Z" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="7" cy="7" r="4" />
          <path d="m10.2 10.2 3 3" />
        </>
      );
    case "sparkle":
    default:
      return (
        <path d="M8 2.6 9.2 6.4 13 7.6 9.2 8.8 8 12.6 6.8 8.8 3 7.6 6.8 6.4Z" />
      );
  }
}
