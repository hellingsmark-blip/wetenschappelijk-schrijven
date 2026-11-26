import { describe, expect, it, vi } from "vitest";
import { aiWordHits, analyzeLight, mtld, scoreText, splitSentences, tripletCount, unicodeHits, words } from "../src/aicheck/light";
import { analyze, checkUrl, DetectorConfig, health, parseAnalysis } from "../src/aicheck/client";
import { documentUnits, selectionUnits, sentenceSpans } from "../src/aicheck/units";
import type { ParaInfo } from "../src/features/liveCheck";

const HUMAN =
  "The reactor was operated for 120 days. Ammonium removal fluctuated strongly during the first weeks, mainly because the " +
  "influent load varied with rainfall. After day 40 it stabilised. We then lowered the air pressure. Nitrite accumulated. " +
  "This was unexpected, since earlier pilot studies at the Dutch WWTP in Utrecht had reported complete nitrification under " +
  "comparable conditions, and we therefore checked the oxygen sensors twice before continuing with the next phase.";
const AI_LIKE =
  "It is important to note that membrane aerated biofilm reactors play a crucial role in modern wastewater treatment. " +
  "Notably, they offer a seamless and holistic approach to nitrogen removal. Furthermore, this technology underscores the " +
  "intricate interplay between oxygen transfer, biofilm growth, and microbial diversity. Additionally, it paves the way for " +
  "energy-efficient treatment. Overall, this multifaceted approach sheds light on the evolving landscape of water technology.";

describe("lichte modus: bouwstenen", () => {
  it("knipt zinnen niet na 'et al.' of 'Fig.'", () => {
    expect(splitSentences("Smith et al. (2020) showed this. See Fig. 2 for details. Done.")).toEqual([
      "Smith et al. (2020) showed this.",
      "See Fig. 2 for details.",
      "Done.",
    ]);
  });
  it("telt AI-woorden, drietallen en vreemde tekens", () => {
    expect(aiWordHits("It is important to note that this plays a crucial role.")).toBe(2);
    expect(tripletCount("oxygen, nitrite, and ammonium were measured")).toBe(1);
    expect(unicodeHits("normal​text and Cyrillic а in wаter")).toBeGreaterThanOrEqual(2);
    expect(unicodeHits("Plain text — with an em dash.")).toBe(0);
  });
  it("MTLD is hoger voor gevarieerde tekst", () => {
    const repetitive = words("the reactor the reactor the reactor the reactor the reactor the reactor the reactor the reactor");
    expect(mtld(words(HUMAN))).toBeGreaterThan(mtld(repetitive));
  });
});

describe("lichte modus: scores", () => {
  it("AI-achtige tekst scoort hoger dan menselijke tekst", () => {
    expect(scoreText(AI_LIKE).score).toBeGreaterThan(scoreText(HUMAN).score + 0.2);
  });
  it("geeft brede marges, label en waarschuwingen (kort + indicatief)", () => {
    const r = analyzeLight([{ id: "p1", text: HUMAN }]);
    expect(r.mode).toBe("light");
    expect(r.overall.high - r.overall.low).toBeGreaterThanOrEqual(0.39);
    expect(r.warnings[0]).toMatch(/Korte tekst/);
    expect(r.warnings.join(" ")).toMatch(/indicatief, beperkte betrouwbaarheid/);
    expect(r.paragraphs[0].sentences.length).toBe(6);
  });
  it("per zin: AI-woorden geven een hogere zinsscore", () => {
    const r = analyzeLight([{ id: "p1", text: AI_LIKE }]);
    const scores = r.paragraphs[0].sentences.map((s) => s.score);
    expect(Math.max(...scores)).toBeGreaterThan(0.6);
    expect(r.paragraphs[0].sentences[0].signals.ai_words.contribution).toBeGreaterThan(0);
  });
});

describe("detector: adressen (alleen eigen detector)", () => {
  it("lokaal alleen https://localhost of 127.0.0.1", () => {
    expect(checkUrl("local", "https://localhost:8765")).toBe("");
    expect(checkUrl("local", "http://localhost:8765")).not.toBe("");
    expect(checkUrl("local", "https://gptzero.me")).not.toBe("");
  });
  it("cloud alleen https://….modal.run", () => {
    expect(checkUrl("cloud", "https://hellingsmark--detector-api.modal.run")).toBe("");
    expect(checkUrl("cloud", "https://api.gptzero.me")).not.toBe("");
    expect(checkUrl("cloud", "https://evil.com/x.modal.run")).not.toBe("");
  });
});

const LOCAL: DetectorConfig = { mode: "local", localUrl: "https://localhost:8765", cloudUrl: "", token: "" };
const CLOUD: DetectorConfig = { mode: "cloud", localUrl: "", cloudUrl: "https://me--det.modal.run", token: "geheim-test" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const ANALYSIS = {
  api_version: 1,
  mode: "cloud",
  models: [{ signal: "binoculars", name: "falcon-7b pair" }],
  overall: { score: 0.82, low: 0.7, high: 0.9, label: "ai" },
  signals_overall: { binoculars: { score: 0.9, contribution: 1.4 } },
  paragraphs: [{ id: "p3", score: 0.8, label: "ai", sentences: [{ text: "Notably, it works.", score: 0.9, signals: {} }] }],
  warnings: [],
  cost_usd: 0.004,
};

describe("detector: aanroepen (nep-fetch)", () => {
  it("health lokaal: geen Authorization-header", async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      json({ status: "ok", mode: "local", warm: true, models: [{ signal: "classifier", name: "deberta" }], signals: [] })
    );
    const h = await health(LOCAL, { fetch: f as unknown as typeof fetch, sleep: async () => undefined });
    expect(h.mode).toBe("local");
    expect(h.models[0].name).toBe("deberta");
    expect(f.mock.calls[0][0]).toBe("https://localhost:8765/health");
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("cloud: bearer-token, wacht bij 503 (koude start) en meldt dat", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ detail: "warming" }, 503, { "Retry-After": "5" }))
      .mockResolvedValueOnce(json(ANALYSIS));
    const sleep = vi.fn(async () => undefined);
    const waiting = vi.fn();
    const r = await analyze(CLOUD, [{ id: "p3", text: "Notably, it works." }], "Results", waiting, { fetch: f as unknown as typeof fetch, sleep });
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(waiting).toHaveBeenCalledWith("Cloud-detector wordt opgestart…");
    const init = f.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer geheim-test");
    expect(JSON.parse(init.body as string)).toEqual({ api_version: 1, section: "Results", paragraphs: [{ id: "p3", text: "Notably, it works." }] });
    expect(r.mode).toBe("cloud");
    expect(r.overall.label).toBe("ai");
    expect(r.costUsd).toBe(0.004);
  });

  it("401 geeft een duidelijke melding; geen detector = 'niet gevonden'", async () => {
    const deps401 = { fetch: (async () => json({ detail: "x" }, 401)) as unknown as typeof fetch, sleep: async () => undefined };
    await expect(analyze(CLOUD, [], null, undefined, deps401)).rejects.toMatchObject({ kind: "auth" });
    const depsDown = { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch, sleep: async () => undefined };
    await expect(health(LOCAL, depsDown)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("zonder token of met verkeerd adres wordt er niets verstuurd", async () => {
    const f = vi.fn();
    const deps = { fetch: f as unknown as typeof fetch, sleep: async () => undefined };
    await expect(health({ ...CLOUD, token: "" }, deps)).rejects.toMatchObject({ kind: "config" });
    await expect(health({ ...CLOUD, cloudUrl: "https://api.gptzero.me" }, deps)).rejects.toMatchObject({ kind: "config" });
    expect(f).not.toHaveBeenCalled();
  });

  it("parseAnalysis klemt scores en vult ontbrekende labels in", () => {
    const r = parseAnalysis({ overall: { score: 1.7 }, paragraphs: [{ id: "a", score: 0.2, sentences: [] }] }, "local");
    expect(r.overall.score).toBe(1);
    expect(r.overall.label).toBe("ai");
    expect(r.paragraphs[0].label).toBe("human");
  });
});

describe("eenheden en zinsposities", () => {
  const P = (text: string, styleBuiltIn = "Normal"): ParaInfo => ({ text, styleBuiltIn, style: styleBuiltIn, inTable: false });
  const paras = [P("Results", "Heading1"), P("First paragraph. Second sentence here."), P("Short one."), P("Figure 1. Caption."), P("References", "Heading1"), P("Smith 2020.")];

  it("document: kopjes, bijschriften en literatuur overslaan, korte alinea's wel meenemen", () => {
    expect(documentUnits(paras).map((u) => u.id)).toEqual(["p1", "p2"]);
  });
  it("selectie over twee alinea's wordt gekoppeld aan de juiste alinea", () => {
    const u = selectionUnits(paras, "Second sentence here.\rShort one.");
    expect(u.map((x) => [x.para, x.text])).toEqual([[1, "Second sentence here."], [2, "Short one."]]);
  });
  it("vindt zinnen terug in de alinea", () => {
    const spans = sentenceSpans("First paragraph. Second sentence here.", [
      { text: "First paragraph.", score: 0, signals: {} },
      { text: "Second sentence here.", score: 0, signals: {} },
      { text: "Not there.", score: 0, signals: {} },
    ]);
    expect(spans).toEqual([{ start: 0, length: 16 }, { start: 17, length: 21 }, null]);
  });
});
