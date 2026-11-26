/**
 * Gedeelde typen voor de AI-check. Volgen het contract in docs/detector-api.md (versie 1).
 */

export type AiLabel = "human" | "uncertain" | "ai";
export type DetectorMode = "local" | "cloud";

export interface SignalScore {
  /** Score van dit signaal alleen (0–1, kans op AI). */
  score: number;
  /** Bijdrage aan de eindscore: positief = richting AI, negatief = richting mens. */
  contribution: number;
}

export interface ScoreRange {
  score: number;
  low: number;
  high: number;
  label: AiLabel;
}

export interface SentenceResult {
  text: string;
  score: number;
  signals: Record<string, SignalScore>;
}

export interface ParagraphResult extends Partial<ScoreRange> {
  id: string;
  sentences: SentenceResult[];
}

export interface ModelInfo {
  signal: string;
  name: string;
  version?: string;
}

/** Resultaat zoals het tabblad het toont (van de detector of van de lichte modus). */
export interface AnalysisResult {
  /** "local" / "cloud" = detector; "light" = lichte modus in de add-in. */
  mode: DetectorMode | "light";
  models: ModelInfo[];
  overall: ScoreRange;
  signalsOverall: Record<string, SignalScore>;
  paragraphs: ParagraphResult[];
  warnings: string[];
  costUsd: number | null;
  elapsedMs: number | null;
}

export interface HealthInfo {
  mode: DetectorMode;
  warm: boolean;
  models: ModelInfo[];
  signals: string[];
  maxChars: number | null;
  costPer1000Words: number | null;
  limitRemainingUsd: number | null;
}

export const LABEL_NL: Record<AiLabel, string> = {
  human: "waarschijnlijk menselijk",
  uncertain: "onzeker",
  ai: "waarschijnlijk AI",
};

export const SIGNAL_NL: Record<string, string> = {
  perplexity: "Perplexity",
  burstiness: "Burstiness",
  binoculars: "Binoculars",
  fast_detectgpt: "Fast-DetectGPT",
  classifier: "Classifier",
  stylometry: "Stilometrie",
  sentence_length: "Variatie zinslengte",
  ai_words: "Typische AI-woorden",
  triplets: "Drietallen",
  lexical_diversity: "Lexicale diversiteit",
  unicode: "Ongebruikelijke tekens",
};

/** Minder dan dit aantal woorden: lage betrouwbaarheid. */
export const SHORT_TEXT_WORDS = 150;
