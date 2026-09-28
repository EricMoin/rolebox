/**
 * opencode v2 — the OUTCOME run path's host capability layer.
 *
 * THIN ON PURPOSE. Everything the declared-graph run path needs already lives
 * in the shared opencode-family module (../opencode/graph-host.ts): the session
 * port adapter, the delivery/observation/cancel ports, the `GraphApplication`
 * assembly and the bound tool face. This module only fills in the v2 facts and
 * opens the shared host:
 *
 *  1. SESSION — the entry's `Opencode2SessionAdapter`
 *     (src/platform/adapters/opencode2/session.ts) is the `ISessionClient` this
 *     host dispatches through. Its `abort` IS the platform's interrupt
 *     (`ctx.session.interrupt`, SessionInterruptResponse.interrupted,
 *     node_modules/@opencode/client/dist/promise/generated/types.d.ts:330-332),
 *     so no custom interrupt is passed: the port's own `client.abort` is the
 *     platform's own report.
 *  2. WAIT — v2's plugin session domain exposes `wait` (`SessionDomain = Pick<
 *     SessionApi, "create" | ... | "wait" | "context">`,
 *     node_modules/@opencode/plugin/dist/promise/session.d.ts:143-145;
 *     `SessionWaitInput`/`SessionWaitOutput` at
 *     node_modules/@opencode/client/dist/effect/api/api.d.ts:367-371), which
 *     resolves when the session's current turn finishes. The entry passes
 *     `ctx.session.wait` through, and that is the ONLY reason a completion can
 *     be observed without an event: it is never synthesized, and it says
 *     nothing about an OUTCOME (the submission does).
 *  3. EVENTS — the v2 entry consumes the host's event stream and relays
 *     `session.idle` / `session.error` into the v1 handler map
 *     (src/entries/opencode2.ts, startEventRelay), so it feeds this host every
 *     end it receives (`sessionEndFeed: true`). The SAME relay feeds the typed
 *     `session.status` state (idle / busy / retry) to
 *     `noteSessionStatus`, which is where this platform's activity state comes
 *     from — there is no status call to make.
 *  4. THE WAKE-UP CHANNEL — the declaring session's run notification travels
 *     through the SAME `ISessionClient` this host dispatches over (the entry
 *     names it, and the factory falls back to `options.client` when it does
 *     not), so a main agent that declared a graph is
 *     woken with the shipped `[GRAPH COMPLETE] / [GRAPH BLOCKED]` push instead of
 *     polling `graph_status`. The v2 adapter's `prompt` maps `noReply: false`
 *     onto `resume: true` (src/platform/adapters/opencode2/session.ts:572-581),
 *     which is what resumes the declaring agent's loop, and its `prompt`
 *     DEGRADES to `null` when the session domain cannot carry one — a rejected
 *     send leaves the notification pending and retried, never thrown. No second
 *     adapter is built for this and no raw `ctx.session` reaches the host.
 *
 * V2 HAS NO `session.status` CALL, AND ITS READING DOES NOT NEED ONE. The
 * plugin domain exposes no per-session status operation (the client's argument-
 * less `active` reports ONLY currently-running sessions and is not in the
 * plugin's `SessionDomain` Pick at all), so `Opencode2SessionAdapter.status`
 * answers `null`. The same information is reachable through the two channels v2
 * does expose, and this factory wires both:
 *
 *  - `ctx.session.get({sessionID})` returns the session's own terminal
 *    `outcome` (`succeeded` / `failed` / `interrupted`). The canonical
 *    `SessionInfo` the adapter projects it onto has no outcome slot, so the
 *    ENTRY builds that read over the raw domain and hands it in as
 *    {@link openOpencode2GraphHost}'s `observe` — the host then reports
 *    `succeeded` as completed and `failed` / `interrupted` as failed, in the
 *    platform's own word;
 *  - the typed `session.status` EVENT supplies the activity state. The relay
 *    feeds it to {@link OpencodeGraphHost.noteSessionStatus}, so `busy` / `retry`
 *    answer running and `idle` answers unknown — an idle session is never a
 *    completion, because a finished turn is not a settled attempt.
 *
 * WHAT REMAINS UNKNOWN IS NAMED, NOT GUESSED: a session that went idle without a
 * terminal outcome (or with no read installed) answers `unknown` with the read
 * that is missing, a cancel is answered `requested` or `unsupported` and never
 * `confirmed`, and the session's `time.idle` timestamp is not read for any state
 * decision — the typed event and the outcome enum are the platform's own words.
 *
 * THE STORE ROOT IS THE HOST'S OWN (src/graph/store/schema.ts:58-60):
 * `graphStoreRoot(getDataDir(), directory)` under the rolebox data directory,
 * deliberately OUTSIDE the workspace, because a dispatched worker runs with the
 * workspace as its root (the same choice the dsh and Pi entries make).
 */

import { getDataDir } from "../../../cli/paths.ts";
import { graphStoreRoot } from "../../../graph/store/schema.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import {
  OpencodeGraphHost,
  opencodeGraphSessionPort,
  type OpencodeGraphHostOptions,
  type OpencodeGraphSessionReading,
} from "../opencode/graph-host.ts";

/**
 * Open the v2 host capability layer for one plugin context.
 *
 * The optional fields are forwarded ONLY when the caller supplied them, so an
 * entry that passes nothing gets exactly the platform's own defaults
 * (`process.env` for the capability set, no agent resolver, and no synthesized
 * wait).
 */
export function openOpencode2GraphHost(options: {
  directory: string;
  /** The entry's `Opencode2SessionAdapter`. */
  client: ISessionClient;
  /**
   * The declaring session's wake-up channel. Omitted, the host factory uses
   * {@link client} — the adapter the entry already built, never a second one.
   */
  notifyClient?: Pick<ISessionClient, "prompt">;
  /** `ctx.session.wait`, passed through; absent when the host exposes none. */
  wait?: (input: { sessionID: string }) => Promise<void>;
  /**
   * THE SESSION'S OWN TERMINAL OUTCOME, built by the entry over the RAW
   * `ctx.session.get` — v2's plugin domain is the only place that value is
   * readable, because the canonical `SessionInfo` this factory's `client`
   * projects it onto drops it (src/platform/adapters/opencode2/session.ts:468-477).
   * Absent, the host reads the adapter's canonical status instead, which names
   * no outcome, and says so in its platformNotes.
   */
  observe?: (input: { sessionID: string }) => Promise<OpencodeGraphSessionReading | null>;
  env?: Readonly<Record<string, string | undefined>>;
  getEffectiveAgent?: (sessionID?: string) => string;
}): OpencodeGraphHost {
  const hostOptions: OpencodeGraphHostOptions = {
    workspaceDir: options.directory,
    storeRoot: graphStoreRoot(getDataDir(), options.directory),
    // NO CUSTOM INTERRUPT: `ISessionClient.abort` is the platform's own
    // interrupt on this adapter, so the shared port installs it. `observe` is
    // installed ONLY when the entry supplied one — a v2 entry with no raw-domain
    // read keeps the adapter's own (state-only, always-null) status.
    session: opencodeGraphSessionPort(options.client, {
      ...(options.wait === undefined ? {} : { wait: options.wait }),
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    }),
    // THE DECLARING SESSION'S WAKE-UP CHANNEL (fact 4): one `ISessionClient` per
    // plugin context, never a second one. An entry that names the channel at this
    // seam is honoured; otherwise the client the host already dispatches over IS
    // the channel, so a host is never opened without one by omission.
    notifyClient: options.notifyClient ?? options.client,
    sessionEndFeed: true,
    // THE TERMINAL-OUTCOME READ IS THE ENTRY'S `observe` (fact 5): with it the
    // host's notes say an outcome read is installed, and the end path asks for
    // it before settling; without it the notes say it is not.
    ...(options.observe === undefined ? {} : { sessionOutcomeRead: true }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.getEffectiveAgent === undefined
      ? {}
      : { getEffectiveAgent: options.getEffectiveAgent }),
  };
  return OpencodeGraphHost.open(hostOptions);
}
