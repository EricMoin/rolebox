/**
 * opencode v2 session adapter — implements ISessionClient on top of the
 * `@opencode/plugin` v2 promise session domain (`ctx.session`).
 *
 * opencode v2 is a separate product from the 1.x line the v1 adapter
 * (../opencode/session.ts) targets, and two differences shape this file:
 *
 *  1. The plugin session domain is a REDUCED projection of the HTTP client:
 *       type SessionDomain = Pick<SessionApi, "create" | "get" | "switchAgent"
 *         | "switchModel" | "prompt" | "generate" | "command" | "synthetic"
 *         | "interrupt" | "update" | "move" | "wait" | "context"> & { hook }
 *     (node_modules/@opencode/plugin/dist/promise/session.d.ts:143-145).
 *     list/children/todo/diff/fork/status/compact are NOT reachable from a v2
 *     plugin, so each of them degrades here — documented, and never throwing.
 *
 *  2. The transport is a plain promise client: it THROWS instead of returning
 *     the v1 result tuple. The ISessionClient error contract is kept anyway —
 *     read paths never throw, create() re-throws transient transport failures
 *     and raises SessionCreateRejectedError on a server-side rejection.
 *
 * Every non-obvious host shape is cited inline against the installed
 * @opencode/* 2.0.18 declarations under node_modules/.
 */

import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { Opencode2AgentModelRef } from "./agents.ts";
import { SessionCreateRejectedError } from "../../types.ts";
import type {
  FileDiff,
  Message,
  SessionInfo,
  SessionStatus,
  Todo,
} from "../../types.ts";
import type { MessageInfo, Part } from "../../../session/types.ts";

// ── Host surface (structural view of ctx.session) ───────────────────────────

/**
 * `Session.Info` as the v2 promise client returns it, projected onto the
 * fields this adapter reads
 * (node_modules/@opencode/client/dist/promise/generated/types.d.ts:2788-2814).
 */
export interface Opencode2SessionInfo {
  readonly id: string;
  readonly projectID: string;
  readonly parentID?: string;
  readonly title?: string;
  /**
   * The session's acting agent (`SessionInfo.agent`,
   * …/generated/types.d.ts:2788-2814). The entry reads it through
   * `ctx.session.get` to resolve who is prompting, since v2's `SessionPrompt`
   * carries no agent (src/entries/opencode2.ts:3c). Not projected onto
   * {@link SessionInfo}: it is the session's current agent, not a session
   * field, and `switchAgent` can change it between turns.
   */
  readonly agent?: string;
  readonly time: { readonly created: number; readonly updated: number };
  /** `Location.PublicRef` — `{ directory }` (…/generated/types.d.ts:27-29). */
  readonly location: { readonly directory: string };
}

/**
 * One `SessionMessage.Info` entry — the union at
 * …/promise/generated/types.d.ts:3256 (user | assistant | synthetic | system |
 * skill | shell | agent-switched | model-switched | location-switched |
 * compaction | idle), projected onto the fields this adapter maps.
 */
export interface Opencode2HostMessage {
  readonly id: string;
  /** v2 discriminator; preserved verbatim as the canonical message role. */
  readonly type: string;
  readonly time: { readonly created: number; readonly completed?: number };
  readonly agent?: string;
  readonly model?: { readonly id: string; readonly providerID: string };
  /** Present on user/synthetic/system/skill messages. */
  readonly text?: string;
  /** Present on assistant messages. */
  readonly content?: readonly Opencode2HostContent[];
}

/**
 * One assistant content block (`SessionMessageAssistantText` |
 * `…Reasoning` | `…Tool`, …/generated/types.d.ts:3195 with the tool states at
 * SessionMessageToolState*).
 */
export interface Opencode2HostContent {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly state?: {
    readonly status?: string;
    readonly input?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly content?: readonly {
      readonly type: string;
      readonly text?: string;
      readonly uri?: string;
    }[];
    readonly error?: unknown;
  };
}

/** `SessionInbox.User` — what `session.prompt()` resolves to (…/generated/types.d.ts:3110-3118). */
export interface Opencode2InboxUser {
  readonly id: string;
  readonly time?: { readonly created: number };
}

/** `SessionPromptInput` (…/effect/api/api.d.ts:307-319) — projected to what we set. */
export interface Opencode2PromptInput {
  readonly sessionID: string;
  readonly text: string;
  /** v2 knob for "deliver without resuming the agent loop" (see prompt()). */
  readonly resume?: boolean;
}

/**
 * `SessionCreateInput` (…/effect/api/api.d.ts:231-239) — projected.
 *
 * `model` is `SessionCreateInput.model`
 * (node_modules/@opencode/client/dist/promise/generated/types.d.ts:3705-3740):
 * the model the created session runs. It is not decoration — a v2 session does
 * NOT inherit the model of the agent it is created for, so this field is the
 * only way rolebox can select a role's model for a new session (see `create()`).
 */
export interface Opencode2CreateInput {
  readonly agent?: string;
  readonly model?: {
    readonly id: string;
    readonly providerID: string;
    readonly variant?: string;
  };
  readonly location?: { readonly directory: string };
}

/** The `RequestOptions` subset v2 accepts as each call's second argument. */
export interface Opencode2RequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * The smallest v2 host surface this adapter needs: the reduced plugin session
 * domain. Declared with METHOD syntax on purpose — `ctx.session`'s branded IDs
 * (`Session.ID = string & Brand<"SessionID">`,
 * node_modules/@opencode/schema/dist/session.d.ts:8-12) are assignable to the
 * plain `string` IDs used here, and method declarations keep TypeScript's
 * parameter check bivariant, so the real domain satisfies this interface
 * without a cast.
 */
export interface Opencode2SessionApi {
  get(
    input: { readonly sessionID: string },
    options?: Opencode2RequestOptions,
  ): Promise<Opencode2SessionInfo>;

  create(
    input?: Opencode2CreateInput,
    options?: Opencode2RequestOptions,
  ): Promise<Opencode2SessionInfo>;

  prompt(
    input: Opencode2PromptInput,
    options?: Opencode2RequestOptions,
  ): Promise<Opencode2InboxUser>;

  switchAgent(
    input: { readonly sessionID: string; readonly agent: string },
    options?: Opencode2RequestOptions,
  ): Promise<void>;

  switchModel(
    input: {
      readonly sessionID: string;
      readonly model: { readonly id: string; readonly providerID: string };
    },
    options?: Opencode2RequestOptions,
  ): Promise<void>;

  wait(
    input: { readonly sessionID: string },
    options?: Opencode2RequestOptions,
  ): Promise<void>;

  interrupt(
    input: { readonly sessionID: string },
    options?: Opencode2RequestOptions,
  ): Promise<{ readonly interrupted: boolean }>;

  context(
    input: { readonly sessionID: string },
    options?: Opencode2RequestOptions,
  ): Promise<readonly Opencode2HostMessage[]>;
}

/**
 * Compile-time guard (erased at runtime): the REAL v2 plugin session domain
 * must satisfy the structural view above — it is exactly what the entry hands
 * to the constructor. If @opencode/plugin drifts from this view the constraint
 * below fails and `tsc --noEmit` goes red here instead of at the call site.
 */
type _IsTrue<T extends true> = T;
type _Opencode2SessionDomainSatisfiesView = _IsTrue<
  Opencode2Plugin.Context["session"] extends Opencode2SessionApi ? true : false
>;

// ── Mapping ────────────────────────────────────────────────────────────────

/**
 * `Session.Info` carries no version field in v2 (…/generated/types.d.ts:2788),
 * so the canonical SessionInfo.version is a platform marker. Its only consumer
 * is the display-only "**Version:**" line of session_inspect
 * (src/session/session-inspect-tools.ts:95).
 */
const OPENCODE2_SESSION_VERSION = "2";

function toSessionInfo(info: Opencode2SessionInfo): SessionInfo {
  return {
    id: info.id,
    projectID: info.projectID,
    directory: info.location.directory,
    ...(info.parentID !== undefined ? { parentID: info.parentID } : {}),
    title: info.title ?? "",
    version: OPENCODE2_SESSION_VERSION,
    time: { created: info.time.created, updated: info.time.updated },
  };
}

function partID(messageID: string, index: number): string {
  return messageID + ":part:" + String(index);
}

function asInputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      const serialized = JSON.stringify(error);
      if (serialized !== undefined && serialized !== "{}") return serialized;
    } catch {
      /* non-serializable — fall through to the generic label */
    }
  }
  return "tool error";
}

/** Tool text from a v2 tool state's content blocks (ToolTextContent|ToolFileContent). */
function toolOutputText(
  content: readonly { readonly type: string; readonly text?: string; readonly uri?: string }[] | undefined,
): string {
  if (content === undefined) return "";
  return content
    .map((block) => (typeof block.text === "string" ? block.text : (block.uri ?? "")))
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * Map one v2 assistant tool block onto the canonical ToolPart
 * (src/session/types.ts) the shared formatters switch on. v2's tool states are
 * streaming/running/completed/error; the canonical set is
 * pending/running/completed/error, so "streaming" (whose `input` is still a
 * partial JSON string) becomes "pending" with an empty input.
 */
function toToolPart(
  sessionID: string,
  messageID: string,
  index: number,
  content: Opencode2HostContent,
): Part {
  const id = partID(messageID, index);
  const startedAt = content.time?.created ?? 0;
  const endedAt = content.time?.completed ?? startedAt;
  const state = content.state;
  const callID = content.id ?? id;
  const tool = content.name ?? "";
  switch (state?.status) {
    case "running":
      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state: { status: "running", input: asInputRecord(state.input) },
      };
    case "completed": {
      const title = state.metadata?.title;
      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state: {
          status: "completed",
          input: asInputRecord(state.input),
          output: toolOutputText(state.content),
          title: typeof title === "string" ? title : "",
          metadata: asInputRecord(state.metadata),
          time: { start: startedAt, end: endedAt },
        },
      };
    }
    case "error":
      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state: { status: "error", error: errorText(state.error), time: { start: startedAt, end: endedAt } },
      };
    default:
      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state: { status: "pending", input: {} },
      };
  }
}

function toCanonicalPart(
  sessionID: string,
  messageID: string,
  index: number,
  content: Opencode2HostContent,
): Part {
  const id = partID(messageID, index);
  if (content.type === "tool") return toToolPart(sessionID, messageID, index, content);
  if (content.type === "text" && typeof content.text === "string") {
    return { id, sessionID, messageID, type: "text", text: content.text };
  }
  // Every other v2 content kind (reasoning included) is preserved verbatim
  // through the canonical catch-all Part member — nothing is dropped.
  return {
    id,
    sessionID,
    messageID,
    type: content.type,
    ...(typeof content.text === "string" ? { text: content.text } : {}),
  };
}

/**
 * Map one v2 message onto the canonical `Message`. v2 messages are returned
 * per session and carry no sessionID of their own, so the requested id is
 * stamped onto the canonical info and parts.
 */
function toCanonicalMessage(sessionID: string, message: Opencode2HostMessage): Message {
  const info: MessageInfo = {
    id: message.id,
    sessionID,
    // The v2 discriminator is kept as the canonical role: "user"/"assistant"
    // are the harness roles, and adapter-specific kinds ("synthetic",
    // "shell", "compaction", …) must never be relabelled as one of them.
    role: message.type,
    time: {
      created: message.time.created,
      ...(message.time.completed !== undefined ? { completed: message.time.completed } : {}),
    },
    ...(message.agent !== undefined ? { agent: message.agent } : {}),
    ...(message.model !== undefined
      ? { model: { providerID: message.model.providerID, modelID: message.model.id } }
      : {}),
  };
  const parts: Part[] = [];
  if (typeof message.text === "string" && message.text !== "") {
    parts.push({ id: message.id + ":text", sessionID, messageID: message.id, type: "text", text: message.text });
  }
  for (const [index, content] of (message.content ?? []).entries()) {
    parts.push(toCanonicalPart(sessionID, message.id, index, content));
  }
  return { info, parts };
}

/** The v2 prompt input takes a single text body: join the canonical parts. */
function joinPromptParts(parts: ReadonlyArray<{ type: string; text: string }>): string {
  return parts.map((part) => part.text).join("\n\n");
}

/**
 * The assistant message that answers a prompt: the last assistant message
 * created at or after the inbox entry's `time.created`. Falls back to the last
 * assistant message in the context when the host clock disagrees with ours.
 */
function findAssistantReply(
  messages: readonly Opencode2HostMessage[],
  promptedAt: number | undefined,
): Opencode2HostMessage | undefined {
  const assistants = messages.filter((message) => message.type === "assistant");
  if (promptedAt === undefined) return assistants.at(-1);
  // Backwards scan instead of Array.findLast: the project targets ES2022.
  for (let index = assistants.length - 1; index >= 0; index -= 1) {
    const assistant = assistants[index];
    if (assistant !== undefined && assistant.time.created >= promptedAt) return assistant;
  }
  return assistants.at(-1);
}

/**
 * Classify a THROWN `session.create` failure from the v2 promise client.
 *
 *  - `ClientError` (…/promise/generated/client-error.d.ts:1-6) is what the client
 *    throws for a failed request. Its `reason` discriminates the cause
 *    (…/dist/chunks/contract-n8g24fq8.js:42-56):
 *      "Transport"  → the fetch itself failed → TRANSIENT (undefined here).
 *      "UnexpectedStatus" → HTTP status outside the endpoint's declared set →
 *      a real server-side rejection.
 *  - An HTTP error status the endpoint DOES declare is thrown by the client's
 *    `declared()` helper (…/contract-n8g24fq8.js:1409-1414) as a plain Error
 *    carrying the decoded protocol body: `name` is the body's `_tag` (e.g.
 *    "InvalidRequestError", node_modules/@opencode/protocol/dist/errors.d.ts).
 *
 * Anything else stays transient, matching the v1 contract's
 * "any other thrown Error → retried" rule: an unrecognized failure is never
 * reported as a non-retryable rejection.
 */
function classifyCreateFailure(error: unknown): { reason: string; code?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  const reason = (error as { reason?: unknown }).reason;
  if (typeof reason === "string") {
    if (reason === "Transport") return undefined;
    const status = (error as { cause?: { status?: unknown } }).cause?.status;
    const text = typeof detail === "string" && detail !== "" ? detail : error.message;
    return {
      reason: typeof status === "number" ? text + " (HTTP " + String(status) + ")" : text,
      code: reason,
    };
  }
  const tag = (error as { _tag?: unknown })._tag;
  if (typeof tag === "string") {
    return { reason: error.message, code: tag };
  }
  return undefined;
}

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * Optional adapter wiring.
 *
 * `agentModels` is the model each agent runs, as
 * `collectOpencode2AgentModels` derives it from the role registrations
 * (src/platform/adapters/opencode2/agents.ts). It exists because opencode v2
 * does NOT inherit an agent's model into a session it creates: `create()` has
 * to name the model itself, and this map is where the model comes from.
 * Omitted, the adapter behaves exactly as it did before — every created session
 * keeps the host's default model.
 */
export interface Opencode2SessionAdapterOptions {
  readonly agentModels?: ReadonlyMap<string, Opencode2AgentModelRef>;
}

/**
 * ISessionClient adapter for the opencode v2 plugin session domain.
 *
 * Every read path returns the empty value on failure (never throws); only
 * `create()` propagates, and it distinguishes a server-side rejection
 * (`SessionCreateRejectedError`) from a transient transport failure (re-thrown
 * verbatim) exactly like the v1 adapter does.
 */
export class Opencode2SessionAdapter implements ISessionClient {
  readonly #session: Opencode2SessionApi;
  /** Empty when the caller passed none — then no created session gets a model. */
  readonly #agentModels: ReadonlyMap<string, Opencode2AgentModelRef>;

  constructor(session: Opencode2SessionApi, options?: Opencode2SessionAdapterOptions) {
    this.#session = session;
    this.#agentModels = options?.agentModels ?? new Map();
  }

  /**
   * DEGRADATION — v2's plugin session domain omits `list` (SessionDomain is a
   * Pick, …/promise/session.d.ts:143-145); the HTTP client's list is not part
   * of the plugin surface. Always [].
   */
  async list(_directory?: string): Promise<SessionInfo[]> {
    return [];
  }

  async get(id: string, _directory?: string): Promise<SessionInfo | null> {
    try {
      // v2 sessions are addressed globally by ID; the port's directory hint
      // has no counterpart on SessionGetInput (…/effect/api/api.d.ts:264-266).
      const info = await this.#session.get({ sessionID: id });
      return toSessionInfo(info);
    } catch {
      return null;
    }
  }

  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    try {
      // v2 exposes the conversation as `session.context({ sessionID })` — the
      // session's full message log (SessionContextInput/Output,
      // …/effect/api/api.d.ts:389-392).
      const messages = await this.#session.context({ sessionID: id });
      const mapped = messages.map((message) => toCanonicalMessage(id, message));
      // `context()` takes no limit, so the port's limit is applied client-side
      // as a TAIL window — the same window the existing caller enforces
      // defensively (src/copilot/transcript.ts:60 does msgs.slice(-windowSize)).
      if (options?.limit === undefined || options.limit <= 0) return mapped;
      return mapped.slice(-options.limit);
    } catch {
      return [];
    }
  }

  /**
   * DEGRADATION — v2's plugin session domain omits any child-session listing;
   * Session.Info exposes `parentID` but nothing enumerates children. Always [].
   */
  async children(_id: string, _directory?: string): Promise<SessionInfo[]> {
    return [];
  }

  /**
   * DEGRADATION — v2 keeps todos outside the plugin session surface (no `todo`
   * on SessionDomain). Always [].
   */
  async todo(_id: string, _directory?: string): Promise<Todo[]> {
    return [];
  }

  /**
   * DEGRADATION — v2's diff lives on the HTTP client (`session.diff`) but not
   * on the plugin session domain. Always [].
   */
  async diff(
    _id: string,
    _options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    return [];
  }

  /**
   * DEGRADATION — v2's fork lives on the HTTP client (`session.fork`) but not
   * on the plugin session domain, and `session.create` has no parentID input
   * (…/effect/api/api.d.ts:231-239), so a plugin cannot fork at all. Always null.
   */
  async fork(
    _id: string,
    _options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    return null;
  }

  /**
   * DEGRADATION — v2's plugin session domain exposes neither the status map
   * (`session.active`) nor a per-session status read. Always null.
   */
  async status(_id: string, _directory?: string): Promise<SessionStatus | null> {
    return null;
  }

  /**
   * Select the agent the session runs, unless it already runs it.
   *
   * v2 has no per-prompt agent field (SessionPromptInput,
   * …/effect/api/api.d.ts:307-319): the agent is a property of the SESSION, set
   * with `switchAgent` (…/effect/api/api.d.ts:280-289). Switching a session
   * that ALREADY runs the requested agent is not free — the host appends an
   * `agent-switched` message whose `previous` equals the new agent (verified
   * against a running 2.0.18 host) — so the current agent is read first and the
   * redundant switch is skipped. Shared by `prompt()` and `promptSync()`; the
   * two differ only in whether they carry a request signal.
   *
   * THE READ IS CONTAINED: a host whose `get` is missing or rejects the call,
   * and a session the host answers without an agent, all fall back to the
   * unconditional `switchAgent` performed before this check existed. The check
   * can therefore only ever REMOVE a redundant call — never turn a working
   * dispatch into a failure.
   */
  async #selectAgent(
    id: string,
    agent: string,
    request?: Opencode2RequestOptions,
  ): Promise<void> {
    let current: string | undefined;
    try {
      current = (await this.#session.get({ sessionID: id }, request)).agent;
    } catch {
      // Unknown is not "already selected": fall through to the switch below.
      current = undefined;
    }
    if (current === agent) return;
    await this.#session.switchAgent({ sessionID: id, agent }, request);
  }

  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      fromLoop?: boolean;
    },
  ): Promise<{ id: string } | null> {
    try {
      // v2 selects the agent ON THE SESSION, not per message: the prompt input
      // carries no agent field (SessionPromptInput,
      // …/effect/api/api.d.ts:307-319) — `switchAgent` is the v2 API for it
      // (…/effect/api/api.d.ts:280-289), and it is part of the reduced plugin
      // domain (…/promise/session.d.ts:143-145).
      if (options.agent !== undefined && options.agent !== "") {
        await this.#selectAgent(id, options.agent);
      }
      // `options.model` is deliberately NOT applied. This path also prompts the
      // USER's own session — graph notifications and copilot continuations run
      // through this same adapter — whose model and variant rolebox must never
      // overwrite. On v2 a session's model is selected where the session is
      // CREATED (create(), over the adapter's `agentModels` map).
      const inbox = await this.#session.prompt({
        sessionID: id,
        text: joinPromptParts(options.parts),
        // v2's "deliver without resuming the agent loop" knob is `resume`
        // (SessionPromptInput.resume, …/effect/api/api.d.ts:318; the same
        // field means "continue running afterwards" on interrupt/skill/
        // synthetic — …/effect/api/api.d.ts:1572-1575 (interrupt), :333-336
        // (skill) and :340-350 (synthetic)). v1's noReply maps onto it.
        ...(options.noReply !== undefined ? { resume: !options.noReply } : {}),
      });
      // `options.system` has no v2 prompt counterpart (system parts belong to
      // the plugin's session hooks) and `fromLoop` is a v1-coordinator flag —
      // both are intentionally not forwarded.
      // A resolved prompt WAS accepted: mirror the v1 sentinel so a missing
      // inbox id never collapses a successful prompt to null (which the
      // dispatch launcher reads as a spawn failure).
      return { id: inbox.id !== "" ? inbox.id : id };
    } catch {
      return null;
    }
  }

  async promptSync(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    const request = options.signal !== undefined ? { signal: options.signal } : undefined;
    try {
      // v2 has no synchronous prompt: `prompt` only enqueues the message, and
      // `wait({ sessionID })` resolves once the session stops running
      // (…/promise/client.d.ts:53). The reply is read back
      // from the session context afterwards.
      if (options.agent !== undefined && options.agent !== "") {
        await this.#selectAgent(id, options.agent, request);
      }
      const inbox = await this.#session.prompt(
        { sessionID: id, text: joinPromptParts(options.parts) },
        request,
      );
      await this.#session.wait({ sessionID: id }, request);
      const messages = await this.#session.context({ sessionID: id }, request);
      const reply = findAssistantReply(messages, inbox.time?.created);
      if (reply === undefined) return null;
      return {
        parts: (reply.content ?? []).map((content) => ({
          type: content.type,
          // reasoning/tool blocks also carry `text`; blocks without text (a
          // v2 tool call) keep their type and stay text-less.
          ...(typeof content.text === "string" ? { text: content.text } : {}),
        })),
      };
    } catch {
      return null;
    }
  }

  async create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null> {
    try {
      // `parentID` has no v2 counterpart: SessionCreateInput carries
      // id/title/agent/model/location/metadata/permissions only
      // (…/effect/api/api.d.ts:231-239), so a v2 session cannot be created as a
      // child of another one. The requested directory travels as
      // `location.directory` (Location.PublicRef, …/generated/types.d.ts:27).
      const agent =
        options.agent !== undefined && options.agent !== "" ? options.agent : undefined;
      // A v2 session does NOT inherit the model of the agent it is created for
      // (the 1.x host resolves the agent's model itself), so a dispatch would
      // otherwise run on the host's DEFAULT model. The resolved role model —
      // the same value the agent registration carries — is named here instead,
      // variant included. An agent the map does not know, or whose role
      // resolves no model, keeps the host default: rolebox never invents one.
      const model = agent === undefined ? undefined : this.#agentModels.get(agent);
      const info = await this.#session.create({
        location: { directory: options.directory },
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined
          ? {
              model: {
                id: model.id,
                providerID: model.providerID,
                ...(model.variant !== undefined ? { variant: model.variant } : {}),
              },
            }
          : {}),
      });
      return toSessionInfo(info);
    } catch (err) {
      // Server-side rejection (a declared HTTP error body, or an undeclared
      // status) is REAL and non-transient: tag it so the dispatch launcher's
      // create-retry loop never retries it, and surface the reason verbatim.
      const rejection = classifyCreateFailure(err);
      if (rejection !== undefined) {
        throw new SessionCreateRejectedError(rejection.reason, rejection.code);
      }
      // Transport/network failure (or anything unrecognized): re-throw so the
      // caller keeps seeing a transient failure it can retry with backoff.
      throw err;
    }
  }

  async abort(id: string): Promise<boolean> {
    try {
      // v2 answers whether a run was actually interrupted
      // (SessionInterruptResponse, …/generated/types.d.ts:330-332); the port's
      // boolean is that acknowledgement, so the host's answer is propagated.
      const result = await this.#session.interrupt({ sessionID: id });
      return result.interrupted;
    } catch {
      return false;
    }
  }

  /**
   * DEGRADATION — v2's compact lives on the HTTP client (`session.compact`)
   * but not on the plugin session domain (SessionDomain's Pick omits it). false.
   */
  async compact(_id: string): Promise<boolean> {
    return false;
  }
}
