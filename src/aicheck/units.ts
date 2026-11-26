/**
 * Welke stukken tekst gaan naar de AI-check, en waar staan de zinnen uit het antwoord in de alinea?
 * Geen Word-code (testbaar).
 */
import { locateQuote, ParaInfo, sectionsFor, shouldSkip } from "../features/liveCheck";
import { sectionRange } from "../features/tools";
import type { SentenceResult } from "./types";

export interface Unit {
  /** Id voor het contract ("p12" = alinea 12). */
  id: string;
  /** Index van de alinea in het document. */
  para: number;
  /** Volledige tekst van die alinea in Word (om zinnen terug te vinden). */
  paraText: string;
  /** Tekst die geanalyseerd wordt (bij een selectie soms een deel van de alinea). */
  text: string;
}

/** Zelfde regels als de live controle (geen kopjes, bijschriften, tabellen, literatuur, vergelijkingen), maar korte alinea's tellen mee. */
const eligible = (paras: ParaInfo[], sections: (string | null)[], i: number) => {
  const p = paras[i];
  if (!p.text.trim()) return false;
  // shouldSkip slaat ook alinea's < 4 woorden over; die telt de AI-check wel mee.
  return !shouldSkip({ ...p, text: p.text + " x x x x" }, sections[i]);
};

export function documentUnits(paras: ParaInfo[]): Unit[] {
  const sections = sectionsFor(paras);
  return paras
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => eligible(paras, sections, i))
    .map(({ p, i }) => ({ id: `p${i}`, para: i, paraText: p.text, text: p.text.trim() }));
}

export function sectionUnits(paras: ParaInfo[], cursor: number): { units: Unit[]; heading: string } {
  const sections = sectionsFor(paras);
  const r = sectionRange(paras, Math.max(0, cursor));
  return {
    heading: r.headingText,
    units: r.indexes
      .filter((i) => eligible(paras, sections, i))
      .map((i) => ({ id: `p${i}`, para: i, paraText: paras[i].text, text: paras[i].text.trim() })),
  };
}

/** Selectie (kan meerdere alinea's of een deel van één alinea zijn) → stukken met hun alinea. */
export function selectionUnits(paras: ParaInfo[], selection: string): Unit[] {
  const pieces = selection.split(/[\r\n\u000b]+/).map((s) => s.trim()).filter(Boolean);
  const out: Unit[] = [];
  let from = 0;
  for (const piece of pieces) {
    let i = paras.findIndex((p, k) => k >= from && p.text.includes(piece));
    if (i < 0) i = paras.findIndex((p) => p.text.includes(piece));
    if (i < 0) continue;
    from = i + 1;
    out.push({ id: `p${i}`, para: i, paraText: paras[i].text, text: piece });
  }
  return out;
}

/** Positie van elke zin in de alinea (null = niet gevonden). Zoekt van voor naar achter. */
export function sentenceSpans(paraText: string, sentences: SentenceResult[]): ({ start: number; length: number } | null)[] {
  let from = 0;
  return sentences.map((s) => {
    const t = s.text.trim();
    const pos = locateQuote(paraText, t, from) || locateQuote(paraText, t);
    if (pos) from = pos.start + pos.length;
    return pos;
  });
}

export const wordTotal = (units: Unit[]) => units.reduce((n, u) => n + (u.text.match(/\S+/g) || []).length, 0);
