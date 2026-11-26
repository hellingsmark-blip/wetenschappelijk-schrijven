/**
 * Koppeling met de eigen AI-detector (docs/detector-api.md), lokaal of in de cloud (Modal).
 * Tekst gaat alleen naar https://localhost / 127.0.0.1 of naar een eigen https://*.modal.run-adres.
 * Geen Word-code, zodat alles met een nep-fetch te testen is.
 */
import type { AiLabel, AnalysisResult, DetectorMode, HealthInfo, ModelInfo, ParagraphResult, SignalScore } from "./types";

export interface DetectorConfig {
  mode: DetectorMode;
  localUrl: string;
  cloudUrl: string;
  /** Alleen voor de cloud; staat in localStorage, nooit in het document. */
  token: string;
}

export type DetectorErrorKind = "config" | "not-found" | "auth" | "limit" | "too-long" | "cold-timeout" | "bad";

export class DetectorError extends Error {
  constructor(public kind: DetectorErrorKind, message: string) {
    super(message);
  }
}

interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps = (): Deps => ({
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const LOCAL_RE = /^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const CLOUD_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.modal\.run$/;

/** "" = in orde, anders een Nederlandse foutmelding. */
export function checkUrl(mode: DetectorMode, url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (mode === "local") return LOCAL_RE.test(u) ? "" : "Het lokale adres moet https://localhost:<poort> zijn.";
  if (!u) return "Vul het adres van je Modal-endpoint in (Instellingen → AI-detector).";
  return CLOUD_RE.test(u) ? "" : "Het cloud-adres moet een eigen https://….modal.run-adres zijn.";
}

function base(cfg: DetectorConfig): string {
  const url = (cfg.mode === "local" ? cfg.localUrl : cfg.cloudUrl).trim().replace(/\/+$/, "");
  const err = checkUrl(cfg.mode, url);
  if (err) throw new DetectorError("config", err);
  if (cfg.mode === "cloud" && !cfg.token.trim()) {
    throw new DetectorError("config", "Vul het toegangstoken van je cloud-detector in (Instellingen → AI-detector).");
  }
  return url;
}

function headers(cfg: DetectorConfig, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (cfg.mode === "cloud") h.Authorization = `Bearer ${cfg.token.trim()}`; // nooit naar localhost
  return h;
}

async function withTimeout(deps: Deps, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await deps.fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new DetectorError("not-found", (e as Error)?.name === "AbortError" ? "Detector reageert niet (time-out)." : "Detector niet gevonden.");
  } finally {
    clearTimeout(t);
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const d = await res.json();
    return typeof d?.detail === "string" ? d.detail : "";
  } catch {
    return "";
  }
}

async function failure(res: Response, mode: DetectorMode): Promise<DetectorError> {
  const d = await detail(res);
  switch (res.status) {
    case 401:
    case 403:
      return new DetectorError("auth", "Toegangstoken ongeldig — controleer het token in Instellingen → AI-detector.");
    case 402:
      return new DetectorError("limit", d || "De limiet van je cloud-detector is bereikt.");
    case 413:
      return new DetectorError("too-long", d || "Tekst te lang voor de detector; analyseer een kleiner stuk (selectie of sectie).");
    default:
      return new DetectorError("bad", d || `Detector gaf een fout (${res.status}${mode === "cloud" ? ", cloud" : ""}).`);
  }
}

// ---------- Validatie van antwoorden ----------

const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const LABELS: AiLabel[] = ["human", "uncertain", "ai"];
const lab = (v: unknown, score: number): AiLabel =>
  LABELS.includes(v as AiLabel) ? (v as AiLabel) : score < 0.35 ? "human" : score > 0.65 ? "ai" : "uncertain";

function models(v: unknown): ModelInfo[] {
  return (Array.isArray(v) ? v : [])
    .filter((m) => m && typeof m.name === "string")
    .map((m) => ({ signal: String(m.signal || ""), name: m.name, version: typeof m.version === "string" ? m.version : undefined }));
}

function signals(v: unknown): Record<string, SignalScore> {
  const out: Record<string, SignalScore> = {};
  if (v && typeof v === "object") {
    for (const [k, s] of Object.entries(v as Record<string, { score?: unknown; contribution?: unknown }>)) {
      if (!s || typeof s !== "object") continue;
      out[k] = { score: num(s.score), contribution: typeof s.contribution === "number" && isFinite(s.contribution) ? s.contribution : 0 };
    }
  }
  return out;
}

export function parseHealth(d: Record<string, unknown>): HealthInfo {
  if (d?.status !== "ok") throw new DetectorError("bad", "Onverwacht antwoord van de detector (/health).");
  return {
    mode: d.mode === "cloud" ? "cloud" : "local",
    warm: d.warm !== false,
    models: models(d.models),
    signals: Array.isArray(d.signals) ? d.signals.map(String) : [],
    maxChars: typeof d.max_chars === "number" ? d.max_chars : null,
    costPer1000Words: typeof d.cost_usd_per_1000_words === "number" ? d.cost_usd_per_1000_words : null,
    limitRemainingUsd: typeof d.limit_remaining_usd === "number" ? d.limit_remaining_usd : null,
  };
}

export function parseAnalysis(d: Record<string, unknown>, mode: DetectorMode): AnalysisResult {
  const o = (d?.overall || {}) as Record<string, unknown>;
  if (typeof o.score !== "number") throw new DetectorError("bad", "Onverwacht antwoord van de detector (/analyze).");
  const score = num(o.score);
  const paras: ParagraphResult[] = (Array.isArray(d.paragraphs) ? d.paragraphs : [])
    .filter((p: Record<string, unknown>) => p && typeof p.id === "string")
    .map((p: Record<string, unknown>) => {
      const s = typeof p.score === "number" ? num(p.score) : undefined;
      return {
        id: p.id as string,
        score: s,
        low: typeof p.low === "number" ? num(p.low) : undefined,
        high: typeof p.high === "number" ? num(p.high) : undefined,
        label: s === undefined ? undefined : lab(p.label, s),
        sentences: (Array.isArray(p.sentences) ? p.sentences : [])
          .filter((z: Record<string, unknown>) => z && typeof z.text === "string" && typeof z.score === "number")
          .map((z: Record<string, unknown>) => ({ text: z.text as string, score: num(z.score), signals: signals(z.signals) })),
      };
    });
  return {
    mode: d.mode === "cloud" ? "cloud" : d.mode === "local" ? "local" : mode,
    models: models(d.models),
    overall: { score, low: num(o.low, score), high: num(o.high, score), label: lab(o.label, score) },
    signalsOverall: signals(d.signals_overall),
    paragraphs: paras,
    warnings: (Array.isArray(d.warnings) ? d.warnings : []).filter((w) => typeof w === "string"),
    costUsd: typeof d.cost_usd === "number" ? d.cost_usd : null,
    elapsedMs: typeof d.elapsed_ms === "number" ? d.elapsed_ms : null,
  };
}

// ---------- Aanroepen ----------

export async function health(cfg: DetectorConfig, deps: Deps = defaultDeps()): Promise<HealthInfo> {
  const url = base(cfg);
  const res = await withTimeout(deps, `${url}/health`, { method: "GET", headers: headers(cfg, false) }, cfg.mode === "local" ? 3000 : 90000);
  if (!res.ok) throw await failure(res, cfg.mode);
  return parseHealth(await res.json());
}

const MAX_COLD_WAIT_MS = 180000;

/**
 * Analyseert alinea's. Bij 503 (cloud start op) wacht hij `Retry-After` seconden en probeert opnieuw,
 * tot ± 3 minuten; `onWaiting` krijgt dan een statusmelding.
 */
export async function analyze(
  cfg: DetectorConfig,
  paragraphs: { id: string; text: string }[],
  section: string | null,
  onWaiting: (msg: string) => void = () => undefined,
  deps: Deps = defaultDeps()
): Promise<AnalysisResult> {
  const url = base(cfg);
  const body = JSON.stringify({ api_version: 1, section: section || undefined, paragraphs });
  let waited = 0;
  for (;;) {
    const res = await withTimeout(
      deps, `${url}/analyze`, { method: "POST", headers: headers(cfg, true), body }, cfg.mode === "local" ? 180000 : 300000
    );
    if (res.status === 503) {
      const ra = Number(res.headers.get("Retry-After"));
      const ms = (ra > 0 && ra <= 60 ? ra : 10) * 1000;
      if (waited + ms > MAX_COLD_WAIT_MS) throw new DetectorError("cold-timeout", "De cloud-detector start niet op; probeer het later opnieuw.");
      onWaiting(cfg.mode === "cloud" ? "Cloud-detector wordt opgestart…" : "Detector laadt de modellen…");
      await deps.sleep(ms);
      waited += ms;
      continue;
    }
    if (!res.ok) throw await failure(res, cfg.mode);
    return parseAnalysis(await res.json(), cfg.mode);
  }
}
