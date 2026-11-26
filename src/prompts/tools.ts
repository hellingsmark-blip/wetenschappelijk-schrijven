/**
 * Prompts en JSON-schema's voor het tabblad Tools (fase 6, Sonnet).
 * Pas de teksten gerust aan; daarna `npm.cmd run build`.
 */
import type { DocType } from "../profiles";

const SHARED_RULES = `- Keep every number, unit, chemical formula, citation (e.g. "(Smith et al., 2021)", "[12]"), figure/table reference and named entity unchanged.
- Never add new facts, results, causes, citations or claims, and keep the same level of certainty.
- Follow the project profile: English variant, "we"/"I" rules, glossary (preferred terms) and abbreviations.`;

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

function parseJSON<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Antwoord was geen geldige JSON.");
  }
}
const s = (v: unknown) => (typeof v === "string" ? v : "");

// ---------- 1. Nederlands → wetenschappelijk Engels ----------

export const TRANSLATE_SYSTEM = `You translate Dutch text written by an MSc student (environmental sciences, Wageningen University)
into scientific English suitable for an academic report or thesis.

Rules:
- Translate faithfully: same meaning, same claims, same structure unless English requires otherwise.
- Academic register: no contractions, no colloquial wording, precise field terminology.
- Translate Dutch technical terms into the standard English term of the field (e.g. "rwzi" → "WWTP", "slib" → "sludge",
  "beluchting" → "aeration"), following the profile glossary where it applies.
${SHARED_RULES}
- If the input is already English, return it with only minimal improvements.
- "note": one short Dutch sentence about a choice the user should check (an ambiguous term, an assumption), or "".

Return only JSON that matches the schema.`;

export const TRANSLATE_SCHEMA = obj({ translation: { type: "string" }, note: { type: "string" } });

export function parseTranslate(raw: string): { translation: string; note: string } {
  const d = parseJSON<Record<string, unknown>>(raw);
  const translation = s(d.translation).trim();
  if (!translation) throw new Error("Antwoord bevat geen vertaling.");
  return { translation, note: s(d.note).trim() };
}

// ---------- 4. Inkorten tot X woorden ----------

export const SHORTEN_SYSTEM = `You shorten a passage of scientific English (MSc level, environmental sciences) to a maximum number of words
given in the message, for example an abstract that is over the word limit.

Rules:
- Stay at or below the word limit; aim for 90–100 % of it. Words are counted as whitespace-separated tokens.
- Keep the main aim, method, key results (with their numbers and units) and conclusion. Remove redundancy, filler,
  repetitions and secondary details first.
${SHARED_RULES}
- The result must read as fluent, coherent academic English, not as a list of fragments.
- "removed": one short Dutch sentence describing what was left out.

Return only JSON that matches the schema.`;

export const SHORTEN_SCHEMA = obj({ text: { type: "string" }, removed: { type: "string" } });

export function parseShorten(raw: string): { text: string; removed: string } {
  const d = parseJSON<Record<string, unknown>>(raw);
  const text = s(d.text).trim();
  if (!text) throw new Error("Antwoord bevat geen ingekorte tekst.");
  return { text, removed: s(d.removed).trim() };
}

export function shortenUserMessage(text: string, maxWords: number, previousCount?: number): string {
  let m = `Word limit: ${maxWords} words.\n`;
  if (previousCount) m += `Your previous attempt had ${previousCount} words, which is over the limit. Shorten further.\n`;
  return m + `<passage>\n${text}\n</passage>`;
}

// ---------- 3. Begeleidersmodus ----------

export const SUPERVISOR_SYSTEM = `You read one section of a student's document the way their supervisor would: critical, specific and constructive.
The role (which kind of supervisor) is given in the message; the project profile gives the field, document type and the
supervisor's wishes — take those wishes into account.

Comment on:
- "logic": argumentation — does each statement follow, are there gaps, leaps or contradictions?
- "support": claims without data, citation or explanation; in Methods, missing information needed to reproduce the work.
- "transition": weak or missing links between paragraphs or between ideas.
- "structure": does each paragraph have a clear topic sentence; does the section do what its heading promises; is the order logical?
- "other": anything else a supervisor would definitely raise (e.g. scope, relevance, missing limitation).

Rules:
- Do NOT comment on grammar, spelling, word choice or notation; that is checked elsewhere.
- Write comments in Dutch, concrete and actionable (what is missing or unclear, and what to do), 1–3 sentences each.
- Anchor each comment: "paragraph" = the number of the [P#] paragraph it concerns, and "quote" = a short exact
  quote from that paragraph (3–12 words, copied character for character).
- At most 12 comments, most important first. Fewer is fine if the section is good.
- "summary": 2–4 Dutch sentences with your overall judgement and the single most important improvement.

Return only JSON that matches the schema.`;

export const SUPERVISOR_TYPES = ["logic", "support", "transition", "structure", "other"] as const;
export type SupervisorType = (typeof SUPERVISOR_TYPES)[number];

export const SUPERVISOR_SCHEMA = obj({
  summary: { type: "string" },
  comments: {
    type: "array",
    items: obj({
      paragraph: { type: "integer" },
      quote: { type: "string" },
      type: { type: "string", enum: [...SUPERVISOR_TYPES] },
      comment: { type: "string" },
    }),
  },
});

export interface SupervisorComment {
  paragraph: number;
  quote: string;
  type: SupervisorType;
  comment: string;
}

export function parseSupervisor(raw: string): { summary: string; comments: SupervisorComment[] } {
  const d = parseJSON<{ summary?: unknown; comments?: unknown }>(raw);
  const list = Array.isArray(d.comments) ? d.comments : [];
  const comments = (list as Record<string, unknown>[])
    .filter((c) => c && s(c.comment).trim() && Number.isInteger(c.paragraph))
    .map((c) => ({
      paragraph: c.paragraph as number,
      quote: s(c.quote),
      type: (SUPERVISOR_TYPES.includes(c.type as SupervisorType) ? c.type : "other") as SupervisorType,
      comment: s(c.comment).trim(),
    }))
    .slice(0, 12);
  return { summary: s(d.summary).trim(), comments };
}

export function supervisorRole(docType: DocType): string {
  switch (docType) {
    case "thesis":
      return "the MSc thesis supervisor at Wageningen University";
    case "artikel":
      return "a peer reviewer for a scientific journal";
    case "presentatietekst":
      return "a supervisor reviewing the text of a presentation (spoken style is fine, but the logic must hold)";
    default:
      return "the internship supervisor (host organisation and university) reading the internship report";
  }
}

export function supervisorUserMessage(role: string, heading: string, paragraphs: string[]): string {
  return (
    `Your role: ${role}.\nSection: ${heading || "(no heading)"}\n<section>\n` +
    paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join("\n\n") +
    "\n</section>"
  );
}

// ---------- 7. Termconsistentie ----------

export const TERMS_SYSTEM = `You find inconsistent terminology in a scientific document: different forms used for the SAME concept.
Look for:
- spelling or hyphenation variants ("membrane-aerated" vs "membrane aerated", "waste water" vs "wastewater");
- synonyms or near-synonyms for the same technical concept ("MABR" / "membrane aerated bioreactor" / "membrane biofilm reactor");
- an abbreviation and its full form used interchangeably after the abbreviation has been defined;
- British and American spellings of the same word mixed.

Rules:
- Only report groups whose forms really refer to the same thing in this document. Different concepts are not variants.
- "preferred": follow the profile glossary and abbreviations; otherwise the most correct standard term of the field
  (usually the most frequent form).
- "variants": the OTHER forms exactly as they appear in the text (copied character for character, without surrounding words).
- Writing the full term once with the abbreviation in brackets at first use, e.g. "membrane aerated biofilm reactor (MABR)", is correct and is not a variant by itself.
- "explanation": one short Dutch sentence.
- At most 15 groups, most important first. Return an empty list if the terminology is consistent.

Return only JSON that matches the schema.`;

export const TERMS_SCHEMA = obj({
  groups: {
    type: "array",
    items: obj({
      preferred: { type: "string" },
      variants: { type: "array", items: { type: "string" } },
      explanation: { type: "string" },
    }),
  },
});

export interface TermGroupRaw {
  preferred: string;
  variants: string[];
  explanation: string;
}

export function parseTerms(raw: string): TermGroupRaw[] {
  const d = parseJSON<{ groups?: unknown }>(raw);
  const list = Array.isArray(d.groups) ? (d.groups as Record<string, unknown>[]) : [];
  return list
    .filter((g) => g && s(g.preferred).trim())
    .map((g) => ({
      preferred: s(g.preferred).trim(),
      variants: (Array.isArray(g.variants) ? g.variants : []).map((v) => s(v).trim()).filter(Boolean),
      explanation: s(g.explanation).trim(),
    }))
    .slice(0, 15);
}
