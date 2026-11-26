/** Gebruikersinstellingen (lokaal opgeslagen). De API key zit apart in storage.ts. */
import { DEFAULT_DETECTOR_URL, DEFAULT_MODELS, DEFAULT_USD_TO_EUR } from "./config";
import { loadJSON, saveJSON } from "./storage";

export const CATEGORIES = [
  { id: "taal", label: "Taal", color: "#d13438" },
  { id: "stijl", label: "Stijl", color: "#0078d4" },
  { id: "claim", label: "Claimsterkte", color: "#8764b8" },
  { id: "helderheid", label: "Helderheid", color: "#c239b3" },
  { id: "consistentie", label: "Consistentie", color: "#038387" },
  { id: "technisch", label: "Technisch", color: "#986f0b" },
  { id: "notatie", label: "Notatie", color: "#498205" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const FEATURES = [
  { id: "live", label: "Live controle (kronkels)" },
  { id: "technical", label: "Technische controle (Sonnet, bij verlaten alinea)" },
  { id: "paraphrase", label: "Parafraseren bij selectie" },
  { id: "notation", label: "Notatie (lokaal)" },
] as const;
export type FeatureId = (typeof FEATURES)[number]["id"];

export interface Settings {
  liveModel: string;
  heavyModel: string;
  usdToEur: number;
  trackChanges: boolean;
  detectorUrl: string;
  /** AI-check: lokale detector of eigen cloud-detector (Modal). */
  detectorMode: "local" | "cloud";
  /** Adres van de eigen Modal-endpoint (https://….modal.run). Het token staat apart in storage.ts. */
  cloudDetectorUrl: string;
  /** AI-check: zinnen in het document markeren (standaard uit). */
  aiMarkSentences: boolean;
  categories: Record<CategoryId, boolean>;
  features: Record<FeatureId, boolean>;
}

export function defaultSettings(): Settings {
  return {
    liveModel: DEFAULT_MODELS.live,
    heavyModel: DEFAULT_MODELS.heavy,
    usdToEur: DEFAULT_USD_TO_EUR,
    trackChanges: false,
    detectorUrl: DEFAULT_DETECTOR_URL,
    detectorMode: "local",
    cloudDetectorUrl: "",
    aiMarkSentences: false,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, true])) as Record<CategoryId, boolean>,
    // Parafraseren staat standaard uit, zodat niet elke selectie tegoed kost.
    features: Object.fromEntries(FEATURES.map((f) => [f.id, f.id !== "paraphrase"])) as Record<FeatureId, boolean>,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  const s = loadJSON<Partial<Settings>>("settings", {});
  // Samenvoegen zodat nieuwe velden uit latere versies een standaardwaarde krijgen.
  return {
    ...d,
    ...s,
    categories: { ...d.categories, ...(s.categories || {}) },
    features: { ...d.features, ...(s.features || {}) },
  };
}

export function saveSettings(s: Settings): void {
  saveJSON("settings", s);
}
