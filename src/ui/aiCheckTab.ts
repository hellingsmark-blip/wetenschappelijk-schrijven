/**
 * Tabblad AI-check (fase 8): analyse op knopdruk via de eigen detector (lokaal of cloud),
 * met terugval op de lichte modus. Gebruikt geen Claude-tegoed en telt niet mee in het budget.
 */
import { formatEur } from "../budget";
import { escapeHtml } from "../diff";
import { analyze, checkUrl, DetectorConfig, DetectorError, health } from "../aicheck/client";
import { analyzeLight } from "../aicheck/light";
import { AnalysisResult, HealthInfo, LABEL_NL, ParagraphResult, SHORT_TEXT_WORDS, SIGNAL_NL, SignalScore } from "../aicheck/types";
import { documentUnits, sectionUnits, selectionUnits, sentenceSpans, Unit, wordTotal } from "../aicheck/units";
import type { Mark } from "../features/checker";
import { sectionsFor } from "../features/liveCheck";
import type { Settings } from "../settings";
import { clearDetectorToken, getDetectorToken, setDetectorToken } from "../storage";
import { readParagraphs, selectInParagraph } from "../word/paragraphs";
import { getSelectionText } from "../word/selection";
import { onAiMarkClicked, setAiMarks } from "./suggestionsTab";

interface Ctx {
  settings: () => Settings;
  save: () => void;
  setStatus: (t: string) => void;
  showTab: (name: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let ctxRef: Ctx;
let last: { result: AnalysisResult; units: Unit[] } | null = null;
let lastHealth: HealthInfo | null = null;
let pinged = false;

const MODE_NL = { local: "Lokaal", cloud: "Cloud", light: "Lichte modus" } as const;

function cfg(): DetectorConfig {
  const s = ctxRef.settings();
  return { mode: s.detectorMode, localUrl: s.detectorUrl, cloudUrl: s.cloudDetectorUrl, token: getDetectorToken() };
}

function aiMsg(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $("aiMsg");
  el.textContent = text;
  el.className = "msg " + kind;
}

function confirmBox(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    $("aiConfirmText").textContent = text;
    $("aiConfirm").classList.remove("hidden");
    const done = (v: boolean) => {
      $("aiConfirm").classList.add("hidden");
      resolve(v);
    };
    $("aiConfirmYes").onclick = () => done(true);
    $("aiConfirmNo").onclick = () => done(false);
  });
}

// ---------- Status van de detector ----------

function helpText(mode: "local" | "cloud", err: DetectorError | null): string {
  if (mode === "cloud") {
    return err?.kind === "auth"
      ? "Controleer het toegangstoken bij ⚙ Instellingen → AI-detector."
      : "Controleer het adres (https://….modal.run) en het token bij ⚙ Instellingen → AI-detector, en of je Modal-app gedeployed is.";
  }
  return (
    "<b>Detector starten:</b> dubbelklik op het startscript in je detectormap (bv. <code>start-detector.bat</code>) en wacht tot er " +
    "<i>running on https://localhost:8765</i> staat. Klik daarna op <b>Verbinding testen</b>.<br>" +
    "Lukt het niet? Open eenmaal <code>https://localhost:8765/health</code> in Edge. Zie je een certificaatwaarschuwing, laat de detector " +
    "dan het certificaat van <code>office-addin-dev-certs</code> gebruiken (zie docs/detector-api.md).<br>" +
    "Tot die tijd gebruikt de AI-check de <b>lichte modus</b> (indicatief, beperkte betrouwbaarheid)."
  );
}

function renderStatus(h: HealthInfo | null, err: DetectorError | null, checking = false): void {
  const mode = ctxRef.settings().detectorMode;
  const el = $("detStatus");
  const help = $("detHelp");
  if (checking) {
    el.innerHTML = `<span class="dot"></span> Verbinding met ${mode === "cloud" ? "cloud-" : "lokale "}detector testen…`;
    return;
  }
  if (h) {
    el.innerHTML =
      `<span class="dot on"></span> Detector verbonden (${MODE_NL[h.mode]}${h.mode === "cloud" ? (h.warm ? ", warm" : ", koud — start op bij de eerste analyse") : ""}). ` +
      `Modellen: ${escapeHtml(h.models.map((m) => m.name).join(", ") || "onbekend")}` +
      (h.limitRemainingUsd !== null ? ` · resterende cloudlimiet: ${formatEur(h.limitRemainingUsd * ctxRef.settings().usdToEur)}` : "");
    help.classList.add("hidden");
  } else if (err) {
    el.innerHTML = `<span class="dot off"></span> ${err.kind === "not-found" ? "Detector niet gevonden" : escapeHtml(err.message)} — lichte modus wordt gebruikt.`;
    help.innerHTML = helpText(mode, err);
    help.classList.remove("hidden");
  } else {
    el.innerHTML =
      mode === "cloud"
        ? `<span class="dot"></span> Cloud-detector: nog niet getest (een test kan hem opstarten en dat kost een klein bedrag).`
        : `<span class="dot"></span> Lokale detector: nog niet getest.`;
    help.classList.add("hidden");
  }
}

async function ping(): Promise<HealthInfo | null> {
  renderStatus(null, null, true);
  try {
    lastHealth = await health(cfg());
    renderStatus(lastHealth, null);
    return lastHealth;
  } catch (e) {
    lastHealth = null;
    renderStatus(null, e instanceof DetectorError ? e : new DetectorError("not-found", String(e)));
    return null;
  }
}

// ---------- Weergave van het resultaat ----------

const cls = (label?: string) => (label === "ai" ? "s-ai" : label === "uncertain" ? "s-uncertain" : "s-human");
const pct = (x: number) => `${Math.round(x * 100)}%`;

function signalList(s: Record<string, SignalScore>): string {
  const rows = Object.entries(s)
    .filter(([, v]) => v.contribution !== 0 || v.score !== 0.5)
    .sort((a, b) => Math.abs(b[1].contribution) - Math.abs(a[1].contribution))
    .map(([k, v]) => {
      const dir = v.contribution > 0.05 ? "→ AI" : v.contribution < -0.05 ? "→ mens" : "neutraal";
      return `<div>${escapeHtml(SIGNAL_NL[k] || k)}: ${pct(v.score)} <span class="muted">(${dir}, bijdrage ${v.contribution > 0 ? "+" : ""}${v.contribution.toFixed(2)})</span></div>`;
    });
  return rows.length ? rows.join("") : `<div class="muted">Geen signaalinformatie.</div>`;
}

function renderParagraph(p: ParagraphResult, u: Unit | undefined): HTMLElement {
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.pid = p.id;
  const preview = (u?.text || "").slice(0, 90) + ((u?.text.length || 0) > 90 ? "…" : "");
  item.innerHTML =
    `<div class="row" style="margin:0"><span class="score ${cls(p.label)}">${p.score === undefined ? "–" : pct(p.score)}</span>` +
    `<span>${escapeHtml(preview)}</span></div>` +
    (p.score === undefined ? `<div class="muted">Niet beoordeeld (bv. te kort).</div>` : "") +
    `<div class="sents hidden"></div>`;
  const sents = item.querySelector<HTMLElement>(".sents")!;
  p.sentences.forEach((s, k) => {
    const row = document.createElement("div");
    row.className = "sent";
    row.dataset.k = String(k);
    row.innerHTML = `<span class="score ${cls(s.score > 0.65 ? "ai" : s.score >= 0.35 ? "uncertain" : "human")}">${pct(s.score)}</span> ${escapeHtml(s.text)}` +
      `<div class="signals hidden">${signalList(s.signals)}</div>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      row.querySelector(".signals")!.classList.toggle("hidden");
    });
    sents.append(row);
  });
  item.addEventListener("click", () => {
    sents.classList.toggle("hidden");
    if (u) void selectInParagraph(u.para, u.paraText, u.text.slice(0, 255), 0);
  });
  item.title = "Klik: naar de alinea springen en zinnen tonen";
  return item;
}

function renderResult(r: AnalysisResult, units: Unit[]): void {
  const box = $("aiResult");
  const o = r.overall;
  const used = r.mode === "light"
    ? `<b>Lichte modus</b> — indicatief, beperkte betrouwbaarheid`
    : `<b>${MODE_NL[r.mode]}</b> — modellen: ${escapeHtml(r.models.map((m) => m.name + (m.version ? ` (${m.version})` : "")).join(", ") || "onbekend")}`;
  box.innerHTML =
    `<div class="result" style="white-space:normal">` +
    `<div class="ai-label">${LABEL_NL[o.label][0].toUpperCase() + LABEL_NL[o.label].slice(1)} <span class="muted">(${pct(o.score)}, marge ${pct(o.low)}–${pct(o.high)})</span></div>` +
    `<div class="meter"><div class="band" style="left:${o.low * 100}%;width:${Math.max(1, (o.high - o.low) * 100)}%"></div><div class="pin" style="left:calc(${o.score * 100}% - 1px)"></div></div>` +
    `<div class="muted">Berekend met: ${used}` +
    (r.costUsd !== null ? ` · kosten: ${formatEur(r.costUsd * ctxRef.settings().usdToEur)}` : "") +
    (r.elapsedMs !== null ? ` · ${(r.elapsedMs / 1000).toFixed(1)} s` : "") +
    `</div>` +
    r.warnings.map((w) => `<div class="err-fg">⚠ ${escapeHtml(w)}</div>`).join("") +
    `<details><summary>Welke signalen droegen bij?</summary><div class="signals">${signalList(r.signalsOverall)}</div></details>` +
    `</div><h3>Per alinea (${r.paragraphs.length})</h3>`;
  const byId = new Map(units.map((u) => [u.id, u]));
  r.paragraphs.forEach((p) => box.append(renderParagraph(p, byId.get(p.id))));
}

// ---------- Zinsmarkering in het document ----------

function updateMarks(): void {
  const marks = new Map<string, Mark[]>();
  if (ctxRef.settings().aiMarkSentences && last) {
    const byId = new Map(last.units.map((u) => [u.id, u]));
    for (const p of last.result.paragraphs) {
      const u = byId.get(p.id);
      if (!u) continue;
      const spans = sentenceSpans(u.paraText, p.sentences);
      const list = marks.get(u.paraText) || [];
      p.sentences.forEach((s, k) => {
        const sp = spans[k];
        // Alleen zinnen die op AI of "onzeker" wijzen; menselijke zinnen blijven ongemarkeerd.
        if (sp && s.score >= 0.5) list.push({ key: `ai:${p.id}:${k}`, start: sp.start, length: sp.length, color: "Berry" });
      });
      if (list.length) marks.set(u.paraText, list);
    }
  }
  setAiMarks(marks);
}

function focusMark(key: string): void {
  const [, pid, k] = key.split(":");
  ctxRef.showTab("aicheck");
  const item = $("aiResult").querySelector<HTMLElement>(`.item[data-pid="${CSS.escape(pid)}"]`);
  if (!item) return;
  $("aiResult").querySelectorAll(".ai-focus").forEach((x) => x.classList.remove("ai-focus"));
  item.classList.add("ai-focus");
  item.querySelector(".sents")?.classList.remove("hidden");
  const row = item.querySelector<HTMLElement>(`.sent[data-k="${k}"]`);
  row?.querySelector(".signals")?.classList.remove("hidden");
  (row || item).scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- Analyse ----------

async function run(kind: "selection" | "section" | "document", btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  aiMsg("");
  try {
    const { paras, cursor } = await readParagraphs();
    let units: Unit[] = [];
    if (kind === "selection") {
      const sel = await getSelectionText();
      units = selectionUnits(paras, sel);
      if (!units.length) return aiMsg("Selecteer eerst tekst in je document.", "err");
    } else if (kind === "section") {
      units = sectionUnits(paras, cursor).units;
      if (!units.length) return aiMsg("Zet je cursor in een sectie met tekst.", "err");
    } else {
      units = documentUnits(paras);
      if (!units.length) return aiMsg("Het document bevat geen tekst om te analyseren.", "err");
    }
    const section = sectionsFor(paras)[units[0].para];
    const nWords = wordTotal(units);
    const payload = units.map((u) => ({ id: u.id, text: u.text }));

    // 1. Detector proberen (lokaal of cloud); anders lichte modus.
    ctxRef.setStatus("AI-check: detector zoeken…");
    const h = lastHealth && lastHealth.mode === ctxRef.settings().detectorMode ? lastHealth : await ping();
    let result: AnalysisResult;
    if (h) {
      const chars = payload.reduce((n, p) => n + p.text.length, 0);
      if (h.maxChars && chars > h.maxChars) {
        return aiMsg(`Te veel tekst voor de detector (${chars} tekens, max. ${h.maxChars}). Analyseer een sectie of selectie.`, "err");
      }
      if (h.mode === "cloud" && h.costPer1000Words !== null) {
        const eur = (nWords / 1000) * h.costPer1000Words * ctxRef.settings().usdToEur;
        const ok = await confirmBox(`Cloud-analyse van ${nWords} woorden. Geschatte kosten: ${formatEur(Math.max(eur, 0.01))}${h.warm ? "" : " (+ opstarten)"}. Doorgaan?`);
        if (!ok) return;
      }
      if (h.mode === "cloud" && !h.warm) aiMsg("Cloud-detector wordt opgestart…");
      ctxRef.setStatus(`AI-check: analyseert ${nWords} woorden…`);
      try {
        result = await analyze(cfg(), payload, section, (m) => aiMsg(m));
      } catch (e) {
        const err = e instanceof DetectorError ? e : new DetectorError("bad", String(e));
        if (err.kind === "not-found" || err.kind === "cold-timeout") {
          lastHealth = null;
          renderStatus(null, err);
          result = analyzeLight(payload);
        } else throw err;
      }
    } else {
      result = analyzeLight(payload);
    }
    if (result.mode !== "light" && nWords < SHORT_TEXT_WORDS && !result.warnings.some((w) => /kort/i.test(w))) {
      result.warnings.unshift(`Korte tekst (${nWords} woorden, < ${SHORT_TEXT_WORDS}): lage betrouwbaarheid.`);
    }
    last = { result, units };
    renderResult(result, units);
    updateMarks();
    aiMsg("");
  } catch (e) {
    aiMsg(e instanceof Error ? e.message : String(e), "err");
  } finally {
    btn.disabled = false;
    ctxRef.setStatus("Klaar");
  }
}

// ---------- Instellingen (modus, adressen, token) ----------

function syncModeRadios(): void {
  const m = ctxRef.settings().detectorMode;
  document.querySelectorAll<HTMLInputElement>('input[name="detMode"], input[name="detModeSet"]').forEach((r) => (r.checked = r.value === m));
}

function setMode(m: "local" | "cloud"): void {
  ctxRef.settings().detectorMode = m;
  ctxRef.save();
  syncModeRadios();
  lastHealth = null;
  if (m === "local") void ping();
  else renderStatus(null, null);
}

function detMsg(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $("detMsg");
  el.textContent = text;
  el.className = "msg " + (kind || "muted");
}

function initSettings(): void {
  const s = ctxRef.settings();
  const local = $<HTMLInputElement>("detectorUrl");
  const cloud = $<HTMLInputElement>("cloudDetectorUrl");
  local.value = s.detectorUrl;
  cloud.value = s.cloudDetectorUrl;
  local.addEventListener("change", () => {
    const v = local.value.trim().replace(/\/+$/, "");
    const err = checkUrl("local", v);
    if (err) return detMsg(err, "err");
    ctxRef.settings().detectorUrl = v;
    ctxRef.save();
    lastHealth = null;
    detMsg("Lokaal adres opgeslagen.", "ok");
  });
  cloud.addEventListener("change", () => {
    const v = cloud.value.trim().replace(/\/+$/, "");
    const err = v ? checkUrl("cloud", v) : "";
    if (err) return detMsg(err, "err");
    ctxRef.settings().cloudDetectorUrl = v;
    ctxRef.save();
    lastHealth = null;
    detMsg("Cloud-adres opgeslagen.", "ok");
  });
  const tok = $<HTMLInputElement>("detTokenInput");
  if (getDetectorToken()) tok.placeholder = "•••••••• (opgeslagen)";
  $("detTokenSave").addEventListener("click", () => {
    if (!tok.value.trim()) return detMsg("Plak eerst het token in het veld.", "err");
    setDetectorToken(tok.value);
    tok.value = "";
    tok.placeholder = "•••••••• (opgeslagen)";
    lastHealth = null;
    detMsg("Token opgeslagen op deze computer (niet in het document).", "ok");
  });
  $("detTokenClear").addEventListener("click", () => {
    clearDetectorToken();
    tok.placeholder = "";
    lastHealth = null;
    detMsg("Token verwijderd.");
  });
  document.querySelectorAll<HTMLInputElement>('input[name="detMode"], input[name="detModeSet"]').forEach((r) =>
    r.addEventListener("change", () => r.checked && setMode(r.value === "cloud" ? "cloud" : "local"))
  );
  syncModeRadios();
}

export function initAiCheckTab(ctx: Ctx): void {
  ctxRef = ctx;
  initSettings();
  renderStatus(null, null);

  $("detPing").addEventListener("click", () => void ping());
  $("aiSel").addEventListener("click", () => void run("selection", $<HTMLButtonElement>("aiSel")));
  $("aiSec").addEventListener("click", () => void run("section", $<HTMLButtonElement>("aiSec")));
  $("aiDoc").addEventListener("click", () => void run("document", $<HTMLButtonElement>("aiDoc")));

  const mark = $<HTMLInputElement>("aiMark");
  mark.checked = ctx.settings().aiMarkSentences;
  mark.addEventListener("change", () => {
    ctx.settings().aiMarkSentences = mark.checked;
    ctx.save();
    updateMarks();
  });
  onAiMarkClicked(focusMark);

  // De lokale detector pas zoeken als je het tabblad opent (geen onnodige verzoeken).
  document.querySelector('.tabs button[data-tab="aicheck"]')?.addEventListener("click", () => {
    if (!pinged && ctx.settings().detectorMode === "local") {
      pinged = true;
      void ping();
    }
  });
}
