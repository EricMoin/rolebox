/**
 * @deprecated Use OpencodeSessionAdapter from platform/adapters/opencode-session.ts
 * or ISessionClient from platform/ports/session-client.ts directly.
 *
 * SessionClientWrapper is now a backward-compatible alias for OpencodeSessionAdapter.
 */
import { OpencodeSessionAdapter } from "../platform/adapters/opencode-session.ts";

export { OpencodeSessionAdapter as SessionClientWrapper };
