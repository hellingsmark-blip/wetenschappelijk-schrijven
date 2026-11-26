/**
 * Word-koppeling voor selecties: lezen, luisteren naar wijzigingen en vervangen.
 */

/** Huidige geselecteerde tekst ("" als er niets geselecteerd is of buiten Word). */
export async function getSelectionText(): Promise<string> {
  if (typeof Word === "undefined") return "";
  return Word.run(async (ctx) => {
    const r = ctx.document.getSelection();
    r.load("text");
    await ctx.sync();
    return r.text || "";
  }).catch(() => "");
}

/** Roept `cb` aan bij elke selectiewijziging in het document. */
export function onSelectionChanged(cb: () => void): void {
  try {
    Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, cb);
  } catch {
    /* buiten Word */
  }
}

/** Normaliseert tekst voor vergelijking (Word gebruikt \r voor alinea-einden, soms harde spaties). */
export function norm(s: string): string {
  return s.replace(/[\r\n\u000b]+/g, "\n").replace(/ /g, " ").trim();
}

export type ReplaceResult = "replaced" | "found-elsewhere" | "not-found";

/**
 * Vervangt `original` door `replacement`.
 * 1. Als de huidige selectie nog `original` is: die vervangen.
 * 2. Anders: zoeken in het document (Word zoekt maximaal 255 tekens) en de eerste treffer vervangen.
 * `insertText(..., "Replace")` behoudt de opmaak van het begin van het bereik.
 * Met `track = true` wordt de wijziging als bijgehouden wijziging ingevoegd.
 */
export async function replaceText(original: string, replacement: string, track: boolean): Promise<ReplaceResult> {
  return Word.run(async (ctx) => {
    const doc = ctx.document;
    let prevMode: Word.ChangeTrackingMode | string | null = null;
    const canTrack = Office.context.requirements.isSetSupported("WordApi", "1.4");
    if (track && canTrack) {
      doc.load("changeTrackingMode");
      await ctx.sync();
      prevMode = doc.changeTrackingMode;
      doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }

    const sel = doc.getSelection();
    sel.load("text");
    await ctx.sync();

    let target: Word.Range | null = null;
    let result: ReplaceResult = "not-found";
    if (norm(sel.text) === norm(original)) {
      target = sel;
      result = "replaced";
      // Bij een hele alinea (driedubbelklik) zit het alinea-einde in de selectie; dat laten we staan,
      // anders smelt de alinea samen met de volgende.
      if (/\r$/.test(sel.text)) {
        const last = sel.paragraphs.getLast();
        target = sel.getRange("Start").expandTo(last.getRange("Content"));
      }
    } else if (original.length <= 255) {
      const hits = doc.body.search(original.trim(), { matchCase: true });
      hits.load("items");
      await ctx.sync();
      if (hits.items.length) {
        target = hits.items[0];
        result = "found-elsewhere";
      }
    }

    if (target) target.insertText(replacement, "Replace");
    if (prevMode !== null) doc.changeTrackingMode = prevMode as Word.ChangeTrackingMode;
    await ctx.sync();
    return result;
  });
}
