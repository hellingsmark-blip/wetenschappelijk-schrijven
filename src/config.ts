/**
 * Centrale configuratie: modellen, prijzen en standaardwaarden.
 * Prijzen staan in USD per miljoen tokens. Pas ze hier aan als Anthropic de prijzen wijzigt;
 * de gebruiker kan model-keuze, koers en budget ook in het tabblad Instellingen aanpassen.
 */

export interface ModelPrice {
  /** Normale input-tokens. */
  input: number;
  /** Output-tokens. */
  output: number;
  /** Schrijven naar de prompt-cache (5 minuten), standaard 1,25 × input. */
  cacheWrite: number;
  /** Lezen uit de prompt-cache. */
  cacheRead: number;
}

/** Prijstabel (USD / 1M tokens). Haiku-prijs geldt voor prompts tot 100K tokens. */
export const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** Welke modellen in de keuzelijsten van Instellingen staan. */
export const AVAILABLE_MODELS = Object.keys(PRICES);

/** Standaardmodellen per taaksoort. */
export const DEFAULT_MODELS = {
  /** Live controle (kronkels): goedkoop en snel. */
  live: "claude-haiku-5-5",
  /** Parafraseren, technische controle, sectie nakijken, tools. */
  heavy: "claude-sonnet-5-5",
};

export const DEFAULT_BUDGET_EUR = 15;
export const DEFAULT_USD_TO_EUR = 0.92;
export const BUDGET_WARN_FRACTION = 0.8;

export const DEFAULT_DETECTOR_URL = "https://localhost:8765";

/** Claude API. Alleen deze host wordt ooit aangeroepen (naast de lokale detector). */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2026-10-21";
