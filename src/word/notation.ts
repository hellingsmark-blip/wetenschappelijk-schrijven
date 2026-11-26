/**
 * Word-koppeling voor de notatiecontrole: document scannen, bevinding tonen en toepassen
 * met échte opmaak (font.subscript / font.superscript).
 */
import { checkNotation, NotationFinding } from "../notation/rules";

export interface DocFinding extends NotationFinding {
  /** Index van de alinea in het document op het moment van scannen. */
  para: number;
  id: string;
}

/** Word zoekt niet met jokertekens, maar "^" is wel een speciaal teken. */
function searchText(s: string): string {
  return s.replace(/\^/g, "^^");
}

/**
 * Cache per alineatekst met de bevindingen die de opmaakcontrole al doorstonden.
 * Zo worden bij elke pauze alleen gewijzigde alinea's opnieuw in Word bekeken.
 */
const verified = new Map<string, NotationFinding[]>();
const MAX_SEARCHES_PER_SCAN = 300;

export function clearNotationCache(): void {
  verified.clear();
}

export async function scanDocument(ignore: string[]): Promise<DocFinding[]> {
  if (typeof Word === "undefined") return [];
  return Word.run(async (ctx) => {
    const paras = ctx.document.body.paragraphs;
    paras.load("items/text");
    await ctx.sync();

    // Kandidaten per alinea (puur tekst, snel).
    type Pending = {
      text: string;
      index: number;
      found: NotationFinding[];
      checks: { f: NotationFinding; hits: Word.RangeCollection }[];
      incomplete: boolean; // te veel zoekopdrachten deze ronde; niet cachen
    };
    const pending: Pending[] = [];
    const result: DocFinding[] = [];
    let searches = 0;

    paras.items.forEach((p, i) => {
      const text = p.text || "";
      if (!/\d|[+\-−]/.test(text)) return; // zonder cijfers of tekens geen notatiefouten
      const cached = verified.get(text);
      if (cached) {
        cached.forEach((f) => result.push({ ...f, para: i, id: `${i}:${f.start}:${f.quote}` }));
        return;
      }
      const cands = checkNotation(text);
      if (!cands.length) {
        verified.set(text, []);
        return;
      }
      const pend: Pending = { text, index: i, found: [], checks: [], incomplete: false };
      for (const f of cands) {
        if (!f.needsFormatCheck) pend.found.push(f);
        else if (searches < MAX_SEARCHES_PER_SCAN) {
          searches++;
          const hits = p.search(searchText(f.quote), { matchCase: true });
          hits.load("items");
          pend.checks.push({ f, hits });
        } else pend.incomplete = true;
      }
      pending.push(pend);
    });
    await ctx.sync();

    // Opmaak van de juiste treffer opvragen: staat er al sub/superscript op, dan is het goed.
    const fonts: { pend: Pending; f: NotationFinding; font: Word.Font }[] = [];
    for (const pend of pending) {
      for (const c of pend.checks) {
        const hit = c.hits.items[c.f.occurrence];
        if (!hit) continue;
        hit.font.load("subscript,superscript");
        fonts.push({ pend, f: c.f, font: hit.font });
      }
    }
    await ctx.sync();
    for (const x of fonts) {
      // false = nergens sub/superscript; null = gemengd (dus al deels opgemaakt) → niet melden.
      if (x.font.subscript === false && x.font.superscript === false) x.pend.found.push(x.f);
    }

    for (const pend of pending) {
      pend.found.sort((a, b) => a.start - b.start);
      if (!pend.incomplete) verified.set(pend.text, pend.found);
      pend.found.forEach((f) => result.push({ ...f, para: pend.index, id: `${pend.index}:${f.start}:${f.quote}` }));
    }

    const ignored = new Set(ignore);
    return result.filter((f) => !ignored.has(f.quote)).sort((a, b) => a.para - b.para || a.start - b.start);
  });
}

/**
 * Zet sub/superscript. In Word sluiten die elkaar uit: "superscript = false" zet de tekst terug
 * op de gewone regel en wist dus ook een net gezet subscript. Daarom eerst de andere uitzetten
 * en als laatste de gewenste aanzetten.
 */
function setScript(r: Word.Range, script: "sub" | "sup" | undefined): void {
  if (script === "sub") {
    r.font.superscript = false;
    r.font.subscript = true;
  } else if (script === "sup") {
    r.font.subscript = false;
    r.font.superscript = true;
  } else {
    r.font.subscript = false;
    r.font.superscript = false;
  }
}

/** Zoekt de Word-bereiken van bevindingen (null als de tekst intussen veranderd is). */
async function locate(ctx: Word.RequestContext, list: DocFinding[]): Promise<(Word.Range | null)[]> {
  const paras = ctx.document.body.paragraphs;
  paras.load("items/text");
  await ctx.sync();
  const searches = list.map((f) => {
    const p = paras.items[f.para];
    if (!p || !(p.text || "").includes(f.quote)) return null;
    const hits = p.search(searchText(f.quote), { matchCase: true });
    hits.load("items");
    return hits;
  });
  await ctx.sync();
  return searches.map((h, k) => (h ? h.items[list[k].occurrence] ?? null : null));
}

/** Springt naar de bevinding in het document (selecteert de tekst). */
export async function selectFinding(f: DocFinding): Promise<boolean> {
  if (typeof Word === "undefined") return false;
  return Word.run(async (ctx) => {
    const [r] = await locate(ctx, [f]);
    if (!r) return false;
    r.select();
    await ctx.sync();
    return true;
  }).catch(() => false);
}

/**
 * Past bevindingen toe. Per alinea van achter naar voren, zodat eerdere posities kloppen.
 * Geeft het aantal toegepaste bevindingen terug.
 */
export async function applyFindings(list: DocFinding[], track: boolean): Promise<number> {
  if (typeof Word === "undefined" || !list.length) return 0;
  const sorted = [...list].sort((a, b) => b.para - a.para || b.start - a.start);
  return Word.run(async (ctx) => {
    const doc = ctx.document;
    let prevMode: Word.ChangeTrackingMode | string | null = null;
    if (track && Office.context.requirements.isSetSupported("WordApi", "1.4")) {
      doc.load("changeTrackingMode");
      await ctx.sync();
      prevMode = doc.changeTrackingMode;
      doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }
    const ranges = await locate(ctx, sorted);
    let n = 0;
    ranges.forEach((r, k) => {
      if (!r) return;
      const segs = sorted[k].segments;
      // Eerste stuk vervangt het bereik, de rest komt erachter; opmaak (vet, cursief, lettertype) erft mee.
      let cur = r.insertText(segs[0].text, "Replace");
      setScript(cur, segs[0].script);
      for (const s of segs.slice(1)) {
        cur = cur.insertText(s.text, "After");
        setScript(cur, s.script);
      }
      n++;
    });
    if (prevMode !== null) doc.changeTrackingMode = prevMode as Word.ChangeTrackingMode;
    await ctx.sync();
    // Volgende scan alles opnieuw bekijken: de tekst is soms gelijk gebleven, de opmaak niet.
    clearNotationCache();
    return n;
  });
}
