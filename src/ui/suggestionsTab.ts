/**
 * Tabblad Suggesties: alle bevindingen (notatie + live controle), per categorie, met
 * Toepassen / Waarom? / Negeer altijd. Klik = spring naar de plek in het document.
 */
import { formatEur } from "../budget";
import { diffHtml, escapeHtml } from "../diff";
import { Checker, Finding, Mark } from "../features/checker";
import type { CheckKind } from "../features/liveCheck";
import type { Segment } from "../notation/rules";
import { activeProfile, addIgnore, removeIgnore } from "../profiles";
import { CATEGORIES, CategoryId, Settings } from "../settings";
import { onSelectionChanged } from "../word/selection";
import { clearNotationCache } from "../word/notation";
import { annotationsSupported } from "../word/annotations";

interface Ctx {
  settings: () => Settings;
  setStatus: (t: string) => void;
  showTab: (name: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Na ~2,5 s zonder typen of klikken opnieuw controleren. */
const DEBOUNCE_MS = 2500;

let ctxRef: Ctx;
let checker: Checker;
const hiddenCats = new Set<CategoryId>();
let timer: number | undefined;
let focusKey = "";
let pendingJobs: { kind: CheckKind; text: string }[] = [];

function segHtml(segs: Segment[]): string {
  return segs
    .map((s) => (s.script ? `<${s.script}>${escapeHtml(s.text)}</${s.script}>` : escapeHtml(s.text)))
    .join("")
    .replace(/ /g, "&nbsp;");
}

function sugStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $("sugStatus");
  el.textContent = text;
  el.className = "msg muted " + kind;
}

// ---------- Weergave ----------

function renderFilters(): void {
  const box = $("categoryFilters");
  box.innerHTML = "";
  const s = ctxRef.settings();
  CATEGORIES.forEach((c) => {
    if (!s.categories[c.id]) return; // uitgezet in Instellingen
    const n = checker.findings.filter((f) => f.category === c.id).length;
    const chip = document.createElement("button");
    chip.className = "chip" + (hiddenCats.has(c.id) ? " off" : "");
    chip.title = hiddenCats.has(c.id) ? "Klik om weer te tonen" : "Klik om te verbergen";
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.label}${n ? ` <b>${n}</b>` : ""}`;
    chip.addEventListener("click", () => {
      if (hiddenCats.has(c.id)) hiddenCats.delete(c.id);
      else hiddenCats.add(c.id);
      render();
    });
    box.append(chip);
  });
}

function itemHtml(f: Finding): string {
  let fix: string;
  if (f.source === "notation" && f.segments) {
    fix = `<span class="before">${escapeHtml(f.quote)}</span> → <span class="after">${segHtml(f.segments)}</span>`;
  } else if (f.replacement) {
    fix = diffHtml(f.quote, f.replacement);
  } else {
    fix = `<mark>${escapeHtml(f.quote)}</mark> <span class="muted">(geen directe vervanging)</span>`;
  }
  return (
    `<div class="item-title">${escapeHtml(f.title)}</div>` +
    `<div class="fix">${fix}</div>` +
    `<div class="context muted">…${escapeHtml(f.before)}<mark>${escapeHtml(f.quote)}</mark>${escapeHtml(f.after)}…</div>` +
    `<div class="why muted ${f.key === focusKey ? "" : "hidden"}">${escapeHtml(f.why)}</div>`
  );
}

function render(): void {
  renderFilters();
  const list = $("sugList");
  list.innerHTML = "";
  const s = ctxRef.settings();
  const visible = checker.findings.filter((f) => !hiddenCats.has(f.category));
  const notationCount = visible.filter((f) => f.source === "notation").length;
  $("applyAllNotation").classList.toggle("hidden", notationCount < 2);

  const info = $("liveInfo");
  info.textContent = !s.features.live
    ? "Live controle staat uit (Instellingen → Functies)."
    : checker.paused ||
      (annotationsSupported() ? "" : "Je Word-versie ondersteunt geen kronkels; bevindingen staan alleen hier.");
  info.className = "msg " + (checker.paused ? "err" : "muted");

  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = checker.findings.length
      ? "Alle bevindingen zijn verborgen door het filter."
      : "Geen suggesties. Gewijzigde alinea's worden na een korte pauze gecontroleerd.";
    list.append(p);
    return;
  }

  for (const cat of CATEGORIES) {
    const group = visible.filter((f) => f.category === cat.id);
    if (!group.length) continue;
    const head = document.createElement("h3");
    head.innerHTML = `<span class="dot" style="background:${cat.color}"></span> ${cat.label} (${group.length})`;
    list.append(head);

    for (const f of group) {
      const item = document.createElement("div");
      item.className = "item" + (f.key === focusKey ? " focus" : "");
      item.dataset.key = f.key;
      item.style.borderLeftColor = cat.color;
      item.title = "Klik om naar deze plek in het document te gaan";
      item.innerHTML = itemHtml(f);

      const row = document.createElement("div");
      row.className = "row";
      if (f.replacement || f.segments) {
        const apply = document.createElement("button");
        apply.className = "primary";
        apply.textContent = "Toepassen";
        apply.addEventListener("click", (e) => {
          e.stopPropagation();
          void doApply([f], apply);
        });
        row.append(apply);
      }
      const why = document.createElement("button");
      why.className = "link";
      why.textContent = "Waarom?";
      why.addEventListener("click", (e) => {
        e.stopPropagation();
        item.querySelector(".why")!.classList.toggle("hidden");
      });
      const ign = document.createElement("button");
      ign.className = "link";
      ign.textContent = "Negeer altijd";
      ign.title = `"${f.quote}" komt op de negeerlijst van profiel ${activeProfile().name}`;
      ign.addEventListener("click", (e) => {
        e.stopPropagation();
        addIgnore(f.quote);
        renderIgnoreList();
        sugStatus(`"${f.quote}" wordt voortaan genegeerd (terugzetten in tabblad Profiel).`);
        void checker.run();
      });
      row.append(why, ign);
      item.append(row);

      item.addEventListener("click", async () => {
        focusKey = f.key;
        list.querySelectorAll(".item.focus").forEach((x) => x.classList.remove("focus"));
        item.classList.add("focus");
        if (!(await checker.select(f))) {
          sugStatus("Deze tekst is veranderd; ik controleer opnieuw.");
          schedule(0);
        }
      });
      list.append(item);
    }
  }
}

/** Vanuit een kronkel: tabblad openen en de bevinding uitlichten. */
function focusFinding(key: string): void {
  focusKey = key;
  ctxRef.showTab("suggesties");
  hiddenCats.clear();
  render();
  const el = $("sugList").querySelector<HTMLElement>(`.item[data-key="${CSS.escape(key)}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Negeerlijst in het tabblad Profiel (met verwijderknop per item). */
export function renderIgnoreList(): void {
  const box = $("ignoreList");
  if (!box) return;
  box.innerHTML = "";
  const items = activeProfile().ignore;
  if (!items.length) {
    box.innerHTML = `<p class="empty">Nog niets genegeerd.</p>`;
    return;
  }
  items.forEach((t) => {
    const row = document.createElement("div");
    row.className = "row ignore-row";
    const span = document.createElement("span");
    span.textContent = t;
    const del = document.createElement("button");
    del.className = "link";
    del.textContent = "Verwijder";
    del.addEventListener("click", () => {
      removeIgnore(t);
      renderIgnoreList();
      schedule(0);
    });
    row.append(span, del);
    box.append(row);
  });
}

// ---------- Acties ----------

async function doApply(list: Finding[], btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const n = await checker.apply(list);
    const missed = list.length - n;
    sugStatus(
      `${n} ${n === 1 ? "suggestie" : "suggesties"} toegepast` +
        (ctxRef.settings().trackChanges ? " (als bijgehouden wijziging)" : "") +
        (missed ? `; ${missed} niet meer gevonden.` : "."),
      missed ? "err" : "ok"
    );
  } catch (e) {
    sugStatus("Toepassen mislukt: " + String(e), "err");
  } finally {
    btn.disabled = false;
  }
}

/** Voor "Sectie nakijken" in Tools: eerst het document lezen, dan wat er nog te controleren is (+ kosten). */
export async function pendingFor(only?: Set<number>) {
  await checker.run();
  return checker.pendingWholeDocument(only);
}
export function runJobs(jobs: { kind: CheckKind; text: string }[]): void {
  checker.checkWholeDocument(jobs);
}

function showConfirm(): void {
  const { jobs, paragraphs, usd, techCount } = checker.pendingWholeDocument();
  pendingJobs = jobs;
  const box = $("confirmBox");
  if (!jobs.length) {
    box.classList.add("hidden");
    const s = ctxRef.settings();
    sugStatus(
      s.features.live || s.features.technical ? "Alle alinea's zijn al gecontroleerd." : "Controle via Claude staat uit; alleen notatie gecontroleerd.",
      "ok"
    );
    return;
  }
  const eur = usd * ctxRef.settings().usdToEur;
  $("confirmText").textContent =
    `${paragraphs} alinea${paragraphs === 1 ? "" : "'s"} nog niet gecontroleerd` +
    (techCount ? ` (waarvan ${techCount} ook technisch, met Sonnet)` : "") +
    `. Geschatte kosten: hooguit ${formatEur(Math.max(eur, 0.01))}. Doorgaan?`;
  box.classList.remove("hidden");
}

function schedule(delay = DEBOUNCE_MS): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void checker.run(), delay);
}

/** Opnieuw controleren na het omzetten van een schakelaar in Instellingen. */
export function refreshSuggestions(): void {
  renderIgnoreList();
  schedule(0);
}

/** Na het wisselen van profiel: bevindingen opnieuw berekenen. */
export function profileChanged(): void {
  renderIgnoreList();
  clearNotationCache();
  checker.profileChanged();
}

/** Voor de AI-check: zinsmarkeringen in het document (lege map = weghalen) en klikken daarop. */
let aiFocus: ((key: string) => void) | null = null;
export function setAiMarks(marks: Map<string, Mark[]>): void {
  checker.setAiMarks(marks);
}
export function onAiMarkClicked(fn: (key: string) => void): void {
  aiFocus = fn;
}

/** Na het bewerken van het profiel: alles wat al gecontroleerd was vers opnieuw (kost tegoed). */
export function recheckProfile(): void {
  renderIgnoreList();
  checker.profileChanged(true);
}

/** Na het opslaan van een nieuwe key of het verhogen van de limiet. */
export function resumeChecks(): void {
  checker?.resume();
}

export function initSuggestionsTab(ctx: Ctx): void {
  ctxRef = ctx;
  checker = new Checker({
    settings: ctx.settings,
    setStatus: ctx.setStatus,
    onChange: render,
    onMessage: sugStatus,
    onFocus: focusFinding,
    onAiFocus: (k) => aiFocus?.(k),
  });

  $("scanBtn").addEventListener("click", async () => {
    clearNotationCache();
    sugStatus("");
    await checker.run();
    showConfirm();
  });
  $("confirmYes").addEventListener("click", () => {
    $("confirmBox").classList.add("hidden");
    checker.checkWholeDocument(pendingJobs);
    sugStatus("Bezig met controleren… (de voortgang staat onderin)");
  });
  $("confirmNo").addEventListener("click", () => $("confirmBox").classList.add("hidden"));
  $("applyAllNotation").addEventListener("click", () => {
    const btn = $<HTMLButtonElement>("applyAllNotation");
    void doApply(checker.findings.filter((f) => f.source === "notation" && !hiddenCats.has("notatie")), btn);
  });

  // Tijdens typen verandert de selectie ook; na een korte pauze opnieuw controleren.
  onSelectionChanged(() => schedule());
  renderIgnoreList();
  render();
  void checker.init().then(() => checker.run());
}
