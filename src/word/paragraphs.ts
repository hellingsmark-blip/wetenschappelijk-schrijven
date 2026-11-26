/**
 * Word-koppeling: alinea's lezen en tekst binnen een alinea vervangen.
 */
import type { ParaInfo } from "../features/liveCheck";

export interface DocParagraphs {
  paras: ParaInfo[];
  /** Index van de alinea waar de cursor staat (-1 als onbekend). */
  cursor: number;
}

export async function readParagraphs(): Promise<DocParagraphs> {
  if (typeof Word === "undefined") return { paras: [], cursor: -1 };
  return Word.run(async (ctx) => {
    const ps = ctx.document.body.paragraphs;
    ps.load("items/text,items/style,items/styleBuiltIn,items/tableNestingLevel");
    const cur = ctx.document.getSelection().paragraphs.getFirst();
    cur.load("text");
    await ctx.sync();
    const paras = ps.items.map((p) => ({
      text: p.text || "",
      style: p.style || "",
      styleBuiltIn: String(p.styleBuiltIn || ""),
      inTable: (p.tableNestingLevel || 0) > 0,
    }));
    // Een alinea heeft geen index in Word; de eerste met dezelfde tekst is de cursor-alinea.
    const cursor = cur.text ? paras.findIndex((p) => p.text === cur.text) : -1;
    return { paras, cursor };
  });
}

/** Word zoekt niet met jokertekens, maar "^" is wel een speciaal teken. */
export function searchText(s: string): string {
  return s.replace(/\^/g, "^^");
}

/** Zoekt de alinea: eerst op index, anders de eerste met dezelfde tekst. */
export function findParagraph(items: Word.Paragraph[], index: number, text: string): Word.Paragraph | null {
  if (items[index] && items[index].text === text) return items[index];
  return items.find((p) => p.text === text) || null;
}

const MAX_SEARCH = 255; // Word zoekt maximaal 255 tekens

/**
 * Zoekt het bereik van de `occurrence`-de treffer van `quote` in de alinea.
 * Langer dan 255 tekens (bv. een hele lange zin): zoek begin en eind apart en span ertussen.
 */
async function findRange(ctx: Word.RequestContext, p: Word.Paragraph, quote: string, occurrence: number): Promise<Word.Range | null> {
  if (quote.length <= MAX_SEARCH) {
    const hits = p.search(searchText(quote), { matchCase: true });
    hits.load("items");
    await ctx.sync();
    return hits.items[occurrence] || (hits.items.length === 1 ? hits.items[0] : null);
  }
  const heads = p.search(searchText(quote.slice(0, 200)), { matchCase: true });
  const tails = p.search(searchText(quote.slice(-50)), { matchCase: true });
  heads.load("items");
  tails.load("items");
  await ctx.sync();
  const head = heads.items[occurrence] || heads.items[0];
  if (!head || !tails.items.length) return null;
  const rel = tails.items.map((t) => t.compareLocationWith(head));
  await ctx.sync();
  const k = rel.findIndex((r) => r.value === "After" || r.value === "AdjacentAfter");
  if (k < 0) return null;
  return head.getRange("Start").expandTo(tails.items[k].getRange("End"));
}

/**
 * Vervangt de `occurrence`-de treffer van `quote` in de alinea door `replacement`.
 * `insertText(..., "Replace")` behoudt de opmaak van het begin van het bereik.
 */
export async function replaceInParagraph(
  index: number, paraText: string, quote: string, occurrence: number, replacement: string, track: boolean
): Promise<boolean> {
  if (typeof Word === "undefined") return false;
  return Word.run(async (ctx) => {
    const doc = ctx.document;
    let prevMode: Word.ChangeTrackingMode | string | null = null;
    if (track && Office.context.requirements.isSetSupported("WordApi", "1.4")) {
      doc.load("changeTrackingMode");
      await ctx.sync();
      prevMode = doc.changeTrackingMode;
      doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }
    const ps = doc.body.paragraphs;
    ps.load("items/text");
    await ctx.sync();
    const p = findParagraph(ps.items, index, paraText);
    let ok = false;
    if (p) {
      const r = await findRange(ctx, p, quote, occurrence);
      if (r) {
        r.insertText(replacement, "Replace");
        ok = true;
      }
    }
    if (prevMode !== null) doc.changeTrackingMode = prevMode as Word.ChangeTrackingMode;
    await ctx.sync();
    return ok;
  });
}

/** Selecteert de treffer in het document (springen vanuit het zijpaneel). */
export async function selectInParagraph(index: number, paraText: string, quote: string, occurrence: number): Promise<boolean> {
  if (typeof Word === "undefined") return false;
  return Word.run(async (ctx) => {
    const ps = ctx.document.body.paragraphs;
    ps.load("items/text");
    await ctx.sync();
    const p = findParagraph(ps.items, index, paraText);
    if (!p) return false;
    const r = await findRange(ctx, p, quote, occurrence);
    if (!r) return false;
    r.select();
    await ctx.sync();
    return true;
  }).catch(() => false);
}
