/** Browser-local mode shared by every mounted suggestion control. */
export const COPILOT_MODE_STORAGE_KEY = "rolebox.copilot.mode";
/** Read only when no mode has been chosen in this browser. */
export const AUTO_SUGGEST_STORAGE_KEY = "rolebox.copilot.autoSuggest";

export const COPILOT_MODES = ["none", "manual", "auto-advise", "auto-mated"] as const;
export type CopilotMode = typeof COPILOT_MODES[number];

let fallbackMode: CopilotMode = "auto-advise";
let storageWriteFailed = false;
const listeners = new Set<(mode: CopilotMode) => void>();

export function isCopilotMode(value: unknown): value is CopilotMode {
  return COPILOT_MODES.some((mode) => mode === value);
}

export function isAutomaticMode(mode: CopilotMode): boolean {
  return mode === "auto-advise" || mode === "auto-mated";
}

export function getCopilotMode(): CopilotMode {
  if (storageWriteFailed) return fallbackMode;
  try {
    const stored = localStorage.getItem(COPILOT_MODE_STORAGE_KEY);
    fallbackMode = stored === null
      ? localStorage.getItem(AUTO_SUGGEST_STORAGE_KEY) === "false" ? "manual" : "auto-advise"
      : isCopilotMode(stored) ? stored : "auto-advise";
    return fallbackMode;
  } catch {
    return fallbackMode;
  }
}

export function setCopilotMode(mode: CopilotMode): void {
  fallbackMode = mode;
  try {
    localStorage.setItem(COPILOT_MODE_STORAGE_KEY, mode);
    storageWriteFailed = false;
  } catch {
    storageWriteFailed = true;
    // Storage can be blocked; the preference still works for this page.
  }
  for (const listener of listeners) listener(mode);
}

export function subscribeCopilotMode(listener: (mode: CopilotMode) => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === COPILOT_MODE_STORAGE_KEY || event.key === AUTO_SUGGEST_STORAGE_KEY || event.key === null) {
      listener(getCopilotMode());
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listener(getCopilotMode());
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
