/**
 * Word-acties voor het tabblad Tools: invoegen, opmerkingen, tabel, alles vervangen.
 * Alle wijzigingen respecteren de instelling "track changes".
 */
import { matchCase, replaceableOccurrences } from "../features/tools";
import { findParagraph, searchText } from "./paragraphs";
import { replaceText } from "./selection";

/** Zet track changes tijdelijk aan, voert `fn` uit en zet de oude stand terug. */
async function tracked(ctx: Word.RequestContext, track: boolean, fn: () => Promise<void>): Promise<void> {
  const doc = ctx.document;
  let prev: Word.ChangeTrackingMode | string | null = null;
  if (track && Office.context.requirements.isSetSupported("WordApi", "1.4")) {
    doc.load("changeTrackingMode");
    await ctx.sync();
    prev = doc.changeTrackingMode;
    doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
  }
  await fn();
  if (prev !== null) doc.changeTrackingMode = prev as Word.ChangeTrackingMode;
  await ctx.sync();
}

/**
 * Vervangt `original` als die nog geselecteerd is (of in het document staat);
 * anders wordt `text` ingevoegd achter de cursor/selectie.
 */
export async function replaceOrInsert(original: string, text: string, track: boolean): Promise<"replaced" | "inserted"> {
  if (original.trim()) {
    const r = await replaceText(original, text, track);
    if (r !== "not-found") return "replaced";
  }
  await Word.run(async (ctx) => {
    await tracked(ctx, track, async () => {
      ctx.document.getSelection().insertText(text, "After");
    });
  });
  return "inserted";
}

/** Voegt Word-opmerkingen in bij de opgegeven stukjes tekst. Geeft het aantal ingevoegde terug. */
export async function insertComments(list: { para: number; paraText: string; quote: string; text: string }[]): Promise<number> {
  if (!Office.context.requirements.isSetSupported("WordApi", "1.4")) throw new Error("Deze Word-versie kan geen opmerkingen invoegen.");
  return Word.run(async (ctx) => {
    const ps = ctx.document.body.paragraphs;
    ps.load("items/text");
    await ctx.sync();
    const jobs = list.map((c) => {
      const p = findParagraph(ps.items, c.para, c.paraText);
      if (!p) return null;
      const hits = c.quote && c.quote.length <= 255 ? p.search(searchText(c.quote), { matchCase: true }) : null;
      hits?.load("items");
      return { c, p, hits };
    });
    await ctx.sync();
    let n = 0;
    for (const j of jobs) {
      if (!j) continue;
      const range = j.hits && j.hits.items.length ? j.hits.items[0] : j.p.getRange("Content");
      range.insertComment(j.c.text);
      n++;
    }
    await ctx.sync();
    return n;
  });
}

/** Voegt een tabel in onder de alinea waar de cursor staat. */
export async function insertTableAtCursor(rows: string[][], track: boolean): Promise<void> {
  await Word.run(async (ctx) => {
    await tracked(ctx, track, async () => {
      const p = ctx.document.getSelection().paragraphs.getLast();
      p.insertTable(rows.length, rows[0].length, "After", rows);
    });
  });
}

/**
 * Vervangt in het hele document `term` door `preferred` (hoofdletterongevoelig, alleen losse woorden),
 * maar niet de definitie bij eerste gebruik ("membrane aerated biofilm reactor (MABR)") en niet in
 * alinea's uit `skip` (bv. literatuurlijst). Geeft het aantal vervangingen terug.
 */
export async function replaceAllInDocument(term: string, preferred: string, track: boolean, skip: Set<number>): Promise<number> {
  if (!term || term.length > 255) return 0;
  return Word.run(async (ctx) => {
    let n = 0;
    await tracked(ctx, track, async () => {
      const ps = ctx.document.body.paragraphs;
      ps.load("items/text");
      await ctx.sync();
      const jobs: { ok: boolean[]; hits: Word.RangeCollection }[] = [];
      ps.items.forEach((p, i) => {
        if (skip.has(i) || !p.text.toLowerCase().includes(term.toLowerCase())) return;
        const ok = replaceableOccurrences(p.text, term);
        if (!ok.some(Boolean)) return;
        const hits = p.search(searchText(term), { matchCase: false });
        hits.load("items/text");
        jobs.push({ ok, hits });
      });
      await ctx.sync();
      for (const j of jobs) {
        // Word en onze telling vinden dezelfde treffers in dezelfde volgorde (zelfde zoekterm, zonder hoofdletters).
        if (j.hits.items.length !== j.ok.length) continue; // twijfel → deze alinea niet aanraken
        j.hits.items.forEach((h, k) => {
          if (!j.ok[k]) return;
          h.insertText(matchCase(h.text, preferred), "Replace");
          n++;
        });
      }
    });
    return n;
  });
}
