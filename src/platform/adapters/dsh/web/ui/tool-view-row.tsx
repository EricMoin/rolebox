/**
 * One rolebox Tool-call row, registered for every rolebox wire tool name in the
 * host's keyed `tool.call.toolview` slot.
 *
 * The slot hands the row the call's stage (`preparing` / `start` / `result`),
 * the raw arguments and the settled content — NOT any host presentation view
 * (the Web client does not consume `presentCall`). Everything this row says is
 * therefore derived locally:
 *
 *   - the TITLE is the descriptor's localized action + object, rendered in the
 *     running or completed tense from `phase` ("正在声明图结构" / "已声明图结构");
 *   - the SUMMARY is the descriptor's salient argument (graph id + node/edge
 *     counts, a URL, a coordinate) and never echoes a payload that may hold a
 *     secret (`computer_type` / `browse_type` typed text);
 *   - the DETAILS body is the raw argument JSON and the result text, so the row
 *     stays inspectable without opening the session log.
 *
 * `t` is the namespace seat the slot synthesizes for entries registered with
 * `locale`; it follows the active dsh UI locale. The English dictionary is the
 * fallback when a host composes no locale service.
 *
 * @module
 */

import { useState } from "react";
import { TOOL_DESCRIPTORS } from "./tool-view-descriptors.ts";
import type { RoleboxToolViewProps, ToolCallBlockLike } from "./tool-view-contract.ts";
import { ToolViewIcon } from "./tool-view-icons.tsx";
import { toolViewClasses as css } from "./tool-view-css.ts";
import { en } from "./tool-view-locales.ts";

export type { RoleboxToolViewProps, ToolCallBlockLike } from "./tool-view-contract.ts";

/** Longest result body rendered in the disclosure before clipping. */
const RESULT_CLIP = 4000;

/** Locale-free fallback: interpolate the English dictionary directly. */
function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const template = en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}

/** First line of a value, clipped for one row. */
function firstLine(value: string, max = 120): string {
  const line = value.split("\n")[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Parse the call's argument JSON; a replay may carry malformed text. */
function parsedArgs(props: RoleboxToolViewProps): Record<string, unknown> | undefined {
  const raw = props.phase === "result"
    ? props.block.call?.argsRaw
    : props.phase === "start" ? props.block.argsRaw : undefined;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** First present string argument, skipping payload fields that may hold secrets. */
function genericSummary(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (key === "text" || key === "content" || key === "typed") continue;
    if (typeof value === "string" && value.trim() !== "") return firstLine(value);
  }
  return undefined;
}

/** Flatten a settled result's content to display text. */
function resultText(block: ToolCallBlockLike): string {
  const parts = (block.content ?? []).map((part) =>
    part.type === "text" ? part.text ?? "" : JSON.stringify(part));
  const text = parts.join("\n").trim();
  if (text !== "") return text;
  return block.error === undefined ? "" : `${block.error.name}: ${block.error.code}`;
}

/** Pretty-print the raw arguments for the details body. */
function prettyArgs(props: RoleboxToolViewProps): string | undefined {
  const raw = props.phase === "result" ? props.block.call?.argsRaw : props.block.argsRaw;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Render one rolebox tool call as a host-shaped transcript row.
 * @param props - slot owner share for this call (stage, arguments, result, `t`).
 * @returns the row, its optional error line, and the disclosure body.
 */
export function RoleboxToolRow(props: RoleboxToolViewProps) {
  const [open, setOpen] = useState(false);
  const t = props.t ?? fallbackTranslate;
  const descriptor = TOOL_DESCRIPTORS[props.toolName];
  const running = props.phase !== "result";
  const failed = props.phase === "result" && props.block.isError === true;
  const args = parsedArgs(props);
  const summary = (args === undefined ? undefined : descriptor?.summarize?.(args, t)) ??
    (args === undefined ? undefined : genericSummary(args));
  const title = descriptor === undefined
    ? props.toolName
    : running
      ? t("title.run", { verb: t(`verb.${descriptor.verb}.run`), noun: t(`noun.${descriptor.noun}`) })
      : t("title.done", { verb: t(`verb.${descriptor.verb}.done`), noun: t(`noun.${descriptor.noun}`) });
  const body = props.phase === "result" ? resultText(props.block) : "";
  const argsBody = prettyArgs(props);
  const hasDetails = argsBody !== undefined || body !== "";
  const state = running ? "running" : failed ? "error" : "ok";
  const errorLine = failed
    ? firstLine(body) || `${props.block.error?.name ?? "Error"}: ${props.block.error?.code ?? ""}`
    : undefined;
  const clippedBody = body.length > RESULT_CLIP ? `${body.slice(0, RESULT_CLIP)}\n…` : body;
  return (
    <div className={css.row} data-tool={props.toolName} data-state={state} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className={css.head}
        aria-expanded={open}
        title={hasDetails ? t(open ? "details.hide" : "details.show") : undefined}
        disabled={!hasDetails}
        onClick={() => setOpen(!open)}
      >
        <ToolViewIcon icon={descriptor?.icon ?? "sparkle"} />
        <span className={css.title} title={title}>{title}</span>
        {summary === undefined ? null : <span className={css.summary} title={summary}>{summary}</span>}
        <span className={css.state}>
          {running
            ? <span className={css.spinner} aria-hidden="true" />
            : <svg
                className={css.chevron}
                viewBox="0 0 16 16"
                width={12}
                height={12}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 3.5 4.5 4.5L6 12.5" />
              </svg>}
        </span>
      </button>
      {errorLine === undefined ? null : <p className={css.error} title={errorLine}>{errorLine}</p>}
      {open && hasDetails ? (
        <div className={css.details}>
          {argsBody === undefined ? null : (
            <section className={css.section}>
              <h4 className={css.sectionLabel}>{t("details.args")}</h4>
              <pre className={css.pre}>{argsBody}</pre>
            </section>
          )}
          {clippedBody === "" ? null : (
            <section className={css.section}>
              <h4 className={css.sectionLabel}>{t(failed ? "details.error" : "details.result")}</h4>
              <pre className={css.pre}>{clippedBody}</pre>
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}
