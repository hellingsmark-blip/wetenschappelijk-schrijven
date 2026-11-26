/**
 * Prompt en JSON-schema voor "Parafraseren bij selectie" (fase 2).
 * Pas de tekst van PARAPHRASE_SYSTEM gerust aan; daarna `npm.cmd run build`.
 */

export const PARAPHRASE_SYSTEM = `You are an editor for scientific writing in English (MSc level, environmental sciences).
The user selects a passage in their Word document. Rewrite it in exactly four variants:

1. "scientific" – the style of a peer-reviewed journal article: precise, objective and impersonal;
                   exact field terminology instead of everyday words (e.g. "a lot of" → "substantial",
                   "goes down" → "decreases"); clear subject–verb–object; no rhetorical or emotive wording.
2. "formal"     – more formal register: no contractions, no colloquial or conversational phrasing,
                   complete sentences; otherwise stay close to the original wording.
3. "concise"    – shorter and tighter; remove redundancy and filler.
4. "cautious"   – more carefully hedged where the passage overstates (e.g. "suggests" instead of "proves"),
                   without making it vague or adding unnecessary hedges.

Hard rules (apply to every variant):
- Preserve the meaning and all technical content exactly: every number, unit, chemical formula, symbol,
  abbreviation, citation (e.g. "(Smith et al., 2021)", "[12]"), figure/table reference and named entity
  must appear unchanged.
- Never add new facts, claims, causes, results or citations. Never remove a substantive claim.
- Keep the English variant, terminology and "we/I" rules from the project profile.
- Use preferred terms from the profile glossary; never introduce the variants it says to avoid.
- Do not change established field terminology into generic synonyms.
- If the passage is already good for a given style, make only minimal changes for that variant.
- Keep the same scope: do not merge in text from outside the selection; keep sentence-final punctuation.
- "note": one short sentence in Dutch explaining the main change (for the user interface).

Return only JSON that matches the schema.`;

export const PARAPHRASE_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          style: { type: "string", enum: ["scientific", "formal", "concise", "cautious"] },
          text: { type: "string" },
          note: { type: "string" },
        },
        required: ["style", "text", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
} as const;

export const PARAPHRASE_STYLES = ["scientific", "formal", "concise", "cautious"] as const;
export type ParaphraseStyle = (typeof PARAPHRASE_STYLES)[number];
export interface ParaphraseVariant {
  style: ParaphraseStyle;
  text: string;
  note: string;
}

/** Controleert de JSON van het model zelf (naast de schema-afdwinging van de API). */
export function parseParaphrase(raw: string): ParaphraseVariant[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Antwoord was geen geldige JSON.");
  }
  const vs = (data as { variants?: unknown })?.variants;
  if (!Array.isArray(vs)) throw new Error("Antwoord mist 'variants'.");
  const out: ParaphraseVariant[] = [];
  for (const style of PARAPHRASE_STYLES) {
    const v = vs.find((x) => x && (x as ParaphraseVariant).style === style) as ParaphraseVariant | undefined;
    if (!v || typeof v.text !== "string" || !v.text.trim()) throw new Error(`Variant '${style}' ontbreekt.`);
    out.push({ style, text: v.text.trim(), note: typeof v.note === "string" ? v.note : "" });
  }
  return out;
}

export function paraphraseUserMessage(selection: string, section: string | null, avoid: string[] = []): string {
  let msg = "";
  if (section) msg += `Section of the document: ${section}\n`;
  if (avoid.length) {
    msg += "Give different wordings than these earlier suggestions:\n";
    avoid.forEach((a) => (msg += `- ${a}\n`));
  }
  msg += `<selection>\n${selection}\n</selection>`;
  return msg;
}
