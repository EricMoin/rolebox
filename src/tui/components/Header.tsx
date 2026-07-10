/**
 * TUI header components (title bar and rule).
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import type { ThemeColors } from "../helpers.ts";
import { rgbaToCSS, BOLD, DIM, G_RULE, RULE_WIDTH, LEN_VERSION, truncate } from "../helpers.ts";

export function renderHeader(props: { c: ThemeColors; version: string }) {
  const c = props.c;
  return (
    <text>
      <span fg={rgbaToCSS(c.primary)} attributes={BOLD}>{"Rolebox"}</span>
      <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" v" + truncate(props.version, LEN_VERSION)}</span>
    </text>
  );
}

export function renderRule(props: { c: ThemeColors }) {
  const c = props.c;
  return <text fg={rgbaToCSS(c.borderSubtle)} attributes={DIM}>{G_RULE.repeat(RULE_WIDTH)}</text>;
}
