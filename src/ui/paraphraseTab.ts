/**
 * Tabblad Parafraseer: luistert naar selecties, toont 4 varianten met diff en "Vervang".
 */
import { ClaudeError, } from "../api/claude";
import { canSpend } from "../budget";
import { diffHtml, escapeHtml, wordCount } from "../diff";
import { MAX_WORDS, MIN_WORDS, ParaphraseService } from "../features/paraphrase";
import { activeProfile } from "../profiles";
import type { ParaphraseStyle, ParaphraseVariant } from "../prompts/paraphrase";
import type { Settings } from "../settings";
import { getApiKey } from "../storage";
import { getSelectionText, norm, onSelectionChanged, replaceText } from "../word/selection";

const LABELS: Record<ParaphraseStyle, string> = {
  scientific: "Wetenschappelijker",
  formal: "Formeler",
  concise: "Beknopter",
  cautious: "Voorzichtiger geformuleerd",
};
const DEBOUNCE_MS = 800;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ctx {
  settings: () => Settings;
  save: () => void;
  setStatus: (t: string) => void;
}

const service = new ParaphraseService();
let timer: number | undefined;
let currentRaw = ""; // originele selectie zoals Word hem gaf
let currentNorm = "";
// Tekst die we zelf net invoegden: alleen de selectiegebeurtenis direct na "Vervang" overslaan,
// zodat je dezelfde tekst daarna wél bewust opnieuw kunt selecteren en parafraseren.
let justInserted = "";
let justInsertedAt = 0;
const SKIP_AFTER_REPLACE_MS = 2500;
let requestId = 0;

function paraStatus(text: string, kind: "" | "err" | "ok" = ""): void {
  const el = $("paraStatus");
  el.textContent = text;
  el.className = "msg " + kind;
}

function markTab(on: boolean): void {
  const tab = document.querySelector<HTMLElement>('.tabs button[data-tab="parafraseer"]');
  if (tab) tab.classList.toggle("has-news", on && !tab.classList.contains("active"));
}

function render(variants: ParaphraseVariant[], ctx: Ctx): void {
  const box = $("paraResults");
  box.innerHTML = "";
  const origWords = wordCount(currentRaw);
  variants.forEach((v) => {
    const card = document.createElement("div");
    card.className = "card";
    const words = wordCount(v.text);
    card.innerHTML =
      `<div class="card-head"><strong>${LABELS[v.style]}</strong>` +
      `<span class="muted">${origWords} → ${words} woorden</span></div>` +
      `<div class="diff">${diffHtml(currentRaw.trim(), v.text)}</div>` +
      (v.note ? `<div class="muted note">${escapeHtml(v.note)}</div>` : "");
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "Vervang";
    btn.addEventListener("click", () => doReplace(v, ctx, btn));
    card.append(btn);
    box.append(card);
  });
  $("paraRetry").classList.remove("hidden");
  markTab(true);
}

async function doReplace(v: ParaphraseVariant, ctx: Ctx, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const r = await replaceText(currentRaw, v.text, ctx.settings().trackChanges);
    if (r === "not-found") {
      paraStatus("Kon de oorspronkelijke tekst niet meer vinden. Selecteer hem opnieuw.", "err");
      return;
    }
    justInserted = norm(v.text);
    justInsertedAt = Date.now();
    paraStatus(
      (r === "replaced" ? "Vervangen" : "Vervangen (gevonden in het document)") +
        (ctx.settings().trackChanges ? " als bijgehouden wijziging." : ".") +
        " Selecteer tekst (of klik op 'Parafraseer selectie') voor een nieuwe ronde.",
      "ok"
    );
    $("paraResults").innerHTML = "";
    $("paraRetry").classList.add("hidden");
    $("paraOriginal").classList.add("hidden");
    currentNorm = "";
  } catch (e) {
    paraStatus("Vervangen mislukt: " + String(e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function run(ctx: Ctx, again: boolean): Promise<void> {
  const s = ctx.settings();
  if (!getApiKey()) return paraStatus("Vul eerst je API key in bij Instellingen.", "err");
  if (!canSpend()) return paraStatus("Maandbudget bereikt — parafraseren staat uit.", "err");

  const id = ++requestId;
  const profile = activeProfile();
  const fromCache = !again && service.cached(currentNorm, profile);
  $("paraOriginal").textContent = currentRaw.trim();
  $("paraOriginal").classList.remove("hidden");
  if (!fromCache) {
    paraStatus(again ? "Nieuwe varianten maken…" : "Varianten maken…");
    ctx.setStatus("Parafraseert selectie…");
    $("paraResults").innerHTML = "";
    $("paraRetry").classList.add("hidden");
  }
  try {
    const vs = await service.variants(currentNorm, profile, s.heavyModel, null, again);
    if (id !== requestId) return; // inmiddels een nieuwere selectie
    render(vs, ctx);
    paraStatus(fromCache ? "Uit cache (geen kosten)." : "");
  } catch (e) {
    if (id !== requestId) return;
    paraStatus(e instanceof ClaudeError || e instanceof Error ? e.message : String(e), "err");
  } finally {
    if (id === requestId) ctx.setStatus("Klaar");
  }
}

async function onSelection(ctx: Ctx, manual = false): Promise<void> {
  if (!manual && !ctx.settings().features.paraphrase) return;
  const raw = await getSelectionText();
  const n = norm(raw);
  const wc = wordCount(n);
  if (manual && wc < MIN_WORDS) {
    paraStatus(`Selecteer eerst minstens ${MIN_WORDS} woorden.`, "err");
    return;
  }
  if (wc < MIN_WORDS) return; // te kort: laat huidige resultaten staan
  if (!manual && n === currentNorm) return; // ongewijzigd
  if (!manual && n === justInserted && Date.now() - justInsertedAt < SKIP_AFTER_REPLACE_MS) return;
  justInserted = "";
  if (wc > MAX_WORDS) {
    paraStatus(`Selectie te lang (${wc} woorden, max. ${MAX_WORDS}).`, "err");
    return;
  }
  currentRaw = raw;
  currentNorm = n;
  await run(ctx, false);
}

export function initParaphraseTab(ctx: Ctx): void {
  const toggle = $<HTMLInputElement>("paraToggle");
  toggle.checked = ctx.settings().features.paraphrase;
  toggle.addEventListener("change", () => {
    ctx.settings().features.paraphrase = toggle.checked;
    ctx.save();
    syncFeatureToggle(toggle.checked);
    paraStatus(toggle.checked ? `Selecteer minstens ${MIN_WORDS} woorden in je tekst.` : "Uit — selecties kosten geen tegoed.");
  });
  paraStatus(toggle.checked ? `Selecteer minstens ${MIN_WORDS} woorden in je tekst.` : "Uit — selecties kosten geen tegoed.");

  $("paraRetry").addEventListener("click", () => currentNorm && run(ctx, true));
  $("paraNow").addEventListener("click", () => void onSelection(ctx, true));
  document.querySelector('.tabs button[data-tab="parafraseer"]')?.addEventListener("click", () => markTab(false));

  // Debounce: pas na 0,8 s zonder nieuwe selectiewijziging de selectie lezen.
  onSelectionChanged(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void onSelection(ctx), DEBOUNCE_MS);
  });
}

/** Houdt de schakelaar in Instellingen gelijk met die op het tabblad. */
function syncFeatureToggle(on: boolean): void {
  const cb = document.querySelector<HTMLInputElement>('#featureToggles input[data-feature="paraphrase"]');
  if (cb) cb.checked = on;
}

/** Aangeroepen vanuit Instellingen als de functie daar wordt omgezet. */
export function setParaphraseToggle(on: boolean): void {
  const t = document.getElementById("paraToggle") as HTMLInputElement | null;
  if (t) t.checked = on;
  paraStatus(on ? `Selecteer minstens ${MIN_WORDS} woorden in je tekst.` : "Uit — selecties kosten geen tegoed.");
}
