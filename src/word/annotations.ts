/**
 * Kronkels in het document via de Word annotations / critiques API (WordApi 1.7; pop-up-opties 1.8).
 * Zie https://learn.microsoft.com/en-us/office/dev/add-ins/word/annotations
 *
 * - Kronkels worden niet in het .docx opgeslagen; na heropenen zet de add-in ze opnieuw.
 * - De titel/ondertitel van de pop-up komen uit het manifest (bt:String-id's hieronder);
 *   alleen de voorgestelde vervanging (max. 3) is per kronkel vrij te kiezen.
 * - Zonder WordApi 1.7 valt de add-in terug op alleen de lijst in het zijpaneel.
 */
import { findParagraph } from "./paragraphs";

export type Color = "Red" | "Green" | "Blue" | "Lavender" | "Berry";

export interface CritiqueSpec {
  start: number;
  length: number;
  color: Color;
  suggestion?: string;
}

export interface ParagraphCritiques {
  index: number;
  /** Tekst waarvoor de kronkels berekend zijn; is de alinea intussen veranderd, dan slaan we hem over. */
  text: string;
  critiques: CritiqueSpec[];
}

const supported = (v: string) => {
  try {
    return Office.context.requirements.isSetSupported("WordApi", v);
  } catch {
    return false;
  }
};
export const annotationsSupported = () => typeof Word !== "undefined" && supported("1.7");
let popupOk = true; // wordt false als Word de pop-up-opties weigert

function toCritique(c: CritiqueSpec, withPopup: boolean): Word.Critique {
  const crit: Word.Critique = { colorScheme: c.color as Word.CritiqueColorScheme, start: c.start, length: c.length };
  if (withPopup) {
    crit.popupOptions = {
      brandingTextResourceId: "WS.Brand",
      titleResourceId: "WS.Critique.Title",
      subtitleResourceId: "WS.Critique.Subtitle",
      suggestions: c.suggestion ? [c.suggestion] : [],
    };
  }
  return crit;
}

/**
 * Vervangt de kronkels van de opgegeven alinea's. Geeft per alinea-index de nieuwe annotatie-id's terug,
 * in dezelfde volgorde als `critiques`.
 */
export async function setCritiques(updates: ParagraphCritiques[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!annotationsSupported() || !updates.length) return out;
  const withPopup = popupOk && supported("1.8");
  try {
    await insert(updates, withPopup, out);
  } catch (e) {
    if (!withPopup) throw e;
    // Waarschijnlijk worden de pop-up-teksten uit het manifest niet gevonden: zonder pop-up-opties opnieuw.
    popupOk = false;
    out.clear();
    await insert(updates, false, out);
  }
  return out;
}

async function insert(updates: ParagraphCritiques[], withPopup: boolean, out: Map<number, string[]>): Promise<void> {
  await Word.run(async (ctx) => {
    const ps = ctx.document.body.paragraphs;
    ps.load("items/text");
    await ctx.sync();
    const jobs: { u: ParagraphCritiques; p: Word.Paragraph; anns: Word.AnnotationCollection }[] = [];
    for (const u of updates) {
      const p = findParagraph(ps.items, u.index, u.text);
      if (!p) continue;
      const anns = p.getAnnotations();
      anns.load("items/id");
      jobs.push({ u, p, anns });
    }
    await ctx.sync();
    const results: { index: number; ids: OfficeExtension.ClientResult<string[]> }[] = [];
    for (const { u, p, anns } of jobs) {
      anns.items.forEach((a) => a.delete());
      const valid = u.critiques.filter((c) => c.length > 0 && c.start >= 0 && c.start + c.length <= u.text.length);
      if (valid.length) results.push({ index: u.index, ids: p.insertAnnotations({ critiques: valid.map((c) => toCritique(c, withPopup)) }) });
      else out.set(u.index, []);
    }
    await ctx.sync();
    results.forEach((r) => out.set(r.index, r.ids.value));
  });
}

/** Alle kronkels van deze add-in uit het document halen (bv. als de live controle uit gaat). */
export async function clearAllCritiques(): Promise<void> {
  if (!annotationsSupported()) return;
  await Word.run(async (ctx) => {
    const ps = ctx.document.body.paragraphs;
    ps.load("items");
    await ctx.sync();
    const all = ps.items.map((p) => {
      const a = p.getAnnotations();
      a.load("items/id");
      return a;
    });
    await ctx.sync();
    all.forEach((a) => a.items.forEach((x) => x.delete()));
    await ctx.sync();
  });
}

/** Eén kronkel verwijderen (na toepassen of negeren). */
export async function deleteCritique(id: string): Promise<void> {
  if (!annotationsSupported() || !id) return;
  await Word.run(async (ctx) => {
    ctx.document.getAnnotationById(id).delete();
    await ctx.sync();
  }).catch(() => undefined);
}

/**
 * Luistert naar klikken op een kronkel en naar keuzes in de pop-up ("Accept" met de gekozen
 * suggestie, of iets anders = afwijzen).
 */
export async function registerAnnotationEvents(
  onClick: (id: string) => void,
  onAction: (id: string, action: string, suggestion: string) => void
): Promise<void> {
  if (!annotationsSupported()) return;
  await Word.run(async (ctx) => {
    ctx.document.onAnnotationClicked.add(async (args) => onClick(args.id));
    if (supported("1.8")) {
      ctx.document.onAnnotationPopupAction.add(async (args) => onAction(args.id, String(args.action), args.critiqueSuggestion || ""));
    }
    await ctx.sync();
  }).catch(() => undefined);
}

/** Tekst die nu onder de kronkel staat (om te zien of Word de suggestie zelf al toepaste). */
export async function critiqueText(id: string): Promise<string | null> {
  if (!annotationsSupported()) return null;
  return Word.run(async (ctx) => {
    const a = ctx.document.getAnnotationById(id);
    const r = a.critiqueAnnotation.range;
    r.load("text");
    await ctx.sync();
    return r.text;
  }).catch(() => null);
}
