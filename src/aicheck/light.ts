/**
 * Lichte modus van de AI-check: alleen stilometrische signalen, volledig in de add-in (gratis, geen netwerk).
 * INDICATIEF, BEPERKTE BETROUWBAARHEID: deze signalen zijn zwak en wetenschappelijke mensentekst kan er ook op
 * scoren. Daarom brede marges en standaard eerder "onzeker" dan een harde uitspraak.
 *
 * Signalen:
 *  - variatie in zinslengte (mensen variëren meer; "burstiness");
 *  - typische AI-woorden en -constructies ("delve", "it is important to note", "plays a crucial role" …);
 *  - drietallen ("X, Y, and Z");
 *  - lexicale diversiteit (MTLD);
 *  - ongebruikelijke tekens (zero-width, homogliefen) en veel em-dashes.
 */
import type { AnalysisResult, AiLabel, ParagraphResult, SentenceResult, SignalScore } from "./types";
import { SHORT_TEXT_WORDS } from "./types";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number) => Math.round(x * 100) / 100;

// ---------- Zinnen en woorden ----------

const ABBREV_END = /\b(e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|vs|approx|ca|cf|resp|No|Ref|Refs|Sect|Tab|al)\.$/i;

/** Splitst een alinea in zinnen (zonder te knippen na "et al.", "e.g.", "Fig." …). */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+["”’)\]]*|$)\s*/g) || [];
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const prev = out[out.length - 1];
    // Plakken aan de vorige als die op een afkorting eindigt of de nieuwe niet met hoofdletter/cijfer begint.
    if (prev && (ABBREV_END.test(prev) || /^[a-z(\[,;]/.test(p) || /\d\.$/.test(prev) && /^\d/.test(p))) {
      out[out.length - 1] = prev + " " + p;
    } else out.push(p);
  }
  return out;
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+(?:['’-][a-z]+)*/g) || [];
}

/** MTLD (McCarthy & Jarvis, 2010), gemiddelde van voorwaarts en achterwaarts. Hoger = gevarieerder. */
export function mtld(tokens: string[], threshold = 0.72): number {
  const pass = (list: string[]) => {
    let factors = 0;
    let types = new Set<string>();
    let count = 0;
    for (const t of list) {
      types.add(t);
      count++;
      if (types.size / count <= threshold) {
        factors++;
        types = new Set();
        count = 0;
      }
    }
    if (count > 0) factors += (1 - types.size / count) / (1 - threshold);
    return factors > 0 ? list.length / factors : list.length;
  };
  if (tokens.length < 10) return 0;
  return (pass(tokens) + pass([...tokens].reverse())) / 2;
}

// ---------- Typische AI-woorden en -constructies ----------

const AI_PATTERNS: RegExp[] = [
  /\bdelv(e|es|ed|ing)\b/gi,
  /\bnotably\b/gi,
  /\bpivotal\b/gi,
  /\bunderscor(e|es|ed|ing)\b/gi,
  /\bintricate(ly)?\b/gi,
  /\bmultifaceted\b/gi,
  /\bholistic\b/gi,
  /\bleverag(e|es|ed|ing)\b/gi,
  /\bseamless(ly)?\b/gi,
  /\bfoster(s|ed|ing)?\b/gi,
  /\btapestry\b/gi,
  /\brealm\b/gi,
  /\b(ever-evolving|ever-changing)\b/gi,
  /\bshowcas(e|es|ed|ing)\b/gi,
  /\btestament\b/gi,
  /\bmeticulous(ly)?\b/gi,
  /\bparamount\b/gi,
  /\bcommendable\b/gi,
  /\bnavigat(e|es|ing) (the|this|these|complex)\b/gi,
  /\b(complex|evolving|dynamic) landscape\b/gi,
  /\bit is (important|worth|crucial|essential) to (note|noting|highlight|emphasi[sz]e)\b/gi,
  /\bit is worth noting\b/gi,
  /\bplays? an? (crucial|pivotal|vital|key|significant) role\b/gi,
  /\bin the realm of\b/gi,
  /\bshed(s|ding)? (new )?light on\b/gi,
  /\bpav(e|es|ed|ing) the way\b/gi,
  /\b(valuable|key|crucial) insights\b/gi,
  /\bnot only\b[^.]{3,80}\bbut also\b/gi,
  /(^|[.!?]\s+)Additionally,/g,
  /\bin today's\b/gi,
  /\boverall, (this|the|these)\b/gi,
  /\bthe interplay (between|of)\b/gi,
  /\bharness(es|ed|ing)? the (power|potential)\b/gi,
];

export function aiWordHits(text: string): number {
  let n = 0;
  for (const re of AI_PATTERNS) n += (text.match(re) || []).length;
  return n;
}

/** "nitrification, denitrification, and anammox" (opsomming van drie). */
export function tripletCount(text: string): number {
  return (text.match(/\b[\w-]+(?:\s[\w-]+){0,2}, [\w-]+(?:\s[\w-]+){0,2},? and [\w-]+/g) || []).length;
}

/** Zero-width tekens en homogliefen (Cyrillische/Griekse letters midden in Latijnse woorden). */
export function unicodeHits(text: string): number {
  const zw = (text.match(/[​-‍⁠﻿]/g) || []).length;
  const homo = (text.match(/[A-Za-z][Ͱ-ϿЀ-ӿ]|[Ͱ-ϿЀ-ӿ][A-Za-z]/g) || []).length;
  return zw + homo;
}

const emDashes = (text: string) => (text.match(/—/g) || []).length;

// ---------- Scores ----------

function sig(contribution: number): SignalScore {
  return { score: round(sigmoid(2 * contribution)), contribution: round(contribution) };
}

function label(score: number): AiLabel {
  return score < 0.35 ? "human" : score > 0.65 ? "ai" : "uncertain";
}

/** Score voor een stuk tekst (alinea of geheel). */
export function scoreText(text: string): { score: number; low: number; high: number; label: AiLabel; signals: Record<string, SignalScore> } {
  const sentences = splitSentences(text);
  const toks = words(text);
  const n = toks.length || 1;

  const lens = sentences.map((s) => words(s).length).filter((l) => l > 0);
  let cLen = 0;
  if (lens.length >= 5) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    cLen = clamp((0.45 - sd / mean) / 0.15, -1, 1); // weinig variatie → richting AI
  }
  const density = (aiWordHits(text) / n) * 100;
  const cWords = clamp((density - 0.3) / 0.7, -0.6, 1.5) * 1.4;
  const cTrip = sentences.length ? clamp((tripletCount(text) / sentences.length - 0.15) / 0.2, -1, 1) * 0.4 : 0;
  const cLex = n >= 100 ? clamp((60 - mtld(toks)) / 30, -1, 1) * 0.2 : 0;
  const cUni = (unicodeHits(text) > 0 ? 1.5 : 0) + clamp(((emDashes(text) / n) * 1000 - 2) / 4, 0, 1) * 0.6;

  const score = sigmoid(cLen + cWords + cTrip + cLex + cUni - 0.2);
  const margin = clamp(0.4 - n / 3000, 0.2, 0.4); // brede marge: zwakke signalen
  return {
    score: round(score),
    low: round(clamp(score - margin, 0, 1)),
    high: round(clamp(score + margin, 0, 1)),
    label: label(score),
    signals: {
      sentence_length: sig(cLen),
      ai_words: sig(cWords),
      triplets: sig(cTrip),
      lexical_diversity: sig(cLex),
      unicode: sig(cUni),
    },
  };
}

/** Score per zin (alleen signalen die op zinsniveau iets zeggen). */
export function scoreSentence(text: string): SentenceResult {
  const cWords = Math.min(aiWordHits(text), 2) * 1.2;
  const cTrip = tripletCount(text) > 0 ? 0.3 : 0;
  const cUni = (unicodeHits(text) > 0 ? 1.5 : 0) + (emDashes(text) > 0 ? 0.4 : 0);
  return {
    text,
    score: round(sigmoid(cWords + cTrip + cUni - 1)),
    signals: { ai_words: sig(cWords), triplets: sig(cTrip), unicode: sig(cUni) },
  };
}

/** Volledige analyse in lichte modus, in hetzelfde formaat als de detector. */
export function analyzeLight(paragraphs: { id: string; text: string }[]): AnalysisResult {
  const all = paragraphs.map((p) => p.text).join("\n\n");
  const total = scoreText(all);
  const n = words(all).length;
  const paras: ParagraphResult[] = paragraphs.map((p) => {
    const s = scoreText(p.text);
    return { id: p.id, score: s.score, low: s.low, high: s.high, label: s.label, sentences: splitSentences(p.text).map(scoreSentence) };
  });
  const warnings = ["Lichte modus: indicatief, beperkte betrouwbaarheid. Start de detector voor een echte analyse."];
  if (n < SHORT_TEXT_WORDS) warnings.unshift(`Korte tekst (${n} woorden, < ${SHORT_TEXT_WORDS}): lage betrouwbaarheid.`);
  return {
    mode: "light",
    models: [{ signal: "stylometry", name: "lichte modus (stilometrie in de add-in)" }],
    overall: { score: total.score, low: total.low, high: total.high, label: total.label },
    signalsOverall: total.signals,
    paragraphs: paras,
    warnings,
    costUsd: null,
    elapsedMs: null,
  };
}
