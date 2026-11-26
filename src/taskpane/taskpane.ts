/**
 * Ingang van het zijpaneel: tabbladen, profielkeuze, Instellingen en kostenmeter.
 */
import { AVAILABLE_MODELS } from "../config";
import { formatEur, loadBudget, onBudgetChange, setMonthLimit, statusOf, BudgetState } from "../budget";
import { ClaudeError, testConnection } from "../api/claude";
import { clearApiKey, getApiKey, setApiKey, storageMode } from "../storage";
import { CATEGORIES, FEATURES, loadSettings, saveSettings, Settings } from "../settings";
import { initParaphraseTab, setParaphraseToggle } from "../ui/paraphraseTab";
import { initSuggestionsTab, profileChanged, recheckProfile, refreshSuggestions, resumeChecks } from "../ui/suggestionsTab";
import { initProfileTab, renderProfileTab } from "../ui/profileTab";
import { initToolsTab } from "../ui/toolsTab";
import { initAiCheckTab } from "../ui/aiCheckTab";
import {
  activeProfile, lastDocSaveResult, linkProfileToDocument, loadProfiles, profileForDocument, setActiveProfile,
} from "../profiles";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings = loadSettings();

// ---------- Status in de footer ----------
export function setStatus(text: string): void {
  $("status").textContent = text;
}

// ---------- Tabbladen ----------
function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab as string));
  });
}
function showTab(name: string): void {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}

// ---------- Profielen ----------
function renderProfileSelect(): void {
  const store = loadProfiles();
  const sel = $<HTMLSelectElement>("profileSelect");
  sel.innerHTML = "";
  store.profiles.forEach((p) => sel.add(new Option(p.name, p.name, false, p.name === store.active)));
  renderProfileTab();
}

/** Na elke wissel (menu bovenaan, of nieuw/dupliceer/hernoem/verwijder/import in het tabblad Profiel). */
function onProfileSwitched(): void {
  const name = activeProfile().name;
  linkProfileToDocument(name);
  renderProfileSelect();
  setStatus(`Profiel ${name} actief`);
  setTimeout(renderEnvInfo, 1500); // diagnose bijwerken zodra het opslaan in het document klaar is
  profileChanged(); // bevindingen opnieuw berekenen met het nieuwe profiel
}

function initProfiles(): void {
  // Als dit document al aan een profiel gekoppeld is, dat profiel activeren.
  const linked = profileForDocument();
  if (linked) setActiveProfile(linked);
  $<HTMLSelectElement>("profileSelect").addEventListener("change", (e) => {
    setActiveProfile((e.target as HTMLSelectElement).value);
    onProfileSwitched();
  });
  initProfileTab({ onSwitched: onProfileSwitched, onRecheck: recheckProfile });
  renderProfileSelect();
}

// ---------- API key ----------
function renderKeyBadge(): void {
  const has = !!getApiKey();
  const b = $("apiBadge");
  b.textContent = has ? "API ✓" : "Geen key";
  b.className = "badge " + (has ? "ok" : "missing");
}
function keyMsg(text: string, kind: "ok" | "err" | "" = ""): void {
  const m = $("keyMsg");
  m.textContent = text;
  m.className = "msg " + kind;
}
function initApiKey(): void {
  const input = $<HTMLInputElement>("apiKeyInput");
  if (getApiKey()) input.placeholder = "•••••••• (opgeslagen)";

  $("saveKeyBtn").addEventListener("click", () => {
    const v = input.value.trim();
    if (!v) return keyMsg("Plak eerst je key in het veld.", "err");
    if (!v.startsWith("sk-ant-")) return keyMsg("Dit lijkt geen Claude API key (die begint met sk-ant-).", "err");
    setApiKey(v);
    input.value = "";
    input.placeholder = "•••••••• (opgeslagen)";
    renderKeyBadge();
    keyMsg("Key opgeslagen op deze computer.", "ok");
    resumeChecks();
  });

  $("clearKeyBtn").addEventListener("click", () => {
    clearApiKey();
    input.placeholder = "sk-ant-…";
    renderKeyBadge();
    keyMsg("Key verwijderd.");
  });

  $("testKeyBtn").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("testKeyBtn");
    btn.disabled = true;
    keyMsg("Verbinding testen…");
    setStatus("Test verbinding…");
    try {
      const reply = await testConnection(settings.liveModel);
      keyMsg(`Verbonden met ${settings.liveModel}. Antwoord: "${reply}"`, "ok");
    } catch (e) {
      keyMsg(e instanceof ClaudeError ? e.message : "Onbekende fout: " + String(e), "err");
    } finally {
      btn.disabled = false;
      setStatus("Klaar");
    }
  });
}

// ---------- Overige instellingen ----------
function fillModelSelect(id: string, value: string, onChange: (v: string) => void): void {
  const sel = $<HTMLSelectElement>(id);
  AVAILABLE_MODELS.forEach((m) => sel.add(new Option(m, m, false, m === value)));
  sel.addEventListener("change", () => onChange(sel.value));
}

function toggle(
  container: HTMLElement, label: string, checked: boolean, color: string | null,
  onChange: (v: boolean) => void, feature?: string
): void {
  const l = document.createElement("label");
  l.className = "toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  if (feature) cb.dataset.feature = feature;
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  l.append(cb);
  if (color) {
    const d = document.createElement("span");
    d.className = "dot";
    d.style.background = color;
    l.append(d);
  }
  l.append(document.createTextNode(" " + label));
  container.append(l);
}

function initSettings(): void {
  const save = () => saveSettings(settings);
  fillModelSelect("liveModel", settings.liveModel, (v) => { settings.liveModel = v; save(); });
  fillModelSelect("heavyModel", settings.heavyModel, (v) => { settings.heavyModel = v; save(); });

  const rate = $<HTMLInputElement>("rateInput");
  rate.value = String(settings.usdToEur);
  rate.addEventListener("change", () => {
    const v = Number(rate.value);
    if (v > 0) { settings.usdToEur = v; save(); }
  });

  const limit = $<HTMLInputElement>("limitInput");
  limit.value = String(loadBudget().limitEur);
  limit.addEventListener("change", () => {
    const v = Number(limit.value);
    if (v >= 0) setMonthLimit(v);
  });

  const catBox = $("categoryToggles");
  CATEGORIES.forEach((c) =>
    toggle(catBox, c.label, settings.categories[c.id], c.color, (v) => { settings.categories[c.id] = v; save(); refreshSuggestions(); })
  );
  const featBox = $("featureToggles");
  FEATURES.forEach((f) =>
    toggle(featBox, f.label, settings.features[f.id], null, (v) => {
      settings.features[f.id] = v;
      save();
      if (f.id === "paraphrase") setParaphraseToggle(v);
      if (f.id === "notation" || f.id === "live" || f.id === "technical") refreshSuggestions();
    }, f.id)
  );

  const tc = $<HTMLInputElement>("trackChanges");
  tc.checked = settings.trackChanges;
  tc.addEventListener("change", () => { settings.trackChanges = tc.checked; save(); });

  // De instellingen van de AI-detector worden geregeld in ui/aiCheckTab.ts.
}

// ---------- Budget / kostenmeter ----------
function renderBudget(s: BudgetState = loadBudget()): void {
  const st = statusOf(s);
  const meter = $("costMeter");
  meter.textContent = `${formatEur(s.spentEur)} / ${formatEur(s.limitEur)} deze maand`;
  meter.className = st === "ok" ? "" : st;
  $<HTMLInputElement>("limitInput").value = String(s.limitEur);

  const banner = $("budgetBanner");
  banner.classList.toggle("hidden", st === "ok");
  banner.className = "banner " + (st === "ok" ? "hidden" : st);
  $("budgetBannerText").textContent =
    st === "blocked"
      ? "Maandbudget bereikt — API-functies staan uit. Notatie (lokaal) werkt nog wel."
      : `Let op: je hebt ${Math.round((s.spentEur / s.limitEur) * 100)} % van je maandbudget gebruikt.`;
  $("raiseBtn").classList.toggle("hidden", st !== "blocked");
}

function initBudget(): void {
  onBudgetChange(renderBudget);
  $("raiseBtn").addEventListener("click", () => {
    const s = loadBudget();
    $<HTMLInputElement>("raiseInput").value = String(Math.ceil(s.limitEur + 5));
    $("raiseBox").classList.remove("hidden");
    $("raiseBtn").classList.add("hidden");
  });
  $("raiseConfirm").addEventListener("click", () => {
    const v = Number($<HTMLInputElement>("raiseInput").value);
    if (v > 0) setMonthLimit(v);
    $("raiseBox").classList.add("hidden");
    resumeChecks();
  });
  renderBudget();
}

// ---------- Omgevingsinfo ----------
function renderEnvInfo(): void {
  let text = "Niet in Word geopend (voorbeeldweergave in de browser).";
  try {
    if (Office.context && Office.context.requirements) {
      const has17 = Office.context.requirements.isSetSupported("WordApi", "1.7");
      const has18 = Office.context.requirements.isSetSupported("WordApi", "1.8");
      text =
        `Word ${Office.context.diagnostics?.platform ?? ""} ${Office.context.diagnostics?.version ?? ""}. ` +
        `Kronkels (WordApi 1.7): ${has17 ? "ja" : "nee — val terug op markering in het zijpaneel"}; ` +
        `WordApi 1.8: ${has18 ? "ja" : "nee"}.`;
    }
  } catch {
    /* buiten Office */
  }
  // Diagnose voor het onthouden van instellingen en profielkeuze.
  text +=
    ` | Opslag: ${storageMode}` +
    ` | Profiel in opslag: ${loadProfiles().active}` +
    ` | Profiel in document: ${profileForDocument() ?? "(geen)"}` +
    ` | Opslaan in document: ${lastDocSaveResult}`;
  $("envInfo").textContent = text;
}

function init(): void {
  initTabs();
  initProfiles();
  initApiKey();
  initSettings();
  initBudget();
  initParaphraseTab({ settings: () => settings, save: () => saveSettings(settings), setStatus });
  initSuggestionsTab({ settings: () => settings, setStatus, showTab });
  initToolsTab({ settings: () => settings, setStatus, showTab, onProfileEdited: renderProfileTab });
  initAiCheckTab({ settings: () => settings, save: () => saveSettings(settings), setStatus, showTab });
  renderKeyBadge();
  renderEnvInfo();
  if (!getApiKey()) showTab("instellingen");
}

// Office.onReady werkt ook buiten Word (dan is host null), zodat je het paneel in een browser kunt bekijken.
if (typeof Office !== "undefined" && Office.onReady) {
  Office.onReady(() => init());
} else {
  window.addEventListener("DOMContentLoaded", init);
}
