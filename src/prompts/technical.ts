/**
 * Prompt en JSON-schema voor de technische controle (fase 5, Sonnet):
 *  - 6.2 verwisselde vaktermen (alleen als de context het tegenspreekt, geformuleerd als vraag);
 *  - 6.3 tegenstrijdigheden met het feitenblad of tussen secties, en fysisch onmogelijke waarden.
 * Pas de tekst van TECH_SYSTEM gerust aan; daarna `npm.cmd run build`.
 */

export const TECH_SYSTEM = `You are a domain expert reviewing scientific writing (MSc level, environmental sciences) for TECHNICAL CORRECTNESS only.
The project profile gives the field, the fact sheet and the terminology. You check ONE paragraph.

Report only these three kinds of problems:
1. "term" – a technical term that the CONTEXT of the paragraph contradicts (a swapped term). Typical pairs:
   nitrification/denitrification, nitritation/nitratation, aerobic/anoxic/anaerobic, COD/BOD, NH4+-N/NO3--N,
   biofilm/suspended sludge, HRT/SRT, pressure/temperature, adsorption/absorption, oxidation/reduction,
   anode/cathode, cation/anion, AEM/CEM, current/current density, conductivity/concentration.
   Flag ONLY when the surrounding text makes clear that the other term is meant
   (e.g. "ammonium is converted to nitrate by denitrification" → nitrification is meant).
   Never flag a term merely because it could be wrong.
2. "fact" – a value or statement that contradicts the project fact sheet, or contradicts a value stated elsewhere
   in the document (a list of such statements is given; compare like with like: same quantity, same reactor/condition).
3. "impossible" – physically impossible values: pH outside 0–14, removal/efficiency/recovery above 100 %,
   negative concentrations, flows, areas or loads, temperatures below absolute zero, fractions above 1.

Rules:
- Prefer missing a problem over a false alarm. When in doubt, report nothing.
- Ignore grammar, style, wording and notation (sub/superscript, spacing); those are checked elsewhere.
- Empty fact-sheet fields are unknown, not contradictions. Never invent facts or values.
- "quote": the exact text from the paragraph, copied character for character; short (the term, or the value with its unit).
- "replacement": the corrected text for exactly that quote when the correct term or value is clear from the context,
  the fact sheet or the other statements; otherwise "".
- "title": a short Dutch QUESTION, e.g. "Bedoel je nitrification?" or "Klopt 3 g N m⁻² d⁻¹?".
- "explanation": one or two short Dutch sentences with the reason, e.g. "Ammonium → nitraat is nitrificatie."
  or "In Methods staat 2 g N m⁻² d⁻¹ voor dezelfde reactor."
- At most 5 findings. If the paragraph is technically fine, return an empty list.

Return only JSON that matches the schema.`;

export const TECH_KINDS = ["term", "fact", "impossible"] as const;
export type TechKind = (typeof TECH_KINDS)[number];

export const TECH_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...TECH_KINDS] },
          quote: { type: "string" },
          replacement: { type: "string" },
          title: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["kind", "quote", "replacement", "title", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export interface TechRaw {
  kind: TechKind;
  quote: string;
  replacement: string;
  title: string;
  explanation: string;
}

export function parseTech(raw: string): TechRaw[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Antwoord was geen geldige JSON.");
  }
  const list = (data as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) throw new Error("Antwoord mist 'findings'.");
  const out: TechRaw[] = [];
  for (const x of list as Partial<TechRaw>[]) {
    if (!x || typeof x.quote !== "string" || !x.quote.trim()) continue;
    if (!TECH_KINDS.includes(x.kind as TechKind)) continue;
    out.push({
      kind: x.kind as TechKind,
      quote: x.quote,
      replacement: typeof x.replacement === "string" ? x.replacement : "",
      title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : "Klopt dit?",
      explanation: typeof x.explanation === "string" ? x.explanation.trim() : "",
    });
  }
  return out.slice(0, 5);
}

export function techUserMessage(paragraph: string, section: string | null, elsewhere: string[]): string {
  let msg = `Section: ${section || "unknown"}\n`;
  if (elsewhere.length) {
    msg += "Quantitative statements elsewhere in the document (for consistency checks only, do not check these):\n";
    msg += "<elsewhere>\n" + elsewhere.map((s) => "- " + s).join("\n") + "\n</elsewhere>\n";
  }
  msg += `<paragraph>\n${paragraph}\n</paragraph>`;
  return msg;
}

/** Woorden die op technische inhoud wijzen; alinea's zonder cijfers en zonder deze woorden slaan we over (scheelt kosten). */
const TECH_TERMS =
  /\b(nitrif|denitrif|nitrit|nitrat|aerob|anaerob|anox|COD|BOD|ammoni|nitrate|nitrite|HRT|SRT|sludge|biofilm|pressure|temperature|adsorp|absorp|oxidi|oxidat|reduc|anode|cathode|anodic|cathodic|cation|anion|AEM|CEM|current|conductiv|concentrat|membrane|electrode|desalinat|flux|efficien|removal|pH)\w*/i;

export function needsTechnical(text: string): boolean {
  return /\d/.test(text) || TECH_TERMS.test(text);
}

/**
 * Zinnen met getallen uit de rest van het document, met hun sectie, voor de vergelijking tussen secties.
 * Begrensd, zodat de vraag goedkoop blijft.
 */
export function quantitativeStatements(
  paras: { text: string; section: string | null; skip: boolean }[], except: number, maxItems = 30, maxChars = 5000
): string[] {
  const out: string[] = [];
  let chars = 0;
  for (let i = 0; i < paras.length && out.length < maxItems; i++) {
    const p = paras[i];
    if (i === except || p.skip) continue;
    for (const s of p.text.split(/(?<=[.!?])\s+/)) {
      if (!/\d/.test(s) || !/[a-z]{3}/i.test(s) || /^\(?[A-Z][a-z]+ et al\./.test(s)) continue;
      // Alleen zinnen met een getal + eenheid of procent (geen jaartallen of citaties alleen).
      if (!/\d\s?(%|°|[a-zµμ]{1,4}\b|[A-Z][a-z]?\b)/.test(s.replace(/\(\s*[A-Z][^()]*\d{4}[a-z]?\s*\)/g, ""))) continue;
      const line = `[${p.section || "?"}] ${s.trim().slice(0, 220)}`;
      if (chars + line.length > maxChars) return out;
      out.push(line);
      chars += line.length;
      if (out.length >= maxItems) break;
    }
  }
  return out;
}
