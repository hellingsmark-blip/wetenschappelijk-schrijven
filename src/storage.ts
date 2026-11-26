/**
 * Veilige wrapper rond localStorage van de add-in (blijft op deze computer).
 * BELANGRIJK: de API key wordt alleen hier opgeslagen, nooit in
 * Office.context.document.settings (dat reist mee in het .docx-bestand).
 */

const PREFIX = "ws.";

/** Kleine abstractie zodat tests een nep-opslag kunnen injecteren. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** "lokaal" = blijvend in localStorage; "geheugen" = verdwijnt bij sluiten paneel. */
export let storageMode: "lokaal" | "geheugen" = "lokaal";

let store: KeyValueStore = (() => {
  try {
    const ls = globalThis.localStorage;
    const probe = PREFIX + "__probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    // Geen localStorage (bv. privévenster of tests): val terug op geheugen.
    storageMode = "geheugen";
    return memoryStore();
  }
})();

/** Alleen voor tests. */
export function useStore(s: KeyValueStore): void {
  store = s;
}
export function createMemoryStore(): KeyValueStore {
  return memoryStore();
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = store.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    store.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* opslag vol of geblokkeerd: negeren */
  }
}

export function removeKey(key: string): void {
  try {
    store.removeItem(PREFIX + key);
  } catch {
    /* negeren */
  }
}

// ---- API key ----
const API_KEY = "apiKey";
export const getApiKey = (): string => loadJSON<string>(API_KEY, "");
export const setApiKey = (k: string): void => saveJSON(API_KEY, k.trim());
export const clearApiKey = (): void => removeKey(API_KEY);

// Toegangstoken van de eigen cloud-detector (Modal): zelfde regels als de API key.
const DETECTOR_TOKEN = "detectorToken";
export const getDetectorToken = (): string => loadJSON<string>(DETECTOR_TOKEN, "");
export const setDetectorToken = (t: string): void => saveJSON(DETECTOR_TOKEN, t.trim());
export const clearDetectorToken = (): void => removeKey(DETECTOR_TOKEN);
