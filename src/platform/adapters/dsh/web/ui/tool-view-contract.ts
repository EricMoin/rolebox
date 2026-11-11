/**
 * Structural contract between the host's keyed `tool.call.toolview` slot and
 * the rolebox rows.
 *
 * Kept in a plain `.ts` module (not beside the `.tsx` component) so the dsh
 * contract verifier can parse the mirror with the TypeScript AST: a JSX file
 * is not a valid `ScriptKind.TS` source.
 *
 * The shape is a duck of `@deepseek-ai/dsh-client-ui-tool`'s
 * `ToolCallOwnerProps` (owner share: common props + the phase-discriminated
 * block). Rolebox never imports the host package at runtime, so this mirror is
 * the only place the seam is written down.
 *
 * @module
 */

import type { ToolViewTranslate } from "./tool-view-descriptors.ts";

/** One content block of a settled result (structural). */
export interface ToolCallBlockLike {
  /** Dispatched call arguments; absent on a prepared-only call. */
  readonly argsRaw?: string;
  /** The paired call head once settled (null when it left the loaded window). */
  readonly call?: { readonly name: string; readonly argsRaw: string } | null;
  /** Settled content blocks. */
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  /** Whether the call settled as an error. */
  readonly isError?: boolean;
  /** Structured failure when the call settled as an error. */
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string };
}

/**
 * Props the keyed slot passes to every registered tool view.
 *
 * `t` is NOT part of the host's owner share: the slot synthesizes that seat for
 * entries whose registration declares a `locale` namespace, so it is optional
 * in the mirror and the row falls back to English when a host composes no
 * locale service.
 */
export interface RoleboxToolViewProps {
  /** Call identity, stable across stages. */
  readonly callId: string;
  /** Wire tool name (also the registration key). */
  readonly toolName: string;
  /** Current stage of the call. */
  readonly phase: "preparing" | "start" | "result";
  /** Stage data. */
  readonly block: ToolCallBlockLike;
  /** Namespace-bound translate, synthesized for registrations that declare `locale`. */
  readonly t?: ToolViewTranslate;
}
