import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { canSpend, costUsd, formatEur, loadBudget, recordUsage, setMonthLimit, statusOf } from "../src/budget";

const nov = new Date(2026, 10, 26);
const dec = new Date(2026, 11, 1);

beforeEach(() => useStore(createMemoryStore()));

describe("kostenberekening", () => {
  it("rekent input, output en cache-tokens mee (Sonnet)", () => {
    // 1M input × $2 + 1M output × $10 + 1M cache write × $2,5 + 1M cache read × $0,1
    const c = costUsd("claude-sonnet-5-5", {
      input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6,
    });
    expect(c).toBeCloseTo(14.6, 6);
  });
  it("Haiku: 10K in / 1K uit", () => {
    expect(costUsd("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 1_000 })).toBeCloseTo(0.0015, 8);
  });
  it("onbekend model kost 0", () => {
    expect(costUsd("onbekend", { input_tokens: 5 })).toBe(0);
  });
});

describe("maandbudget", () => {
  it("start op €15 en €0", () => {
    const s = loadBudget(nov);
    expect(s).toEqual({ month: "2026-11", spentEur: 0, limitEur: 15 });
  });
  it("waarschuwt bij 80% en blokkeert bij 100%", () => {
    // €12 = 80% van €15. Sonnet output: $10/M; bij koers 1 → 1,2M output-tokens = $12.
    recordUsage("claude-sonnet-5-5", { output_tokens: 1_200_000 }, 1, nov);
    expect(statusOf(loadBudget(nov))).toBe("warn");
    expect(canSpend(nov)).toBe(true);
    recordUsage("claude-sonnet-5-5", { output_tokens: 300_000 }, 1, nov);
    expect(statusOf(loadBudget(nov))).toBe("blocked");
    expect(canSpend(nov)).toBe(false);
  });
  it("limiet verhogen heft blokkade op", () => {
    recordUsage("claude-sonnet-5-5", { output_tokens: 1_600_000 }, 1, nov);
    expect(canSpend(nov)).toBe(false);
    setMonthLimit(25, nov);
    expect(canSpend(nov)).toBe(true);
  });
  it("reset op de 1e van de maand naar €15", () => {
    setMonthLimit(40, nov);
    recordUsage("claude-sonnet-5-5", { output_tokens: 1_000_000 }, 1, nov);
    const s = loadBudget(dec);
    expect(s).toEqual({ month: "2026-12", spentEur: 0, limitEur: 15 });
  });
  it("past de koers toe", () => {
    const s = recordUsage("claude-sonnet-5-5", { output_tokens: 1_000_000 }, 0.9, nov);
    expect(s.spentEur).toBeCloseTo(9, 6);
  });
  it("formatteert in euro met komma", () => {
    expect(formatEur(3.456)).toBe("€ 3,46");
  });
});
