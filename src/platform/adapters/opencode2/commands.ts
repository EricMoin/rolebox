/**
 * opencode v2 command registration — the loop-stop command.
 *
 * v2 registers commands imperatively:
 *   `await ctx.command.transform(editor => editor.add({ name, description?, execute }))`
 * where the invocation is `{ sessionID, prompt, delivery }`
 * (node_modules/@opencode/plugin/dist/promise/command.d.ts:6-15). The v1 path
 * instead put a command TEMPLATE into the opencode config
 * (src/core/services/hook-service.ts:229-234):
 *
 *   commands[STOP_LOOP_COMMAND] = { template: STOP_LOOP_SIGNAL,
 *                                   description: "Stop the active loop" }
 *
 * so the host turned the template into a user message and rolebox's
 * `chat.message` hook saw `STOP_LOOP_SIGNAL`. v2's `execute` is the plugin's own
 * handler — the host sends nothing on its own — so the signal has to be
 * delivered here, and the call that reproduces the v1 behaviour is
 * `session.prompt`:
 *
 *  - `session.prompt({ sessionID, text })` enqueues a USER message in the
 *    session inbox (`SessionPromptOutput = SessionInbox.User`,
 *    …/client/dist/effect/api/api.d.ts:307-320) — exactly what the v1 command
 *    template produced, and the delivery the `prompt` session hook observes
 *    (`SessionPrompt = { sessionID, messageID, prompt, metadata, delivery }`,
 *    …/promise/session.d.ts:13-23).
 *  - `session.synthetic(...)` (…/api.d.ts:340-350) would inject the text as a
 *    synthetic message: `handleChatMessage` classifies synthetic injections
 *    separately (src/hooks/chat-message.ts:26-31) and the cancellation check
 *    runs only for a genuine user turn, so a synthetic delivery is the wrong
 *    class of message for a genuine user turn
 *    (`state.activeLoopManager.shouldCancelOnUserMessage`, src/hooks/chat-message.ts:66,
 *    which delegates to `shouldCancelLoop`, src/loop/cancellation.ts:41-46).
 *  - `session.command({ name, ... })` (…/api.d.ts:322-331) re-dispatches a
 *    registered command by name — it would re-enter this very command instead
 *    of delivering the signal.
 *
 * The invocation's `delivery` ("steer" | "queue", …/schema/dist/session-inbox.d.ts:3)
 * is forwarded unchanged, so the command keeps the delivery the user's
 * invocation asked for.
 */

import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import { STOP_LOOP_COMMAND, STOP_LOOP_SIGNAL } from "../../../loop/constants.ts";

/** `SessionInbox.Delivery` (…/schema/dist/session-inbox.d.ts:3). */
export type Opencode2CommandDelivery = "steer" | "queue";

/** `CommandInvocation` projected onto what the loop-stop command reads. */
export interface Opencode2CommandInvocation {
  readonly sessionID: string;
  /** `PromptInput.Prompt` (…/schema/dist/prompt-input.d.ts) — only `text` is read. */
  readonly prompt: { readonly text: string };
  readonly delivery: Opencode2CommandDelivery;
}

/** `CommandDefinition` (…/promise/command.d.ts:11-15). */
export interface Opencode2CommandDefinition {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: Opencode2CommandInvocation) => Promise<void>;
}

/** `CommandEditor` (…/promise/command.d.ts:16-18) — `add` is its only member. */
export interface Opencode2CommandEditor {
  add(definition: Opencode2CommandDefinition): void;
}

/** `CommandDomain` projected onto what registration uses. */
export interface Opencode2CommandDomain {
  transform(
    callback: (editor: Opencode2CommandEditor) => void,
  ): Promise<{ dispose: () => Promise<void> }>;
}

/** `SessionPromptInput` projected onto what the command delivers. */
export interface Opencode2CommandPromptInput {
  readonly sessionID: string;
  readonly text: string;
  readonly delivery?: Opencode2CommandDelivery;
}

/**
 * The v2 session call the command needs: `ctx.session.prompt`
 * (…/client/dist/effect/api/api.d.ts:307-319). Declared with method syntax so
 * the real, promise-backed `ctx.session` satisfies it without a cast.
 */
export interface Opencode2CommandSession {
  prompt(input: Opencode2CommandPromptInput): Promise<unknown>;
}

// ── Compile-time guards ────────────────────────────────────────────────────

type _IsTrue<T extends true> = T;

/** The host's `CommandDefinition`. */
type Opencode2HostCommandDefinition = Parameters<
  Parameters<Parameters<Opencode2Plugin.Context["command"]["transform"]>[0]>[0]["add"]
>[0];

/** This module's definition is accepted by the host's `add(definition)` as-is. */
type _CommandDefinitionSatisfiesHost = _IsTrue<
  Opencode2CommandDefinition extends Opencode2HostCommandDefinition ? true : false
>;

/** Every invocation field read here exists on the host's `CommandInvocation`. */
type _CommandInvocationFieldsExist = _IsTrue<
  keyof Opencode2CommandInvocation extends keyof Parameters<
    Opencode2HostCommandDefinition["execute"]
  >[0]
    ? true
    : false
>;

/** The real `ctx.command` can be handed to {@link registerOpencode2Commands} unchanged. */
type _CommandDomainSatisfiesView = _IsTrue<
  Opencode2Plugin.Context["command"] extends Opencode2CommandDomain ? true : false
>;

/** The real `ctx.session` can be handed to {@link createStopLoopCommand} unchanged. */
type _CommandSessionSatisfiesView = _IsTrue<
  Opencode2Plugin.Context["session"] extends Opencode2CommandSession ? true : false
>;

/** The prompt input delivered here is accepted by the host's `session.prompt`. */
type _PromptInputSatisfiesHost = _IsTrue<
  Opencode2CommandPromptInput extends Parameters<Opencode2Plugin.Context["session"]["prompt"]>[0]
    ? true
    : false
>;

// ── Command ────────────────────────────────────────────────────────────────

/** The description the v1 config hook registers (src/core/services/hook-service.ts:233). */
export const STOP_LOOP_COMMAND_DESCRIPTION = "Stop the active loop";

/**
 * The v2 loop-stop command: delivers `STOP_LOOP_SIGNAL` into the invoking
 * session as a user message, where rolebox's `chat.message` hook already
 * handles it (`shouldCancelOnUserMessage` → `cancelNow`,
 * src/loop/cancellation.ts:41-46).
 *
 * A delivery failure is NOT swallowed: the host is the only layer that can
 * report a command whose side effect did not happen.
 */
export function createStopLoopCommand(
  session: Opencode2CommandSession,
): Opencode2CommandDefinition {
  return {
    name: STOP_LOOP_COMMAND,
    description: STOP_LOOP_COMMAND_DESCRIPTION,
    async execute(input) {
      await session.prompt({
        sessionID: input.sessionID,
        text: STOP_LOOP_SIGNAL,
        delivery: input.delivery,
      });
    },
  };
}

/**
 * Register the loop-stop command inside a v2 command transform. The returned
 * registration is owned by the plugin scope and disposed with it
 * (…/promise/registration.d.ts:1-3).
 */
export async function registerOpencode2Commands(
  domain: Opencode2CommandDomain,
  session: Opencode2CommandSession,
): Promise<{ dispose: () => Promise<void> }> {
  return domain.transform((editor) => {
    editor.add(createStopLoopCommand(session));
  });
}
