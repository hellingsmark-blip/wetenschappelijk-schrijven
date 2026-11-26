/**
 * Prompt en JSON-schema voor de live controle (fase 4, Haiku).
 * Categorieën: taal, stijl, claim, helderheid, consistentie. (Technisch volgt in fase 5; notatie is lokaal.)
 * Pas de tekst van LIVE_SYSTEM gerust aan; daarna `npm.cmd run build`.
 */

export const LIVE_CATEGORIES = ["taal", "stijl", "claim", "helderheid", "consistentie"] as const;
export type LiveCategory = (typeof LIVE_CATEGORIES)[number];

export const LIVE_SYSTEM = `You are a careful copy editor for scientific writing in English (MSc level, environmental sciences, Wageningen University).
You receive ONE paragraph from the user's Word document, the section it belongs to, and the project profile.
Report only clear, useful problems in these categories:

- "taal": grammar, spelling and punctuation errors. Spelling must follow the profile's English variant (British or American) consistently.
- "stijl": informal wording ("a lot of", "huge", "very", "really", "pretty", "get", "big"), contractions ("don't", "it's"),
  vague words ("things", "stuff", "some kind of"), and "we"/"I" when the profile does not allow it.
- "claim": overstated claims ("proves", "clearly shows", "always", "undoubtedly") that the stated data cannot carry,
  or unnecessary stacked hedging ("might possibly suggest").
- "helderheid": sentences longer than 35 words, ambiguous references ("this", "it", "these" without a clear noun),
  stacked nominalisations ("the implementation of the optimisation of the removal").
- "consistentie": terms that deviate from the profile glossary; abbreviations that deviate from the profile list;
  an abbreviation that is NOT written out at its first occurrence in the document (use the first-use information in the message);
  verb tense that does not fit the section (past tense for what was done or found in Methods and Results;
  present tense for established knowledge and for what figures/tables show).

Rules:
- Prefer missing a problem over reporting a wrong one. No nitpicking about style choices that are common in the field of the profile.
- Do not report anything about chemical formulas, units, sub/superscript or number–unit spacing; that is handled elsewhere.
- Never change meaning or technical content. Never add facts, numbers, citations or claims.
- NEVER change, add or remove a number or value, not even when it looks implausible or impossible
  (e.g. "pH was 16"): you do not know the correct value, and implausible values are checked separately.
  A replacement must contain exactly the same numbers as its quote.
- "quote": the exact contiguous text from the paragraph that has the problem, copied character for character.
  It must occur in the paragraph exactly as written. Keep it as short as the fix allows:
  usually 1–8 words; for a sentence that needs restructuring (too long, unclear reference, stacked nominalisations)
  quote the WHOLE sentence including its final full stop.
- "replacement": ALWAYS give a concrete, ready-to-use rewrite of exactly that quote, so that replacing quote with
  replacement fixes the problem. Examples:
  * too long → the same content split into two or three shorter sentences;
  * "This shows…" with an unclear reference → "This increase in nitrification shows…" (use a noun from the context);
  * stacked nominalisations → a version with active verbs;
  * overstated claim → the appropriately hedged wording ("suggests", "indicates");
  * abbreviation not written out at first use → "full term (ABBR)".
  Keep all numbers, units, citations, terms and meaning unchanged. Use "" only if no rewrite is possible without
  inventing information (e.g. a claim that needs data the paragraph does not give).
- "title": a short Dutch label of at most 6 words, e.g. "Informeel woord", "Samentrekking", "Te stellige claim", "Afkorting niet uitgeschreven".
- "explanation": one or two short Dutch sentences explaining why.
- Report each problem once; at most 8 findings per paragraph. If the paragraph is fine, return an empty list.

Return only JSON that matches the schema.`;

export const LIVE_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...LIVE_CATEGORIES] },
          quote: { type: "string" },
          replacement: { type: "string" },
          title: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["category", "quote", "replacement", "title", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export interface LiveRaw {
  category: LiveCategory;
  quote: string;
  replacement: string;
  title: string;
  explanation: string;
}

/** Controleert de JSON van het model zelf (naast de schema-afdwinging van de API). */
export function parseLive(raw: string): LiveRaw[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Antwoord was geen geldige JSON.");
  }
  const list = (data as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) throw new Error("Antwoord mist 'findings'.");
  const out: LiveRaw[] = [];
  for (const x of list as Partial<LiveRaw>[]) {
    if (!x || typeof x.quote !== "string" || !x.quote.trim()) continue;
    if (!LIVE_CATEGORIES.includes(x.category as LiveCategory)) continue;
    out.push({
      category: x.category as LiveCategory,
      quote: x.quote,
      replacement: typeof x.replacement === "string" ? x.replacement : "",
      title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : "Suggestie",
      explanation: typeof x.explanation === "string" ? x.explanation.trim() : "",
    });
  }
  return out.slice(0, 8);
}

export interface FirstUse {
  /** Afkortingen die in deze alinea voor het eerst in het document voorkomen. */
  firstHere: string[];
  /** Afkortingen die eerder in het document al gebruikt zijn. */
  earlier: string[];
}

export function liveUserMessage(paragraph: string, section: string | null, firstUse: FirstUse, previous: string): string {
  let msg = `Section: ${section || "unknown"}\n`;
  if (firstUse.firstHere.length)
    msg += `Abbreviations whose FIRST occurrence in the document is in this paragraph: ${firstUse.firstHere.join(", ")}\n`;
  if (firstUse.earlier.length) msg += `Abbreviations already used earlier in the document: ${firstUse.earlier.join(", ")}\n`;
  if (previous) msg += `End of the previous paragraph (context only, do not check):\n<previous>\n${previous}\n</previous>\n`;
  msg += `<paragraph>\n${paragraph}\n</paragraph>`;
  return msg;
}
