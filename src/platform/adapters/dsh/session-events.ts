export interface DshEventSource {
  events?: readonly { type: string; data?: unknown }[];
  snapshotEvents?(): readonly { type: string; data?: unknown }[];
}

export function readDshSessionEvents(session: DshEventSource | undefined) {
  return session?.snapshotEvents?.() ?? session?.events ?? [];
}
