/**
 * Budget en kostenmeter.
 * - Kosten komen uit de `usage`-velden van elke API-respons × prijstabel (config.ts).
 * - Maandlimiet standaard €15, reset automatisch op de 1e van de maand.
 * - Waarschuwing vanaf 80 %, bij 100 % worden alle API-functies geblokkeerd.
 */
import { BUDGET_WARN_FRACTION, DEFAULT_BUDGET_EUR, PRICES } from "./config";
import { loadJSON, saveJSON } from "./storage";

/** Zoals de Claude API ze teruggeeft in `response.usage`. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface BudgetState {
  /** Maand waarop deze stand betrekking heeft, bv. "2026-11". */
  month: string;
  spentEur: number;
  limitEur: number;
}

export type BudgetStatus = "ok" | "warn" | "blocked";

const KEY = "budget";

export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Kosten van één respons in USD. `input_tokens` is exclusief cache-tokens (zo rapporteert de API het). */
export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const M = 1_000_000;
  return (
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.cache_read_input_tokens || 0) * p.cacheRead) /
    M
  );
}

/** Laadt de budgetstand en reset hem als er een nieuwe maand is begonnen. */
export function loadBudget(now: Date = new Date()): BudgetState {
  const cur = monthKey(now);
  const s = loadJSON<BudgetState | null>(KEY, null);
  if (!s || s.month !== cur) {
    // Nieuwe maand (of eerste gebruik): terug naar €0 en de standaardlimiet van €15.
    const fresh = { month: cur, spentEur: 0, limitEur: DEFAULT_BUDGET_EUR };
    saveJSON(KEY, fresh);
    return fresh;
  }
  return s;
}

export function statusOf(s: BudgetState): BudgetStatus {
  if (s.spentEur >= s.limitEur) return "blocked";
  if (s.spentEur >= s.limitEur * BUDGET_WARN_FRACTION) return "warn";
  return "ok";
}

/** Boekt de kosten van een respons. Geeft de nieuwe stand terug. */
export function recordUsage(model: string, u: Usage, usdToEur: number, now: Date = new Date()): BudgetState {
  const s = loadBudget(now);
  s.spentEur += costUsd(model, u) * usdToEur;
  saveJSON(KEY, s);
  notify(s);
  return s;
}

/** Verhoogt (of verlaagt) de limiet voor alleen deze maand. */
export function setMonthLimit(eur: number, now: Date = new Date()): BudgetState {
  const s = loadBudget(now);
  s.limitEur = Math.max(0, eur);
  saveJSON(KEY, s);
  notify(s);
  return s;
}

export function canSpend(now: Date = new Date()): boolean {
  return statusOf(loadBudget(now)) !== "blocked";
}

export function formatEur(v: number): string {
  return "€ " + v.toFixed(2).replace(".", ",");
}

// ---- simpele event-bus zodat de footer zich bijwerkt ----
type Listener = (s: BudgetState) => void;
const listeners: Listener[] = [];
export function onBudgetChange(l: Listener): void {
  listeners.push(l);
}
function notify(s: BudgetState): void {
  listeners.forEach((l) => l(s));
}
