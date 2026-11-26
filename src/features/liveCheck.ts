/**
 * Live controle (fase 4): welke alinea's controleren, Claude aanroepen, quotes terugvinden en cachen.
 * Bevat geen Word-code, zodat het met een nep-API te testen is.
 */
import { callClaude, ClaudeRequest, ClaudeResult } from "../api/claude";
import { PRICES } from "../config";
import type { Profile } from "../profiles";
import { profileContext } from "../prompts/profileContext";
import { FirstUse, LIVE_SCHEMA, LIVE_SYSTEM, LiveCategory, liveUserMessage, parseLive } from "../prompts/liveCheck";
import { parseTech, TECH_SCHEMA, TECH_SYSTEM, techUserMessage } from "../prompts/technical";
import { loadJSON, saveJSON } from "../storage";

type Caller = (req: ClaudeRequest) => Promise<ClaudeResult>;

/** Een bevinding van de live controle, met positie binnen de alineatekst. */
export interface LiveItem {
  category: LiveCategory | "technisch";
  quote: string;
  start: number;
  length: number;
  replacement: string;
  title: string;
  explanation: string;
}

// ---------- Alinea's: overslaan en secties ----------

export interface ParaInfo {
  text: string;
  /** Word-stijl (ingebouwd, taalonafhankelijk), bv. "Heading1", "Caption", "Normal", "Other". */
  styleBuiltIn: string;
  /** Naam van de stijl zoals in Word getoond, bv. "Kop 1" of "WUR Heading 1". */
  style: string;
  inTable: boolean;
}

export function isHeading(p: ParaInfo): boolean {
  return /^(Heading\d|Title|Subtitle)$/.test(p.styleBuiltIn) || /heading|kop\s*\d|^titel$/i.test(p.style);
}

export function headingLevel(p: ParaInfo): number {
  const m = /(\d)/.exec(p.styleBuiltIn) || /(\d)/.exec(p.style);
  return m ? Number(m[1]) : 1;
}

const SECTIONS: [RegExp, string][] = [
  [/^(abstract|summary|samenvatting)$/, "Abstract"],
  [/^(introduction|background|inleiding)$/, "Introduction"],
  [/^results and discussion$/, "Results and Discussion"],
  [/^(materials? and methods?|methods?|methodology|experimental( set-?up)?)$/, "Methods"],
  [/^(results?)$/, "Results"],
  [/^(discussion)$/, "Discussion"],
  [/^(conclusions?|conclusions? and recommendations|recommendations)$/, "Conclusion"],
  [/^(references|bibliography|literature( cited)?|literatuur(lijst)?|bronnen)$/, "References"],
  [/^(appendix|appendices|bijlagen?)\b/, "Appendix"],
];

export function canonicalSection(heading: string): string | null {
  const t = heading.toLowerCase().replace(/^[\d.\s]+/, "").replace(/[:.\s]+$/, "").trim();
  for (const [re, name] of SECTIONS) if (re.test(t)) return name;
  return null;
}

/** Sectienaam per alinea, afgeleid uit de kopstijlen. */
export function sectionsFor(paras: ParaInfo[]): (string | null)[] {
  let current: string | null = null;
  return paras.map((p) => {
    if (isHeading(p)) {
      const c = canonicalSection(p.text);
      if (c) current = c;
      else if (headingLevel(p) === 1 && p.text.trim()) current = p.text.trim().slice(0, 60);
    }
    return current;
  });
}

const words = (s: string) => (s.match(/\S+/g) || []).length;

/** Lege alinea's, kopjes, bijschriften, literatuurlijst, tabellen en vergelijkingen overslaan. */
export function shouldSkip(p: ParaInfo, section: string | null): boolean {
  const t = p.text.trim();
  if (!t || words(t) < 4) return true;
  if (isHeading(p) || p.inTable) return true;
  if (p.styleBuiltIn === "Caption" || /^toc\d/i.test(p.styleBuiltIn)) return true;
  if (/^(fig(ure)?|table|tab)\.?\s*[A-Z]?\d/i.test(t)) return true; // bijschrift zonder bijschriftstijl
  if (section === "References") return true;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / t.replace(/\s/g, "").length < 0.5) return true; // vergelijking of getallenrij
  return false;
}

// ---------- Afkortingen: eerste gebruik ----------

const ABBR_RE = /\b[A-Z]{2,}(?:-[A-Z]{2,})*s?\b/g;
const ROMAN = /^[IVXLC]+$/;

export function abbreviationsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(ABBR_RE) || []) {
    const a = m.replace(/s$/, "");
    if (a.length >= 2 && !ROMAN.test(a)) out.add(a);
  }
  return [...out];
}

/** Bepaalt per alinea welke afkortingen daar voor het eerst voorkomen en welke al eerder. */
export function firstUseInfo(texts: string[]): FirstUse[] {
  const seen = new Set<string>();
  return texts.map((t) => {
    const here = abbreviationsIn(t);
    const info: FirstUse = { firstHere: here.filter((a) => !seen.has(a)), earlier: here.filter((a) => seen.has(a)) };
    here.forEach((a) => seen.add(a));
    return info;
  });
}

// ---------- Quote terugvinden ----------

/** Zelfde lengte, zodat posities kloppen: krullende aanhalingstekens en harde spaties gelijkstellen. */
const fold = (s: string) => s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[  ]/g, " ").replace(/[‐‑–]/g, "-");

/** Zoekt de quote in de alineatekst (het model telt geen posities). null = niet gevonden → overslaan. */
export function locateQuote(text: string, quote: string, from = 0): { start: number; length: number } | null {
  if (!quote) return null;
  let i = text.indexOf(quote, from);
  if (i === -1) i = fold(text).indexOf(fold(quote), from);
  if (i === -1) return null;
  return { start: i, length: quote.length };
}

/** Hoeveelste keer (0 = eerste) de tekst op positie `start` voorkomt; nodig om in Word de juiste treffer te kiezen. */
export function occurrenceAt(text: string, quote: string, start: number): number {
  let n = 0;
  let i = text.indexOf(quote);
  while (i !== -1 && i < start) {
    n++;
    i = text.indexOf(quote, i + quote.length);
  }
  return n;
}

/** De cijferreeksen in een tekst, gesorteerd ("1,5" en "1.5" tellen als gelijk). */
export function numbersOf(s: string): string {
  return (s.match(/\d+/g) || []).sort().join(" ");
}

/**
 * Veiligheidsnet: een taal- of stijlsuggestie mag nooit een getal veranderen, toevoegen of weghalen.
 * (Alleen de technische controle mag een waarde voorstellen, en dan op basis van feitenblad of document.)
 */
export function changesNumbers(quote: string, replacement: string): boolean {
  return replacement !== "" && numbersOf(quote) !== numbersOf(replacement);
}

// ---------- Hash en cache ----------

/** cyrb53: snelle 53-bits hash, ruim voldoende voor een cachesleutel. */
export function hash(str: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface CacheStore {
  order: string[];
  map: Record<string, LiveItem[]>;
}
const CACHE_KEY = "liveCache";
const CACHE_MAX = 1200;

/** "live" = taal/stijl/claim/helderheid/consistentie (Haiku); "tech" = technische controle (Sonnet). */
export type CheckKind = "live" | "tech";
/** De prompt hoort bij de sleutel: na een aanpassing van de prompt wordt alles opnieuw gecontroleerd. */
const PROMPT_VERSION: Record<CheckKind, string> = { live: hash(LIVE_SYSTEM), tech: hash(TECH_SYSTEM) };

/** Alles wat (naast de tekst) de uitkomst bepaalt. */
export interface CheckContext {
  kind?: CheckKind;
  profile: Profile;
  model: string;
  section: string | null;
  firstUse: FirstUse;
}

export interface CheckRequest extends CheckContext {
  text: string;
  /** Einde van de vorige alinea, alleen als context (niet in de cachesleutel). */
  previous: string;
  /** Alleen bij "tech": zinnen met getallen uit de rest van het document (niet in de cachesleutel). */
  elsewhere?: string[];
  /** Cache negeren (na het bewerken van het profiel). */
  force?: boolean;
}

export class LiveService {
  private store: CacheStore;

  constructor(private call: Caller = (r) => callClaude(r)) {
    this.store = loadJSON<CacheStore>(CACHE_KEY, { order: [], map: {} });
  }

  /**
   * Sleutel op profielNAAM (niet de inhoud): na het bewerken van een profiel blijven bestaande
   * bevindingen staan; "Opnieuw controleren met dit profiel" (force) ververst ze.
   */
  key(text: string, c: CheckContext): string {
    const kind = c.kind || "live";
    const first = kind === "live" ? [c.firstUse.firstHere.join(","), c.firstUse.earlier.join(",")] : [];
    return hash([kind, PROMPT_VERSION[kind], c.model, c.profile.name, c.section || "", ...first, text].join("\u0000"));
  }

  cached(text: string, c: CheckContext): LiveItem[] | undefined {
    return this.store.map[this.key(text, c)];
  }

  private put(k: string, items: LiveItem[]): void {
    if (!(k in this.store.map)) this.store.order.push(k);
    this.store.map[k] = items;
    while (this.store.order.length > CACHE_MAX) delete this.store.map[this.store.order.shift() as string];
    saveJSON(CACHE_KEY, this.store);
  }

  clearCache(): void {
    this.store = { order: [], map: {} };
    saveJSON(CACHE_KEY, this.store);
  }

  /** Controleert één alinea (of haalt hem uit de cache). */
  async check(r: CheckRequest): Promise<LiveItem[]> {
    const k = this.key(r.text, r);
    const hit = this.store.map[k];
    if (hit && !r.force) return hit;
    const tech = r.kind === "tech";

    const res = await this.call(
      tech
        ? {
            model: r.model,
            system: [
              { text: TECH_SYSTEM, cache: true },
              { text: profileContext(r.profile), cache: true },
            ],
            user: techUserMessage(r.text, r.section, r.elsewhere || []),
            maxTokens: 8000, // Sonnet denkt (adaptief) mee; dat telt als output
            effort: "low",
            jsonSchema: TECH_SCHEMA as unknown as Record<string, unknown>,
          }
        : {
            model: r.model,
            system: [
              { text: LIVE_SYSTEM, cache: true },
              { text: profileContext(r.profile), cache: true },
            ],
            user: liveUserMessage(r.text, r.section, r.firstUse, r.previous),
            maxTokens: 4000, // herschreven hele zinnen kunnen lang zijn
            effort: "low",
            thinkingOff: true,
            jsonSchema: LIVE_SCHEMA as unknown as Record<string, unknown>,
          }
    );
    if (res.stopReason === "max_tokens") throw new Error(`Antwoord afgekapt bij de ${tech ? "technische" : "live"} controle.`);

    const parsed: { category: LiveItem["category"]; quote: string; replacement: string; title: string; explanation: string }[] = tech
      ? parseTech(res.text).map((f) => ({ ...f, category: "technisch" as const }))
      : parseLive(res.text);

    const items: LiveItem[] = [];
    const used: [number, number][] = [];
    for (const f of parsed) {
      // Zoek de quote; bij dubbele bevindingen op dezelfde plek de volgende treffer proberen.
      let pos = locateQuote(r.text, f.quote);
      while (pos && used.some(([s, l]) => pos!.start < s + l && s < pos!.start + pos!.length)) {
        pos = locateQuote(r.text, f.quote, pos.start + 1);
      }
      if (!pos) continue; // quote niet gevonden → overslaan (liever niets dan iets fouts)
      // Zelfde tekst als vervanging = geen echte wijziging (bij een technische vraag mag dat wel: dan is het alleen een vraag).
      const same = f.replacement === r.text.substr(pos.start, pos.length);
      if (same && !tech) continue;
      const replacement = same ? "" : f.replacement;
      if (!tech && changesNumbers(r.text.substr(pos.start, pos.length), replacement)) continue; // verzonnen waarde → weg
      used.push([pos.start, pos.length]);
      items.push({
        category: f.category,
        quote: r.text.substr(pos.start, pos.length),
        start: pos.start,
        length: pos.length,
        replacement,
        title: f.title,
        explanation: f.explanation,
      });
    }
    items.sort((a, b) => a.start - b.start);
    this.put(k, items);
    return items;
  }

  /**
   * Na het toepassen van een wijziging (zelf of via notatie) de cache overzetten naar de nieuwe tekst,
   * zodat de alinea niet opnieuw (betaald) gecontroleerd hoeft te worden.
   * Bevindingen die het gewijzigde stuk overlappen vervallen; latere schuiven op.
   */
  transfer(oldText: string, c: CheckContext, start: number, oldLen: number, newPart: string): void {
    const items = this.cached(oldText, c);
    if (!items) return;
    const newText = oldText.slice(0, start) + newPart + oldText.slice(start + oldLen);
    const delta = newPart.length - oldLen;
    const moved = items
      .filter((f) => f.start + f.length <= start || f.start >= start + oldLen)
      .map((f) => (f.start >= start + oldLen ? { ...f, start: f.start + delta } : f));
    this.put(this.key(newText, c), moved);
  }
}

// ---------- Kostenschatting ----------

/** Grove schatting (bovengrens, zonder cachekorting) voor het controleren van een aantal alinea's. */
export function estimateUsd(model: string, paragraphs: string[], profile: Profile, kind: CheckKind = "live", extraChars = 0): number {
  const p = PRICES[model];
  if (!p) return 0;
  const sysTokens = ((kind === "tech" ? TECH_SYSTEM : LIVE_SYSTEM).length + profileContext(profile).length) / 4;
  let input = 0;
  for (const t of paragraphs) input += sysTokens + (t.length + extraChars) / 4 + 120;
  const output = paragraphs.length * (kind === "tech" ? 600 : 250); // Sonnet: incl. denkwerk
  return (input * p.input + output * p.output) / 1e6;
}
