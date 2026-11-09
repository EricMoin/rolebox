/** Browser-local preference shared by every mounted suggestion control. */
export const AUTO_SUGGEST_STORAGE_KEY = "rolebox.copilot.autoSuggest";

let fallbackEnabled = true;
const listeners = new Set<(enabled: boolean) => void>();

export function getAutoSuggestEnabled(): boolean {
  try {
    fallbackEnabled = localStorage.getItem(AUTO_SUGGEST_STORAGE_KEY) !== "false";
    return fallbackEnabled;
  } catch {
    return fallbackEnabled;
  }
}

export function setAutoSuggestEnabled(enabled: boolean): void {
  fallbackEnabled = enabled;
  try {
    localStorage.setItem(AUTO_SUGGEST_STORAGE_KEY, String(enabled));
  } catch {
    // Storage can be blocked; the preference still works for this page.
  }
  for (const listener of listeners) listener(enabled);
}

export function subscribeAutoSuggest(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === AUTO_SUGGEST_STORAGE_KEY || event.key === null) {
      listener(getAutoSuggestEnabled());
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listener(getAutoSuggestEnabled());
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
