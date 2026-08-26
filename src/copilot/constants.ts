/**
 * Marker prefix for copilot-injected prompts.
 *
 * Copilot-injected prompts re-enter the plugin through `chat.message` as
 * user-role messages. `isSyntheticInjection` (src/hooks/chat-message.ts:26-29
 * and its mirror at src/platform/adapters/pi/chat-activation.ts:86-92) matches
 * on this prefix so such re-entries are classified as synthetic:
 *
 *   - they must NOT reset `continuationCount` / `cooldownUntilTurn` — resetting
 *     would defeat the builtin continuation caps and enable infinite loops;
 *   - they must NOT enter `userMessagedSessions`;
 *   - they must NOT cancel active loops.
 *
 * Bracket-prefix style (leading `[`, no closing bracket) consistent with the
 * existing `"[auto-continue"` marker convention. Injected messages start with
 * something like `[copilot-auto: <source>]`.
 */
export const COPILOT_MARKER = "[copilot-auto:";
