/**
 * Logica achter het tabblad Tools (fase 6). Geen Word-code, zodat alles met nep-data te testen is.
 *  - lokaal (gratis): huidige sectie bepalen, figuren & tabellen, afkortingenlijst, termen tellen;
 *  - via Claude (Sonnet): vertalen, inkorten, begeleidersmodus, termconsistentie.
 */
import { callClaude, ClaudeRequest, ClaudeResult } from "../api/claude";
import { PRICES } from "../config";
import { wordCount } from "../diff";
import type { Profile } from "../profiles";
import { profileContext } from "../prompts/profileContext";
import {
  parseShorten, parseSupervisor, parseTerms, parseTranslate, SHORTEN_SCHEMA, SHORTEN_SYSTEM, shortenUserMessage,
  SUPERVISOR_SCHEMA, SUPERVISOR_SYSTEM, SupervisorComment, supervisorRole, supervisorUserMessage, TERMS_SCHEMA,
  TERMS_SYSTEM, TRANSLATE_SCHEMA, TRANSLATE_SYSTEM,
} from "../prompts/tools";
import { abbreviationsIn, headingLevel, isHeading, ParaInfo, sectionsFor, shouldSkip } from "./liveCheck";

type Caller = (req: ClaudeRequest) => Promise<ClaudeResult>;
const defaultCall: Caller = (r) => callClaude(r);

// ---------- Huidige sectie ----------

export interface SectionRange {
  /** Index van het kopje (-1 = geen kopje: begin document). */
  heading: number;
  headingText: string;
  /** Alinea-indexen in de sectie (zonder het kopje zelf). */
  indexes: number[];
}

/** De sectie waar de cursor staat: van het laatste kopje tot het volgende kopje van hetzelfde of hoger niveau. */
export function sectionRange(paras: ParaInfo[], cursor: number): SectionRange {
  let h = -1;
  for (let i = Math.max(0, cursor); i >= 0; i--) {
    if (paras[i] && isHeading(paras[i])) {
      h = i;
      break;
    }
  }
  const level = h >= 0 ? headingLevel(paras[h]) : 0;
  const indexes: number[] = [];
  for (let i = h + 1; i < paras.length; i++) {
    if (isHeading(paras[i]) && (level === 0 || headingLevel(paras[i]) <= level)) break;
    indexes.push(i);
  }
  return { heading: h, headingText: h >= 0 ? paras[h].text.trim() : "", indexes };
}

// ---------- Figuren & tabellen (lokaal) ----------

export type FtKind = "figure" | "table";
export interface FtIssue {
  kind: "unreferenced" | "missing" | "numbering" | "order" | "duplicate";
  message: string;
  para: number;
  quote: string;
}
export interface FtReport {
  figures: string[];
  tables: string[];
  issues: FtIssue[];
}

const CAPTION_RE = /^(Figure|Fig\.|Table)\s+(\d+(?:[.-]\d+)*)/i;
const MENTION_RE =
  /\b(Fig(?:ure)?s?\.?|Tables?)\s+(\d+(?:[.-]\d+)*[a-z]?(?:\s*(?:,|and|&|–|—|-|to)\s*\d+(?:[.-]\d+)*[a-z]?)*)/gi;

const kindOf = (word: string): FtKind => (/^tab/i.test(word) ? "table" : "figure");
const NL: Record<FtKind, string> = { figure: "Figuur", table: "Tabel" };

/** "2–4" → 2,3,4; "2 and 3" → 2,3; "3.1, 3.2" → 3.1,3.2. Letters (2a) tellen als 2. */
function expandNumbers(list: string): string[] {
  const out: string[] = [];
  const parts = list.split(/\s*(,|and|&)\s*/).filter((p) => p && !/^(,|and|&)$/.test(p));
  for (const part of parts) {
    const range = /^(\d+(?:\.\d+)*)[a-z]?\s*(?:–|—|-|to)\s*(\d+(?:\.\d+)*)[a-z]?$/.exec(part);
    if (range && !range[1].includes(".") && !range[2].includes(".")) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b >= a && b - a < 50) for (let n = a; n <= b; n++) out.push(String(n));
      continue;
    }
    const m = /^(\d+(?:[.-]\d+)*)/.exec(part);
    if (m) out.push(m[1].replace(/-/g, "."));
  }
  return out;
}

export function checkFiguresTables(paras: ParaInfo[]): FtReport {
  const captions: { kind: FtKind; num: string; para: number; quote: string }[] = [];
  const firstMention = new Map<string, { para: number; quote: string; order: number }>();
  let order = 0;
  const sections = sectionsFor(paras);

  paras.forEach((p, i) => {
    const t = p.text.trim();
    // Bijschrift: in bijschriftstijl, of een korte alinea als "Figure 3. …", "Table 2: …", "Figure 4 Ammonium …"
    // (niet een gewone zin als "Figure 3 shows that …").
    const cap = CAPTION_RE.exec(t);
    if (cap && (p.styleBuiltIn === "Caption" || (t.length < 400 && /^(\s*[.:–—|-]|\s+[A-Z]|\s*$)/.test(t.slice(cap[0].length))))) {
      captions.push({ kind: kindOf(cap[1]), num: cap[2].replace(/-/g, "."), para: i, quote: cap[0] });
      return;
    }
    if (sections[i] === "References") return;
    for (const m of t.matchAll(MENTION_RE)) {
      const kind = kindOf(m[1]);
      for (const num of expandNumbers(m[2])) {
        const key = `${kind}:${num}`;
        if (!firstMention.has(key)) firstMention.set(key, { para: i, quote: m[0].slice(0, 255), order: order++ });
      }
    }
  });

  const issues: FtIssue[] = [];
  for (const kind of ["figure", "table"] as FtKind[]) {
    const caps = captions.filter((c) => c.kind === kind);
    const seen = new Set<string>();
    let prev: number[] | null = null;
    for (const c of caps) {
      if (seen.has(c.num)) {
        issues.push({ kind: "duplicate", message: `${NL[kind]} ${c.num} komt twee keer voor als bijschrift.`, para: c.para, quote: c.quote });
      }
      seen.add(c.num);
      // Nummering: 1, 2, 3 … of per hoofdstuk 3.1, 3.2 …
      const parts = c.num.split(".").map(Number);
      if (prev) {
        const sameChapter = parts.length > 1 && prev.length > 1 && parts[0] === prev[0];
        const ok =
          parts.length === 1
            ? parts[0] === prev[prev.length - 1] + 1
            : sameChapter
              ? parts[1] === prev[1] + 1
              : parts[0] > prev[0] && parts[1] === 1;
        if (!ok) {
          issues.push({
            kind: "numbering",
            message: `Nummering springt van ${NL[kind]} ${prev.join(".")} naar ${NL[kind]} ${c.num}.`,
            para: c.para,
            quote: c.quote,
          });
        }
      } else if (parts[parts.length - 1] !== 1) {
        issues.push({ kind: "numbering", message: `Eerste ${NL[kind].toLowerCase()} heeft nummer ${c.num} in plaats van 1.`, para: c.para, quote: c.quote });
      }
      prev = parts;
      if (!firstMention.has(`${kind}:${c.num}`)) {
        issues.push({ kind: "unreferenced", message: `${NL[kind]} ${c.num} wordt nergens in de tekst genoemd.`, para: c.para, quote: c.quote });
      }
    }
    // Genoemd zonder bijschrift
    for (const [key, m] of firstMention) {
      const [k, num] = key.split(":");
      if (k === kind && !seen.has(num) && caps.length) {
        issues.push({ kind: "missing", message: `${NL[kind]} ${num} wordt genoemd, maar er is geen bijschrift met dat nummer.`, para: m.para, quote: m.quote });
      }
    }
    // Volgorde van eerste vermelding
    const mentioned = caps.filter((c) => firstMention.has(`${kind}:${c.num}`));
    for (let j = 1; j < mentioned.length; j++) {
      const a = firstMention.get(`${kind}:${mentioned[j - 1].num}`)!;
      const b = firstMention.get(`${kind}:${mentioned[j].num}`)!;
      if (b.order < a.order) {
        issues.push({
          kind: "order",
          message: `${NL[kind]} ${mentioned[j].num} wordt eerder in de tekst genoemd dan ${NL[kind]} ${mentioned[j - 1].num}.`,
          para: b.para,
          quote: b.quote,
        });
      }
    }
  }
  return {
    figures: captions.filter((c) => c.kind === "figure").map((c) => c.num),
    tables: captions.filter((c) => c.kind === "table").map((c) => c.num),
    issues,
  };
}

// ---------- Afkortingenlijst (lokaal) ----------

export interface AbbrEntry {
  abbr: string;
  full: string;
  count: number;
  /** Waar de afkorting voor het eerst voorkomt. */
  firstPara: number;
  status: "defined" | "later" | "missing";
  /** Bij "later": in welke alinea hij wel wordt uitgeschreven. */
  definedPara?: number;
  /** Voluit gevonden in de tekst (en nog niet in het profiel). */
  fromText: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Probeert "full words (ABBR)" of "ABBR (full words)" te herkennen; geeft de volledige vorm of "". */
function definitionAt(text: string, abbr: string): string {
  const before = new RegExp(`((?:[A-Za-z][\\w-]*\\s+){1,8})\\(${esc(abbr)}s?\\)`).exec(text);
  if (before) {
    const words = before[1].trim().split(/\s+/);
    const letters = abbr.replace(/[^A-Z]/g, "").length;
    const take = words.slice(-Math.min(words.length, Math.max(letters, 1) + 1));
    // Woorden vooraan laten vallen tot de beginletters passen bij de afkorting.
    while (take.length > letters && !take[0].toUpperCase().startsWith(abbr[0])) take.shift();
    while (take.length && /^(the|a|an|of|and|in)$/i.test(take[0])) take.shift();
    return take.join(" ");
  }
  const after = new RegExp(`\\b${esc(abbr)}\\s*\\(([^()]{3,80})\\)`).exec(text);
  if (after && /[a-z]/.test(after[1]) && !/\d{4}/.test(after[1])) return after[1].trim();
  return "";
}

export function abbreviationReport(paras: ParaInfo[], profile: Profile): AbbrEntry[] {
  const sections = sectionsFor(paras);
  const map = new Map<string, AbbrEntry>();
  const known = new Map(profile.abbreviations.map((a) => [a.short, a.full]));

  paras.forEach((p, i) => {
    if (sections[i] === "References" || !p.text.trim()) return;
    const words = p.text.split(/\s+/).filter(Boolean);
    const caps = words.filter((w) => /^[A-Z]{3,}[.:,;]?$/.test(w)).length;
    if (words.length > 1 && caps / words.length > 0.5) return; // kopje in hoofdletters
    const found = new Set(abbreviationsIn(p.text));
    for (const k of known.keys()) if (new RegExp(`\\b${esc(k)}\\b`).test(p.text)) found.add(k);
    for (const a of found) {
      const count = (p.text.match(new RegExp(`\\b${esc(a)}s?\\b`, "g")) || []).length;
      const def = definitionAt(p.text, a);
      const e = map.get(a);
      if (!e) {
        map.set(a, {
          abbr: a,
          full: def || known.get(a) || "",
          count,
          firstPara: i,
          status: def ? "defined" : "missing",
          fromText: !!def && !known.has(a),
        });
      } else {
        e.count += count;
        if (e.status === "missing" && def) {
          e.status = "later";
          e.definedPara = i;
          if (!e.full) e.full = def;
          e.fromText = !known.has(a);
        }
      }
    }
  });
  return [...map.values()].sort((a, b) => a.abbr.localeCompare(b.abbr));
}

// ---------- Termen tellen ----------

/** Aantal keer dat `term` als los woord/woordgroep voorkomt (hoofdletterongevoelig). */
export function countTerm(text: string, term: string): number {
  if (!term) return 0;
  return (text.match(new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?![A-Za-z0-9])`, "gi")) || []).length;
}

export interface TermGroup {
  preferred: string;
  preferredCount: number;
  variants: { text: string; count: number }[];
  explanation: string;
}

/** Houdt alleen varianten over die echt in de tekst staan en echt anders zijn dan de voorkeursvorm. */
export function verifyTermGroups(text: string, raw: { preferred: string; variants: string[]; explanation: string }[]): TermGroup[] {
  return raw
    .map((g) => ({
      preferred: g.preferred,
      preferredCount: countTerm(text, g.preferred),
      variants: [...new Set(g.variants)]
        .filter((v) => v.toLowerCase() !== g.preferred.toLowerCase())
        .map((v) => ({ text: v, count: countTerm(text, v) }))
        .filter((v) => v.count > 0),
      explanation: g.explanation,
    }))
    .filter((g) => g.variants.length > 0);
}

/** Behoud hoofdletter aan het begin (begin van een zin), behalve bij afkortingen. */
export function matchCase(original: string, replacement: string): string {
  if (/^[A-Z]/.test(original) && /^[a-z]/.test(replacement)) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/**
 * Posities (in kleine letters, zoals Word zonder hoofdlettergevoeligheid zoekt) van `term` in `text`,
 * met per treffer of hij vervangen mag worden: los woord, en niet de definitie "term (ABBR)".
 */
export function replaceableOccurrences(text: string, term: string): boolean[] {
  const lt = text.toLowerCase();
  const lterm = term.toLowerCase();
  const out: boolean[] = [];
  let i = lt.indexOf(lterm);
  while (i !== -1) {
    const before = text[i - 1] || " ";
    const after = text[i + term.length] || " ";
    const boundary = !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
    const isDefinition = /^\s*\(/.test(text.slice(i + term.length));
    out.push(boundary && !isDefinition);
    i = lt.indexOf(lterm, i + lterm.length);
  }
  return out;
}

// ---------- Kostenschatting ----------

export function estimateToolUsd(model: string, inputChars: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return ((inputChars / 4 + 1500) * p.input + outputTokens * p.output) / 1e6;
}

// ---------- Claude-aanroepen ----------

function system(prompt: string, profile: Profile) {
  return [
    { text: prompt, cache: true },
    { text: profileContext(profile), cache: true },
  ];
}

function cut(res: ClaudeResult): void {
  if (res.stopReason === "max_tokens") throw new Error("Antwoord afgekapt — probeer een kortere tekst.");
}

export async function translate(text: string, profile: Profile, model: string, call: Caller = defaultCall) {
  const res = await call({
    model,
    system: system(TRANSLATE_SYSTEM, profile),
    user: `<dutch>\n${text}\n</dutch>`,
    maxTokens: 8000,
    effort: "low",
    jsonSchema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
  });
  cut(res);
  return parseTranslate(res.text);
}

/** Inkorten; als het eerste resultaat te lang is, nog één keer met de telling erbij. */
export async function shorten(text: string, maxWords: number, profile: Profile, model: string, call: Caller = defaultCall) {
  let previous: number | undefined;
  let out = { text: "", removed: "" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call({
      model,
      system: system(SHORTEN_SYSTEM, profile),
      user: shortenUserMessage(text, maxWords, previous),
      maxTokens: 8000,
      effort: "low",
      jsonSchema: SHORTEN_SCHEMA as unknown as Record<string, unknown>,
    });
    cut(res);
    out = parseShorten(res.text);
    previous = wordCount(out.text);
    if (previous <= maxWords) break;
  }
  return { ...out, words: wordCount(out.text) };
}

export interface SupervisorResult {
  summary: string;
  /** `para` = index in het document (omgerekend van [P#]). */
  comments: (SupervisorComment & { para: number })[];
}

export async function supervise(
  heading: string, paragraphs: { index: number; text: string }[], profile: Profile, model: string, call: Caller = defaultCall
): Promise<SupervisorResult> {
  const res = await call({
    model,
    system: system(SUPERVISOR_SYSTEM, profile),
    user: supervisorUserMessage(supervisorRole(profile.docType), heading, paragraphs.map((p) => p.text)),
    maxTokens: 16000,
    effort: "medium",
    jsonSchema: SUPERVISOR_SCHEMA as unknown as Record<string, unknown>,
  });
  cut(res);
  const r = parseSupervisor(res.text);
  return {
    summary: r.summary,
    comments: r.comments
      .filter((c) => c.paragraph >= 1 && c.paragraph <= paragraphs.length)
      .map((c) => {
        const p = paragraphs[c.paragraph - 1];
        // Quote die niet letterlijk in de alinea staat: dan het begin van de alinea als anker.
        const quote = c.quote && p.text.includes(c.quote) ? c.quote : p.text.split(/\s+/).slice(0, 6).join(" ");
        return { ...c, quote, para: p.index };
      }),
  };
}

export async function findTermVariants(docText: string, profile: Profile, model: string, call: Caller = defaultCall): Promise<TermGroup[]> {
  const res = await call({
    model,
    system: system(TERMS_SYSTEM, profile),
    user: `<document>\n${docText}\n</document>`,
    maxTokens: 12000,
    effort: "low",
    jsonSchema: TERMS_SCHEMA as unknown as Record<string, unknown>,
  });
  cut(res);
  return verifyTermGroups(docText, parseTerms(res.text));
}

/** Tekst van het document voor de termcontrole (zonder literatuurlijst, tabellen en lege alinea's), begrensd. */
export function documentText(paras: ParaInfo[], maxChars = 200000): string {
  const sections = sectionsFor(paras);
  const parts: string[] = [];
  let n = 0;
  paras.forEach((p, i) => {
    const t = p.text.trim();
    if (!t || sections[i] === "References" || (shouldSkip(p, sections[i]) && !isHeading(p))) return;
    if (n + t.length > maxChars) return;
    parts.push(t);
    n += t.length + 2;
  });
  return parts.join("\n\n");
}
