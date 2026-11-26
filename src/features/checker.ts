/**
 * Regelt de controle van het document (fase 4):
 *  - leest de alinea's, bepaalt secties en het eerste gebruik van afkortingen;
 *  - notatie (lokaal) en live controle (Claude) per alinea, met cache per alineatekst;
 *  - zet de kronkels in Word en houdt bij welke kronkel bij welke bevinding hoort.
 *
 * Wanneer kost het tegoed? Alleen voor alinea's die je na het openen wijzigt of toevoegt,
 * na "Controleer hele document", of na het wisselen van profiel. Eerder gecontroleerde
 * alinea's komen gratis uit de cache (ook na heropenen van Word).
 */
import { ClaudeError } from "../api/claude";
import { canSpend } from "../budget";
import { Segment, plainText } from "../notation/rules";
import { activeProfile, Profile } from "../profiles";
import { CategoryId, Settings } from "../settings";
import { getApiKey } from "../storage";
import {
  annotationsSupported, clearAllCritiques, Color, critiqueText, deleteCritique, ParagraphCritiques,
  registerAnnotationEvents, setCritiques,
} from "../word/annotations";
import { applyFindings, DocFinding, scanDocument } from "../word/notation";
import { readParagraphs, replaceInParagraph, selectInParagraph } from "../word/paragraphs";
import {
  CheckContext, CheckKind, estimateUsd, firstUseInfo, hash, LiveItem, LiveService, occurrenceAt, ParaInfo, sectionsFor,
  shouldSkip,
} from "./liveCheck";
import { needsTechnical, quantitativeStatements } from "../prompts/technical";
import type { FirstUse } from "../prompts/liveCheck";

/** Eén bevinding zoals het zijpaneel hem toont. */
export interface Finding {
  key: string;
  source: "live" | "notation";
  category: CategoryId;
  para: number;
  paraText: string;
  quote: string;
  start: number;
  length: number;
  occurrence: number;
  /** Platte vervangtekst ("" = geen directe vervanging). */
  replacement: string;
  /** Alleen bij notatie: vervanging met sub/superscript. */
  segments?: Segment[];
  title: string;
  why: string;
  before: string;
  after: string;
  notation?: DocFinding;
}

/** Kleur van de kronkel per categorie (Word kent maar vijf kleuren). */
export const SQUIGGLE: Record<CategoryId, Color> = {
  taal: "Red",
  stijl: "Blue",
  claim: "Lavender",
  helderheid: "Berry",
  consistentie: "Green",
  technisch: "Lavender",
  notatie: "Green",
};

export interface CheckerHooks {
  settings: () => Settings;
  setStatus: (t: string) => void;
  onChange: () => void;
  onMessage: (text: string, kind: "" | "ok" | "err") => void;
  onFocus: (key: string) => void;
}

const CONCURRENCY = 3;
const jobKey = (kind: CheckKind, text: string) => kind + "\u0000" + text;
const SENTENCE_END = /[.!?:;)"'”’]\s*$/;

export class Checker {
  readonly live = new LiveService();
  findings: Finding[] = [];
  /** Aantal alinea's dat nu bij Claude ligt. */
  busy = 0;
  paused = "";
  private hardStop = "";

  private paras: ParaInfo[] = [];
  private sections: (string | null)[] = [];
  private firstUse: FirstUse[] = [];
  private seenAtOpen: Set<string> | null = null;
  /** Taak (soort + tekst) → true = cache negeren, false = alleen controleren als er nog niets is. */
  private forced = new Map<string, boolean>();
  private checkedTexts = new Set<string>();
  private inFlight = new Set<string>();
  private queue: { kind: CheckKind; text: string; index: number; force: boolean }[] = [];
  private quantInput: { text: string; section: string | null; skip: boolean }[] = [];
  private dismissed = new Set<string>();
  private critSig = new Map<number, string>();
  private annToKey = new Map<string, string>();
  private keyToAnn = new Map<string, string>();
  private running = false;
  private again = false;
  private firstRun = true;
  private refreshTimer: number | undefined;

  constructor(private h: CheckerHooks) {}

  async init(): Promise<void> {
    await registerAnnotationEvents(
      (id) => {
        const k = this.annToKey.get(id);
        if (k) this.h.onFocus(k);
      },
      (id, action, suggestion) => void this.onPopupAction(id, action, suggestion)
    );
  }

  private liveOn(): boolean {
    return this.h.settings().features.live;
  }
  private notationOn(): boolean {
    const s = this.h.settings();
    return s.features.notation && s.categories.notatie;
  }

  private techOn(): boolean {
    const s = this.h.settings();
    return s.features.technical && s.categories.technisch;
  }

  private kinds(): CheckKind[] {
    const k: CheckKind[] = [];
    if (this.liveOn()) k.push("live");
    if (this.techOn()) k.push("tech");
    return k;
  }

  private ctxFor(i: number, profile: Profile, kind: CheckKind = "live"): CheckContext {
    const s = this.h.settings();
    return {
      kind,
      profile,
      model: kind === "tech" ? s.heavyModel : s.liveModel,
      section: this.sections[i],
      firstUse: this.firstUse[i],
    };
  }

  /** Eén ronde: lezen, lokale controles, cache, wachtrij vullen, kronkels bijwerken. */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.cycle();
    } catch (e) {
      this.h.onMessage("Controle mislukt: " + String(e), "err");
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    }
  }

  private async cycle(): Promise<void> {
    const { paras, cursor } = await readParagraphs();
    this.paras = paras;
    this.sections = sectionsFor(paras);
    this.firstUse = firstUseInfo(paras.map((p) => p.text));
    if (!this.seenAtOpen) this.seenAtOpen = new Set(paras.map((p) => p.text));
    if (this.firstRun) {
      this.firstRun = false;
      // Kronkels van een eerder geopend zijpaneel opruimen (ze staan niet in het .docx).
      await clearAllCritiques().catch(() => undefined);
    }

    const profile = activeProfile();
    const settings = this.h.settings();
    const ignored = new Set(profile.ignore);
    const out: Finding[] = [];

    // 1. Notatie (lokaal, gratis)
    if (this.notationOn()) {
      for (const f of await scanDocument(profile.ignore)) {
        const paraText = paras[f.para]?.text ?? "";
        out.push({
          key: `n:${hash(paraText)}:${f.start}:${f.quote}`,
          source: "notation",
          category: "notatie",
          para: f.para,
          paraText,
          quote: f.quote,
          start: f.start,
          length: f.quote.length,
          occurrence: f.occurrence,
          replacement: plainText(f.segments),
          segments: f.segments,
          title: f.title,
          why: f.why,
          before: f.before,
          after: f.after,
          notation: f,
        });
      }
    }

    // 2. Live + technische controle: cache gebruiken, gewijzigde alinea's in de wachtrij
    this.paused = this.hardStop;
    const kinds = this.kinds();
    this.quantInput = paras.map((p, i) => ({ text: p.text, section: this.sections[i], skip: shouldSkip(p, this.sections[i]) }));
    if (kinds.length) {
      if (this.hardStop) {
        /* gestopt na een key-fout; hervat na opslaan van een nieuwe key */
      } else if (!getApiKey()) this.paused = "Controle via Claude wacht op een API key (Instellingen).";
      else if (!canSpend()) this.paused = "Maandbudget bereikt — controle via Claude staat stil. Notatie werkt nog wel.";
      paras.forEach((p, i) => {
        if (this.quantInput[i].skip) return;
        for (const kind of kinds) {
          if (kind === "tech" && !needsTechnical(p.text)) continue;
          const c = this.ctxFor(i, profile, kind);
          const jk = jobKey(kind, p.text);
          const force = this.forced.get(jk);
          const hit = this.live.cached(p.text, c);
          if (hit) {
            this.checkedTexts.add(p.text);
            hit.forEach((it) => out.push(this.liveFinding(it, i, p.text)));
            if (force !== true) {
              this.forced.delete(jk);
              continue;
            }
          }
          if (this.paused) continue;
          const changed = !this.seenAtOpen!.has(p.text) || force !== undefined;
          // Technisch pas als je de alinea verlaat; de rest zodra de zin af is.
          const wait = i === cursor && (kind === "tech" || !SENTENCE_END.test(p.text));
          if (changed && !wait && !this.inFlight.has(jk) && !this.queue.some((q) => jobKey(q.kind, q.text) === jk)) {
            this.queue.push({ kind, text: p.text, index: i, force: force === true });
          }
        }
      });
    }

    // 3. Filteren: categorie aan, niet genegeerd, niet weggeklikt
    this.findings = out
      .filter((f) => settings.categories[f.category] && !ignored.has(f.quote) && !this.dismissed.has(f.key))
      .sort((a, b) => a.para - b.para || a.start - b.start);

    await this.updateSquiggles();
    this.h.onChange();
    this.pump();
  }

  private liveFinding(it: LiveItem, i: number, text: string): Finding {
    return {
      key: `l:${hash(text)}:${it.start}:${it.quote}:${it.title}`,
      source: "live",
      category: it.category,
      para: i,
      paraText: text,
      quote: it.quote,
      start: it.start,
      length: it.length,
      occurrence: occurrenceAt(text, it.quote, it.start),
      replacement: it.replacement,
      title: it.title,
      why: it.explanation,
      before: text.slice(Math.max(0, it.start - 30), it.start),
      after: text.slice(it.start + it.length, it.start + it.length + 30),
    };
  }

  /** Wachtrij afwerken met maximaal 3 tegelijk. */
  private pump(): void {
    while (this.busy < CONCURRENCY && this.queue.length && !this.paused) {
      const job = this.queue.shift()!;
      const i = this.paras[job.index]?.text === job.text ? job.index : this.paras.findIndex((p) => p.text === job.text);
      if (i < 0) continue; // alinea bestaat niet meer
      const profile = activeProfile();
      const prev = this.paras.slice(0, i).reverse().find((p) => p.text.trim())?.text.slice(-300) ?? "";
      const jk = jobKey(job.kind, job.text);
      this.busy++;
      this.inFlight.add(jk);
      this.status();
      this.live
        .check({
          ...this.ctxFor(i, profile, job.kind),
          text: job.text,
          previous: prev,
          elsewhere: job.kind === "tech" ? quantitativeStatements(this.quantInput, i) : undefined,
          force: job.force,
        })
        .then(() => {
          this.forced.delete(jk);
          this.refreshSoon();
        })
        .catch((e) => this.onError(e))
        .finally(() => {
          this.busy--;
          this.inFlight.delete(jk);
          this.status();
          this.pump();
        });
    }
  }

  private status(): void {
    this.h.setStatus(this.busy ? `Controleert ${this.busy + this.queue.length} alinea${this.busy + this.queue.length === 1 ? "" : "'s"}…` : "Klaar");
  }

  private onError(e: unknown): void {
    if (e instanceof ClaudeError && ["auth", "no-key", "budget"].includes(e.kind)) {
      this.queue = [];
      this.paused = e.message;
      if (e.kind !== "budget") this.hardStop = e.message; // budget wordt elke ronde opnieuw bekeken
    }
    this.h.onMessage(e instanceof Error ? e.message : String(e), "err");
  }

  private refreshSoon(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.run(), 300);
  }

  /** Kronkels alleen opnieuw zetten voor alinea's waarvan de bevindingen veranderd zijn. */
  private async updateSquiggles(): Promise<void> {
    if (!annotationsSupported()) return;
    const per = new Map<number, Finding[]>();
    this.findings.forEach((f) => {
      if (!per.has(f.para)) per.set(f.para, []);
      per.get(f.para)!.push(f);
    });
    const updates: ParagraphCritiques[] = [];
    const keysPerPara = new Map<number, string[]>();
    this.paras.forEach((p, i) => {
      const list = per.get(i) || [];
      // Kronkels mogen elkaar niet overlappen; de eerste wint (de rest staat wel in het zijpaneel).
      const chosen: Finding[] = [];
      let end = -1;
      for (const f of list) {
        if (f.start < end || f.start + f.length > p.text.length || f.length <= 0) continue;
        chosen.push(f);
        end = f.start + f.length;
      }
      const sig = p.text + "\u0000" + chosen.map((f) => f.key).join("|");
      if (this.critSig.get(i) === sig) return;
      if (!chosen.length && !this.critSig.has(i)) {
        this.critSig.set(i, sig);
        return; // er stond nog niets
      }
      this.critSig.set(i, sig);
      updates.push({
        index: i,
        text: p.text,
        critiques: chosen.map((f) => ({
          start: f.start,
          length: f.length,
          color: SQUIGGLE[f.category],
          // Notatie past opmaak toe; die kan de pop-up niet tonen, dus daar geen suggestie.
          suggestion: f.source === "live" && f.replacement ? f.replacement : undefined,
        })),
      });
      keysPerPara.set(i, chosen.map((f) => f.key));
    });
    if (!updates.length) return;
    try {
      const ids = await setCritiques(updates);
      ids.forEach((list, i) => {
        const keys = keysPerPara.get(i) || [];
        list.forEach((id, k) => {
          if (!keys[k]) return;
          this.annToKey.set(id, keys[k]);
          this.keyToAnn.set(keys[k], id);
        });
      });
    } catch (e) {
      updates.forEach((u) => this.critSig.delete(u.index));
      this.h.onMessage("Kronkels zetten mislukt: " + String(e), "err");
    }
  }

  // ---------- Acties vanuit zijpaneel of pop-up ----------

  async select(f: Finding): Promise<boolean> {
    return selectInParagraph(f.para, f.paraText, f.quote, f.occurrence);
  }

  async apply(list: Finding[]): Promise<number> {
    const track = this.h.settings().trackChanges;
    const profile = activeProfile();
    let n = 0;
    // Notatie in één keer (met echte sub/superscript-opmaak)
    const notation = list.filter((f) => f.source === "notation" && f.notation);
    if (notation.length) {
      n += await applyFindings(notation.map((f) => f.notation!), track);
      // Tekst veranderd (bv. spatie toegevoegd)? Dan de live-cache meenemen naar de nieuwe tekst.
      const byPara = new Map<number, Finding[]>();
      notation.forEach((f) => byPara.set(f.para, [...(byPara.get(f.para) || []), f]));
      byPara.forEach((fs, i) => {
        let text = fs[0].paraText;
        for (const f of [...fs].sort((a, b) => b.start - a.start)) {
          if (f.replacement === f.quote) continue;
          this.transferAll(text, i, profile, f.start, f.length, f.replacement);
          text = text.slice(0, f.start) + f.replacement + text.slice(f.start + f.length);
        }
      });
    }
    // Live: tekst vervangen
    for (const f of list.filter((x) => x.source === "live" && x.replacement)) {
      const ok = await replaceInParagraph(f.para, f.paraText, f.quote, f.occurrence, f.replacement, track);
      if (ok) {
        n++;
        this.transferAll(f.paraText, f.para, profile, f.start, f.length, f.replacement);
        const id = this.keyToAnn.get(f.key);
        if (id) await deleteCritique(id);
      }
    }
    await this.run();
    return n;
  }

  /** Cache van live én technische controle meenemen naar de nieuwe alineatekst. */
  private transferAll(oldText: string, i: number, profile: Profile, start: number, len: number, newPart: string): void {
    for (const kind of ["live", "tech"] as CheckKind[]) {
      this.live.transfer(oldText, this.ctxFor(i, profile, kind), start, len, newPart);
    }
  }

  /** Alleen deze sessie niet meer tonen (pop-up "afwijzen"). */
  dismiss(f: Finding): void {
    this.dismissed.add(f.key);
    void this.run();
  }

  private async onPopupAction(id: string, action: string, suggestion: string): Promise<void> {
    const key = this.annToKey.get(id);
    const f = this.findings.find((x) => x.key === key);
    if (!f) return;
    if (action.toLowerCase() === "accept") {
      // Heeft Word de suggestie zelf al ingevuld? Dan alleen de cache bijwerken.
      const now = await critiqueText(id);
      if (now !== null && now === (suggestion || f.replacement) && now !== f.quote) {
        this.transferAll(f.paraText, f.para, activeProfile(), f.start, f.length, now);
        await deleteCritique(id);
        await this.run();
      } else {
        await this.apply([{ ...f, replacement: suggestion || f.replacement }]);
      }
      this.h.onMessage("Suggestie toegepast.", "ok");
    } else {
      await deleteCritique(id);
      this.dismiss(f);
    }
  }

  // ---------- Hele document / profielwissel ----------

  /** Wat nog nooit (met dit profiel) gecontroleerd is, met een kostenschatting per soort. */
  pendingWholeDocument(only?: Set<number>): { jobs: { kind: CheckKind; text: string }[]; paragraphs: number; usd: number; techCount: number } {
    const profile = activeProfile();
    const s = this.h.settings();
    const jobs: { kind: CheckKind; text: string }[] = [];
    const kinds = this.kinds();
    this.paras.forEach((p, i) => {
      if (only && !only.has(i)) return;
      if (shouldSkip(p, this.sections[i])) return;
      for (const kind of kinds) {
        if (kind === "tech" && !needsTechnical(p.text)) continue;
        if (!this.live.cached(p.text, this.ctxFor(i, profile, kind))) jobs.push({ kind, text: p.text });
      }
    });
    const live = jobs.filter((j) => j.kind === "live").map((j) => j.text);
    const tech = jobs.filter((j) => j.kind === "tech").map((j) => j.text);
    const usd = estimateUsd(s.liveModel, live, profile, "live") + estimateUsd(s.heavyModel, tech, profile, "tech", 3000);
    return { jobs, paragraphs: new Set(jobs.map((j) => j.text)).size, usd, techCount: tech.length };
  }

  checkWholeDocument(jobs: { kind: CheckKind; text: string }[]): void {
    jobs.forEach((j) => this.forced.set(jobKey(j.kind, j.text), false));
    void this.run();
  }

  /**
   * Opnieuw controleren wat al gecontroleerd was.
   * `bypassCache` = false na wisselen van profiel (eerder resultaat met dát profiel is prima),
   * true na het bewerken van het profiel (dan willen we een verse controle).
   */
  profileChanged(bypassCache = false): void {
    this.checkedTexts.forEach((t) => {
      for (const kind of this.kinds()) this.forced.set(jobKey(kind, t), bypassCache);
    });
    if (!bypassCache) this.checkedTexts.clear();
    void this.run();
  }

  /** Bv. na het opslaan van een nieuwe API key of het verhogen van de limiet. */
  resume(): void {
    this.hardStop = "";
    this.paused = "";
    void this.run();
  }
}
