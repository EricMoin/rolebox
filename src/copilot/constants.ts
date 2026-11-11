/**
 * Marker prefix for historically copilot-injected prompts.
 *
 * The turn-end copilot rule/LLM injection path was removed, but a persisted
 * session may still contain messages it produced. The `isSyntheticInjection`
 * checks in src/hooks/chat-message.ts and its mirror at
 * src/platform/adapters/pi/hooks/chat-activation.ts match on this prefix so such
 * historical re-entries are classified as synthetic:
 *
 *   - they must NOT reset `continuationCount` / `cooldownUntilTurn` — resetting
 *     would defeat the builtin continuation caps and enable infinite loops;
 *   - they must NOT enter `userMessagedSessions`;
 *   - they must NOT cancel active loops.
 *
 * Bracket-prefix style (leading `[`, no closing bracket) consistent with the
 * existing `"[auto-continue"` marker convention.
 */
export const COPILOT_MARKER = "[copilot-auto:";
