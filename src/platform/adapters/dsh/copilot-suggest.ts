/**
 * CopilotSuggester — dsh adapter for the composer draft suggester.
 *
 * Resolves the acting role for a session, composes the effective
 * `copilot.draft` config (role > project > global), assembles the recent
 * transcript and makes ONE bounded model call through the structural
 * {@link DraftLlm} seam. The HTTP surface lives in `web-copilot-route.ts`;
 * this module is transport-free so it can be unit tested against fakes.
 *
 * Role resolution matches the rest of the dsh adapter set:
 *
 *   roleId = activeRole(sessionId) ?? defaultRoleId
 *
 * where `activeRole` is the per-session rolebox binding and `defaultRoleId` is
 * the host config's `activeRole` seed. A role-less session is NOT disabled by
 * itself: a missing role simply contributes no fragment, so an enabled project
 * or global `copilot.draft` still applies. A role without an enabled draft
 * config, a missing provider/model, or an absent llm service produce a stable
 * `disabled` reason instead of an error.
 *
 * The `sessionClient.get` probe runs first so a request for an unknown session
 * is reported as `unknown-session` (the route maps it to 404) rather than as a
 * missing transcript. Transcript read failures stay `none`.
 *
 * @module
 */

import {
  composeCopilotConfig,
  parseCopilotDraftFragment,
} from "../../../copilot/config.ts";
import type { CopilotDraftFragment } from "../../../copilot/types.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import { assembleTranscript } from "../../../copilot/transcript.ts";
import type { DraftLlm, SuggestDraftResult } from "../../../copilot/draft/suggest.ts";
import { suggestDraft } from "../../../copilot/draft/suggest.ts";

/** Minimal role shape the suggester reads (a `ResolvedRole` satisfies it). */
export interface CopilotSuggestRole {
  id: string;
  config: { copilot?: unknown };
}

/** Dependencies for {@link createCopilotSuggester}. */
export interface CopilotSuggesterDeps {
  /** Resolved roles (read lazily on every suggestion). */
  roles: ReadonlyArray<CopilotSuggestRole>;
  /** Per-session active role lookup. */
  activeRole: (sessionId: string) => string | null | undefined;
  /** Fallback role id when the session has no active binding. */
  defaultRoleId?: string;
  /**
   * Project-level fragment (`.rolebox/config.json`), read once at boot.
   * Lower precedence than the role, higher than the global file.
   */
  projectFragment?: CopilotDraftFragment;
  /**
   * Global fragment (`<rolebox-config-home>/config.yaml`), read once at boot.
   * Lowest precedence; used when neither the role nor the project supplies a
   * field.
   */
  globalFragment?: CopilotDraftFragment;
  /** Session client used for the existence probe and transcript assembly. */
  sessionClient: ISessionClient;
  /** Host llm service, when the profile mounts one. */
  llm?: DraftLlm;
}

/** Outcome of one suggestion request. */
export type CopilotSuggestOutcome =
  | { status: "suggested"; text: string; model: string; ms: number }
  | { status: "none"; reason: string }
  | { status: "disabled"; reason: string }
  | { status: "unknown-session" };

/** A suggestion function bound to one host's dependencies. */
export type CopilotSuggester = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<CopilotSuggestOutcome>;

/**
 * Construct the draft suggester for one host boot.
 *
 * The parsed role fragment is memoized per role OBJECT (and per raw `copilot`
 * block): parsing warns for removed legacy keys, and those warnings must fire
 * once per role rather than once per suggestion. Keying by object also keeps
 * the cache reload-safe — `POST /rolebox/reload` swaps NEW role objects into
 * the same stable `roles` array, so an id-keyed cache would keep serving the
 * pre-reload `copilot.draft` until a host restart. Project/global fragments are
 * read by the caller once at boot.
 *
 * @param deps - Role catalog, active-role lookup, project/global fragments,
 *               session client and llm seam.
 * @returns The `(sessionId, signal) => outcome` function the route invokes.
 */
export function createCopilotSuggester(
  deps: CopilotSuggesterDeps,
): CopilotSuggester {
  const roleFragments = new WeakMap<
    CopilotSuggestRole,
    { raw: unknown; fragment: CopilotDraftFragment }
  >();

  /** Parse (and remember) one role's `copilot` fragment. */
  const roleFragmentOf = (role: CopilotSuggestRole): CopilotDraftFragment => {
    const raw = role.config.copilot;
    const cached = roleFragments.get(role);
    if (cached !== undefined && cached.raw === raw) return cached.fragment;
    const fragment = parseCopilotDraftFragment(raw);
    roleFragments.set(role, { raw, fragment });
    return fragment;
  };

  return async (sessionId, signal) => {
    if (signal.aborted) return { status: "none", reason: "aborted" };

    // Existence first: an unknown session is a distinct outcome (HTTP 404),
    // not a transcript read failure.
    let exists: unknown;
    try {
      exists = await deps.sessionClient.get(sessionId);
    } catch {
      return { status: "none", reason: "transcript-unavailable" };
    }
    if (exists === null || exists === undefined) {
      return { status: "unknown-session" };
    }

    // A role-less session is allowed: it simply contributes no fragment, so
    // an enabled project/global config can still drive the suggestion.
    const roleId = deps.activeRole(sessionId) ?? deps.defaultRoleId;
    const role = roleId === undefined
      ? undefined
      : deps.roles.find((candidate) => candidate.id === roleId);
    const roleFragment = role === undefined ? undefined : roleFragmentOf(role);

    const config = composeCopilotConfig([
      roleFragment,
      deps.projectFragment,
      deps.globalFragment,
    ]).draft;
    if (!config.enabled) return { status: "disabled", reason: "not-enabled" };
    const provider = config.provider;
    const model = config.model;
    if (!provider || !model) {
      return { status: "disabled", reason: "model-not-configured" };
    }
    if (!deps.llm) return { status: "disabled", reason: "llm-unavailable" };

    const transcript = await assembleTranscript(deps.sessionClient, sessionId, {
      window_size: config.window_size,
      max_chars: config.transcript_max_chars,
      include_tools: true,
    });
    if (transcript === null) {
      return { status: "none", reason: "transcript-unavailable" };
    }

    const startedAt = Date.now();
    const result: SuggestDraftResult = await suggestDraft({
      config,
      transcript,
      llm: deps.llm,
      provider,
      model,
      signal,
    });
    const ms = Date.now() - startedAt;

    if (result.kind === "suggested") {
      return { status: "suggested", text: result.text, model, ms };
    }
    return { status: "none", reason: result.reason };
  };
}
