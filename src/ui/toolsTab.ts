/**
 * Tabblad Tools (fase 6): zeven losse hulpmiddelen. Zware tools tonen vooraf de geschatte kosten.
 */
import { ClaudeError } from "../api/claude";
import { formatEur } from "../budget";
import { escapeHtml, wordCount } from "../diff";
import {
  abbreviationReport, checkFiguresTables, documentText, estimateToolUsd, findTermVariants, sectionRange, shorten,
  supervise, SupervisorResult, TermGroup, translate,
} from "../features/tools";
import { sectionsFor } from "../features/liveCheck";
import { activeProfile, updateActive } from "../profiles";
import type { Settings } from "../settings";
import { readParagraphs, selectInParagraph } from "../word/paragraphs";
import { getSelectionText, norm } from "../word/selection";
import { insertComments, insertTableAtCursor, replaceAllInDocument, replaceOrInsert } from "../word/tools";
import { pendingFor, runJobs } from "./suggestionsTab";

interface Ctx {
  settings: () => Settings;
  setStatus: (t: string) => void;
  showTab: (name: string) => void;
  /** Profiel is aangepast vanuit Tools (woordenlijst/afkortingen). */
  onProfileEdited: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let ctxRef: Ctx;

function toolMsg(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $("toolMsg");
  el.textContent = text;
  el.className = "msg " + kind;
}

function errText(e: unknown): string {
  return e instanceof ClaudeError || e instanceof Error ? e.message : String(e);
}

/** Bevestiging met kostenschatting (in het paneel, geen pop-up). */
function confirmCost(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const box = $("toolConfirm");
    $("toolConfirmText").textContent = text;
    box.classList.remove("hidden");
    box.scrollIntoView({ block: "nearest" });
    const done = (v: boolean) => {
      box.classList.add("hidden");
      $("toolConfirmYes").onclick = null;
      $("toolConfirmNo").onclick = null;
      resolve(v);
    };
    $("toolConfirmYes").onclick = () => done(true);
    $("toolConfirmNo").onclick = () => done(false);
  });
}

const eur = (usd: number) => formatEur(Math.max(usd * ctxRef.settings().usdToEur, 0.01));

/** Voert een tool uit met knop uitgeschakeld en statusregel. */
async function busy(btn: HTMLButtonElement, status: string, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  ctxRef.setStatus(status);
  toolMsg("");
  try {
    await fn();
  } catch (e) {
    toolMsg(errText(e), "err");
  } finally {
    btn.disabled = false;
    ctxRef.setStatus("Klaar");
  }
}

function button(label: string, primary: boolean, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", () => onClick(b));
  return b;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toolMsg("Gekopieerd.", "ok");
  } catch {
    toolMsg("Kopiëren lukt hier niet; selecteer de tekst en gebruik Ctrl+C.", "err");
  }
}

/** Huidige sectie (op basis van de cursor). */
async function currentSection() {
  const { paras, cursor } = await readParagraphs();
  const range = sectionRange(paras, cursor < 0 ? 0 : cursor);
  const items = range.indexes.map((i) => ({ index: i, text: paras[i].text })).filter((p) => p.text.trim());
  return { paras, range, items };
}

// ---------- 1. Vertalen ----------

function initTranslate(): void {
  let original = "";
  $("trUseSel").addEventListener("click", async () => {
    const t = norm(await getSelectionText());
    if (!t) return toolMsg("Selecteer eerst tekst in je document.", "err");
    $<HTMLTextAreaElement>("trInput").value = t;
    original = t;
  });
  $("trGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("trGo");
    const text = $<HTMLTextAreaElement>("trInput").value.trim();
    if (!text) return toolMsg("Typ, plak of selecteer eerst Nederlandse tekst.", "err");
    if (text !== original) original = ""; // zelf getypt: niet in het document vervangen, maar invoegen
    void busy(btn, "Vertaalt…", async () => {
      const r = await translate(text, activeProfile(), ctxRef.settings().heavyModel);
      const box = $("trResult");
      box.innerHTML = `<div class="result">${escapeHtml(r.translation)}</div>` + (r.note ? `<p class="muted">${escapeHtml(r.note)}</p>` : "");
      const row = document.createElement("div");
      row.className = "row";
      row.append(
        button(original ? "Vervang selectie" : "Invoegen bij cursor", true, async (b) => {
          b.disabled = true;
          const how = await replaceOrInsert(original, r.translation, ctxRef.settings().trackChanges).catch((e) => {
            toolMsg(errText(e), "err");
            return null;
          });
          if (how) toolMsg(how === "replaced" ? "Vervangen in het document." : "Ingevoegd achter de cursor.", "ok");
          b.disabled = false;
        }),
        button("Kopieer", false, () => void copy(r.translation))
      );
      box.append(row);
    });
  });
}

// ---------- 2. Sectie nakijken ----------

function initSectionCheck(): void {
  const go = async (btn: HTMLButtonElement, whole: boolean) => {
    await busy(btn, "Leest document…", async () => {
      let only: Set<number> | undefined;
      let label = "het hele document";
      if (!whole) {
        const { range } = await currentSection();
        only = new Set(range.indexes);
        label = range.headingText ? `sectie "${range.headingText}"` : "de sectie waar je cursor staat";
      }
      const p = await pendingFor(only);
      if (!p.jobs.length) {
        toolMsg(`Alles in ${label} is al gecontroleerd; zie Suggesties.`, "ok");
        ctxRef.showTab("suggesties");
        return;
      }
      const ok = await confirmCost(
        `${label[0].toUpperCase() + label.slice(1)}: ${p.paragraphs} alinea${p.paragraphs === 1 ? "" : "'s"} nog niet gecontroleerd` +
          (p.techCount ? ` (waarvan ${p.techCount} technisch)` : "") +
          `. Geschatte kosten: hooguit ${eur(p.usd)}. Doorgaan?`
      );
      if (!ok) return;
      runJobs(p.jobs);
      ctxRef.showTab("suggesties");
    });
  };
  $("scSection").addEventListener("click", () => void go($<HTMLButtonElement>("scSection"), false));
  $("scDoc").addEventListener("click", () => void go($<HTMLButtonElement>("scDoc"), true));
}

// ---------- 3. Begeleidersmodus ----------

const TYPE_NL: Record<string, string> = {
  logic: "Logica",
  support: "Onderbouwing",
  transition: "Overgang",
  structure: "Structuur",
  other: "Overig",
};

function renderSupervisor(r: SupervisorResult, texts: Map<number, string>): void {
  const box = $("svResult");
  box.innerHTML = r.summary ? `<div class="result">${escapeHtml(r.summary)}</div>` : "";
  if (!r.comments.length) {
    box.insertAdjacentHTML("beforeend", `<p class="empty">Geen opmerkingen.</p>`);
    return;
  }
  for (const c of r.comments) {
    const item = document.createElement("div");
    item.className = "item";
    item.title = "Klik om naar deze plek te gaan";
    item.innerHTML =
      `<div class="item-title">${TYPE_NL[c.type] || "Opmerking"}</div>` +
      `<div>${escapeHtml(c.comment)}</div>` +
      `<div class="context muted">“${escapeHtml(c.quote)}”</div>`;
    item.addEventListener("click", () => void selectInParagraph(c.para, texts.get(c.para) || "", c.quote, 0));
    box.append(item);
  }
  const row = document.createElement("div");
  row.className = "row";
  row.append(
    button("Als Word-opmerkingen invoegen", true, async (b) => {
      b.disabled = true;
      try {
        const n = await insertComments(
          r.comments.map((c) => ({ para: c.para, paraText: texts.get(c.para) || "", quote: c.quote, text: `[Begeleidersmodus] ${c.comment}` }))
        );
        toolMsg(`${n} opmerking${n === 1 ? "" : "en"} ingevoegd in het document.`, "ok");
      } catch (e) {
        toolMsg(errText(e), "err");
      }
      b.disabled = false;
    })
  );
  box.append(row);
}

function initSupervisor(): void {
  $("svGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("svGo");
    void busy(btn, "Leest sectie…", async () => {
      const { range, items } = await currentSection();
      if (!items.length) return toolMsg("Zet je cursor in een sectie met tekst.", "err");
      const chars = items.reduce((n, p) => n + p.text.length, 0);
      const model = ctxRef.settings().heavyModel;
      const ok = await confirmCost(
        `Begeleidersmodus voor ${range.headingText ? `"${range.headingText}"` : "deze sectie"} ` +
          `(${items.length} alinea's, ${wordCount(items.map((p) => p.text).join(" "))} woorden). ` +
          `Geschatte kosten: hooguit ${eur(estimateToolUsd(model, chars, 4000))}. Doorgaan?`
      );
      if (!ok) return;
      ctxRef.setStatus("Begeleider leest mee…");
      const r = await supervise(range.headingText, items, activeProfile(), model);
      renderSupervisor(r, new Map(items.map((p) => [p.index, p.text])));
    });
  });
}

// ---------- 4. Inkorten ----------

function initShorten(): void {
  let original = "";
  const useSel = async () => {
    original = norm(await getSelectionText());
    const n = wordCount(original);
    $("shCount").textContent = original ? `Selectie: ${n} woorden` : "Niets geselecteerd.";
    const max = $<HTMLInputElement>("shMax");
    if (original && !max.value) max.value = String(Math.max(5, Math.round((n * 0.8) / 5) * 5));
  };
  $("shUseSel").addEventListener("click", () => void useSel());
  $("shGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("shGo");
    void busy(btn, "Kort in…", async () => {
      if (!original) await useSel();
      if (!original) return toolMsg("Selecteer eerst de tekst die korter moet.", "err");
      const max = Number($<HTMLInputElement>("shMax").value);
      if (!(max >= 5)) return toolMsg("Vul een maximum aantal woorden in.", "err");
      const before = wordCount(original);
      if (before <= max) return toolMsg(`De selectie heeft al ${before} woorden (≤ ${max}).`, "ok");
      const r = await shorten(original, max, activeProfile(), ctxRef.settings().heavyModel);
      const box = $("shResult");
      const over = r.words > max;
      box.innerHTML =
        `<p class="${over ? "err-fg" : "ok-fg"}">${before} → ${r.words} woorden (doel ≤ ${max})${over ? " — nog te lang" : ""}</p>` +
        `<div class="result">${escapeHtml(r.text)}</div>` +
        (r.removed ? `<p class="muted">${escapeHtml(r.removed)}</p>` : "");
      const row = document.createElement("div");
      row.className = "row";
      const orig = original;
      row.append(
        button("Vervang", true, async (b) => {
          b.disabled = true;
          const how = await replaceOrInsert(orig, r.text, ctxRef.settings().trackChanges).catch((e) => {
            toolMsg(errText(e), "err");
            return null;
          });
          if (how === "replaced") toolMsg("Vervangen in het document.", "ok");
          else if (how) toolMsg("Oorspronkelijke tekst niet meer gevonden; ingevoegd achter de cursor.", "err");
          b.disabled = false;
        }),
        button("Kopieer", false, () => void copy(r.text))
      );
      box.append(row);
      original = "";
      $("shCount").textContent = "";
    });
  });
}

// ---------- 5. Figuren & tabellen ----------

function initFigures(): void {
  $("ftGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("ftGo");
    void busy(btn, "Controleert figuren en tabellen…", async () => {
      const { paras } = await readParagraphs();
      const r = checkFiguresTables(paras);
      const box = $("ftResult");
      box.innerHTML =
        `<p class="muted">Gevonden bijschriften — figuren: ${r.figures.join(", ") || "geen"}; tabellen: ${r.tables.join(", ") || "geen"}.</p>`;
      if (!r.figures.length && !r.tables.length) {
        box.insertAdjacentHTML("beforeend", `<p class="empty">Geen bijschriften gevonden. Gebruik in Word Verwijzingen → Bijschrift invoegen, of begin het bijschrift met "Figure 1." / "Table 1.".</p>`);
        return;
      }
      if (!r.issues.length) {
        box.insertAdjacentHTML("beforeend", `<p class="ok-fg">Alles in orde: elk figuur en elke tabel wordt genoemd en de nummering klopt.</p>`);
        return;
      }
      for (const is of r.issues) {
        const item = document.createElement("div");
        item.className = "item";
        item.textContent = is.message;
        item.title = "Klik om naar deze plek te gaan";
        item.addEventListener("click", () => void selectInParagraph(is.para, paras[is.para].text, is.quote, 0));
        box.append(item);
      }
    });
  });
}

// ---------- 6. Afkortingenlijst ----------

function initAbbreviations(): void {
  $("abGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("abGo");
    void busy(btn, "Verzamelt afkortingen…", async () => {
      const { paras } = await readParagraphs();
      const list = abbreviationReport(paras, activeProfile());
      const box = $("abResult");
      if (!list.length) {
        box.innerHTML = `<p class="empty">Geen afkortingen gevonden.</p>`;
        return;
      }
      const status = (s: string) =>
        s === "defined"
          ? `<span class="ok-fg">✓ bij eerste gebruik</span>`
          : s === "later"
            ? `<span class="err-fg">⚠ pas later uitgeschreven</span>`
            : `<span class="err-fg">⚠ niet uitgeschreven</span>`;
      box.innerHTML =
        `<table class="abbr-table"><tr><th>Afk.</th><th>Voluit</th><th>×</th><th>Status</th></tr>` +
        list
          .map(
            (a, k) =>
              `<tr data-k="${k}" style="cursor:pointer" title="Klik om naar het eerste gebruik te gaan"><td><b>${escapeHtml(a.abbr)}</b></td>` +
              `<td>${escapeHtml(a.full) || '<span class="muted">?</span>'}</td><td>${a.count}</td><td>${status(a.status)}</td></tr>`
          )
          .join("") +
        `</table>`;
      box.querySelectorAll<HTMLTableRowElement>("tr[data-k]").forEach((tr) => {
        const a = list[Number(tr.dataset.k)];
        tr.addEventListener("click", () => void selectInParagraph(a.firstPara, paras[a.firstPara].text, a.abbr, 0));
      });
      const row = document.createElement("div");
      row.className = "row";
      row.append(
        button("Lijst invoegen bij cursor", true, async (b) => {
          b.disabled = true;
          try {
            const rows = [["Abbreviation", "Definition"], ...list.map((a) => [a.abbr, a.full || "…"])];
            await insertTableAtCursor(rows, ctxRef.settings().trackChanges);
            toolMsg("Afkortingenlijst ingevoegd onder de cursor.", "ok");
          } catch (e) {
            toolMsg(errText(e), "err");
          }
          b.disabled = false;
        })
      );
      const fromText = list.filter((a) => a.fromText && a.full);
      if (fromText.length) {
        row.append(
          button(`${fromText.length} nieuwe in profiel zetten`, false, (b) => {
            updateActive((p) => fromText.forEach((a) => p.abbreviations.push({ short: a.abbr, full: a.full })));
            b.disabled = true;
            toolMsg(`Toegevoegd aan profiel ${activeProfile().name}: ${fromText.map((a) => a.abbr).join(", ")}.`, "ok");
            ctxRef.onProfileEdited();
          })
        );
      }
      box.append(row);
    });
  });
}

// ---------- 7. Termconsistentie ----------

function renderTerms(groups: TermGroup[], skip: Set<number>): void {
  const box = $("tcResult");
  if (!groups.length) {
    box.innerHTML = `<p class="ok-fg">Geen inconsistente termen gevonden.</p>`;
    return;
  }
  box.innerHTML = "";
  for (const g of groups) {
    const item = document.createElement("div");
    item.className = "item";
    item.style.cursor = "default";
    item.innerHTML =
      `<div class="item-title">${escapeHtml(g.preferred)} <span class="muted">(${g.preferredCount}×)</span></div>` +
      `<div>Varianten: ${g.variants.map((v) => `${escapeHtml(v.text)} <span class="muted">(${v.count}×)</span>`).join(", ")}</div>` +
      (g.explanation ? `<div class="muted">${escapeHtml(g.explanation)}</div>` : "");
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      button("Vervang door voorkeur", true, async (b) => {
        b.disabled = true;
        try {
          let n = 0;
          for (const v of g.variants) n += await replaceAllInDocument(v.text, g.preferred, ctxRef.settings().trackChanges, skip);
          toolMsg(`${n} keer vervangen door "${g.preferred}" (definities bij eerste gebruik en literatuurlijst overgeslagen).`, "ok");
        } catch (e) {
          toolMsg(errText(e), "err");
          b.disabled = false;
        }
      }),
      button("In woordenlijst", false, (b) => {
        updateActive((p) => {
          const existing = p.glossary.find((x) => x.preferred.toLowerCase() === g.preferred.toLowerCase());
          const avoid = g.variants.map((v) => v.text);
          if (existing) existing.avoid = [...new Set([...existing.avoid, ...avoid])];
          else p.glossary.push({ preferred: g.preferred, avoid });
        });
        b.disabled = true;
        toolMsg(`"${g.preferred}" staat nu in de woordenlijst; de live controle let er voortaan op.`, "ok");
        ctxRef.onProfileEdited();
      })
    );
    item.append(row);
    box.append(item);
  }
}

function initTerms(): void {
  $("tcGo").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("tcGo");
    void busy(btn, "Leest document…", async () => {
      const { paras } = await readParagraphs();
      const text = documentText(paras);
      if (!text) return toolMsg("Het document is leeg.", "err");
      const model = ctxRef.settings().heavyModel;
      const ok = await confirmCost(
        `Termconsistentie voor het hele document (${wordCount(text)} woorden). ` +
          `Geschatte kosten: hooguit ${eur(estimateToolUsd(model, text.length, 3000))}. Doorgaan?`
      );
      if (!ok) return;
      ctxRef.setStatus("Zoekt termvarianten…");
      const groups = await findTermVariants(text, activeProfile(), model);
      const sections = sectionsFor(paras);
      const skip = new Set(paras.map((_, i) => i).filter((i) => sections[i] === "References"));
      renderTerms(groups, skip);
    });
  });
}

export function initToolsTab(ctx: Ctx): void {
  ctxRef = ctx;
  initTranslate();
  initSectionCheck();
  initSupervisor();
  initShorten();
  initFigures();
  initAbbreviations();
  initTerms();
}
