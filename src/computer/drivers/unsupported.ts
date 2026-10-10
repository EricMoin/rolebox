/**
 * The computer-use facts of a system rolebox declares no driver for.
 *
 * A system that cannot be driven answers one sentence naming itself and what to
 * run instead — there is no "best effort" branch here, because a plan invented
 * for an unknown platform could only fail at the spawn with a message the
 * caller cannot act on.
 */

import type { UnsupportedComputerUse } from "../../platform/system/types.ts";

/** One refusal for a system id and its human-readable label. */
export function unsupportedComputerUse(id: string, label: string): UnsupportedComputerUse {
  return {
    supported: false,
    refusal: `rolebox declares no computer-use driver for ${label} (platform "${id}"); run computer_* tools on macOS, an X11 Linux session, or Windows.`,
  };
}
