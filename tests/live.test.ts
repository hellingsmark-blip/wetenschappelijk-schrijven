import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { starterProfiles } from "../src/profiles";
import { parseLive, liveUserMessage } from "../src/prompts/liveCheck";
import {
  canonicalSection, CheckContext, estimateUsd, firstUseInfo, LiveService, locateQuote, ParaInfo, sectionsFor, shouldSkip,
} from "../src/features/liveCheck";
import type { ClaudeRequest, ClaudeResult } from "../src/api/claude";

beforeEach(() => useStore(createMemoryStore()));

const P = (text: string, styleBuiltIn = "Normal", style = "Normal", inTable = false): ParaInfo => ({ text, styleBuiltIn, style, inTable });
const result = (text: string): ClaudeResult => ({ text, usage: {}, stopReason: "end_turn", model: "claude-haiku-5-5" });
const TEXT = "We saw a lot of ammonium removal, which clearly shows that the MABR works.";
const ctx = (): CheckContext => ({ profile: starterProfiles()[0], model: "claude-haiku-5-5", section: "Results", firstUse: { firstHere: [], earlier: ["MABR"] } });

describe("secties en overslaan", () => {
  it("herkent secties uit kopjes (ook genummerd en in Word-NL)", () => {
    expect(canonicalSection("2. Materials and methods")).toBe("Methods");
    expect(canonicalSection("Results and Discussion")).toBe("Results and Discussion");
    expect(canonicalSection("Literatuurlijst")).toBe("References");
    const s = sectionsFor([P("Introduction", "Heading1"), P("text"), P("3 Results", "Other", "Kop 1"), P("1.1 Detail", "Heading2"), P("more")]);
    expect(s).toEqual(["Introduction", "Introduction", "Results", "Results", "Results"]);
  });
  it("slaat kopjes, bijschriften, tabellen, literatuur en vergelijkingen over", () => {
    expect(shouldSkip(P("Introduction to the topic here", "Heading1"), null)).toBe(true);
    expect(shouldSkip(P("Figure 3. Ammonium removal over time"), null)).toBe(true);
    expect(shouldSkip(P("Some text in a table cell", "Normal", "Normal", true), null)).toBe(true);
    expect(shouldSkip(P("Smith, J. (2021). Biofilms in reactors."), "References")).toBe(true);
    expect(shouldSkip(P("J = 2.5 × 10^-3 + 4 = 7 (1)"), null)).toBe(true);
    expect(shouldSkip(P("Too short."), null)).toBe(true);
    expect(shouldSkip(P(TEXT), "Results")).toBe(false);
  });
});

describe("afkortingen: eerste gebruik", () => {
  it("bepaalt per alinea wat nieuw is en wat al eerder kwam", () => {
    const f = firstUseInfo(["The MABR and COD.", "MABR reduces N.", "SRT and COD."]);
    expect(f[0]).toEqual({ firstHere: ["MABR", "COD"], earlier: [] });
    expect(f[1]).toEqual({ firstHere: [], earlier: ["MABR"] });
    expect(f[2]).toEqual({ firstHere: ["SRT"], earlier: ["COD"] });
  });
  it("komt in het gebruikersbericht", () => {
    const m = liveUserMessage("p", "Methods", { firstHere: ["SRT"], earlier: [] }, "vorige");
    expect(m).toContain("FIRST occurrence in the document is in this paragraph: SRT");
    expect(m).toContain("<previous>\nvorige\n</previous>");
  });
});

describe("quote terugvinden", () => {
  it("vindt exacte tekst en negeert verschil in aanhalingstekens", () => {
    expect(locateQuote("It’s a test", "It's")).toEqual({ start: 0, length: 4 });
    expect(locateQuote("abc", "xyz")).toBeNull();
  });
});

describe("JSON-validatie", () => {
  it("laat onbekende categorieën en lege quotes weg", () => {
    const raw = JSON.stringify({
      findings: [
        { category: "stijl", quote: "a lot of", replacement: "substantial", title: "Informeel", explanation: "x" },
        { category: "notatie", quote: "NH4", replacement: "", title: "t", explanation: "" },
        { category: "taal", quote: "", replacement: "", title: "t", explanation: "" },
      ],
    });
    expect(parseLive(raw).map((f) => f.quote)).toEqual(["a lot of"]);
    expect(() => parseLive("geen json")).toThrow();
  });
});

describe("LiveService (nep-API)", () => {
  const answer = JSON.stringify({
    findings: [
      { category: "stijl", quote: "a lot of", replacement: "substantial", title: "Informeel woord", explanation: "Te informeel." },
      { category: "claim", quote: "clearly shows", replacement: "suggests", title: "Te stellige claim", explanation: "Eén meting." },
      { category: "taal", quote: "this text is not in the paragraph", replacement: "x", title: "Verzonnen", explanation: "" },
    ],
  });

  it("zoekt quotes zelf op, slaat onvindbare over en zet posities", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(answer));
    const items = await new LiveService(call).check({ ...ctx(), text: TEXT, previous: "" });
    expect(items.map((i) => i.quote)).toEqual(["a lot of", "clearly shows"]);
    expect(items[0].start).toBe(TEXT.indexOf("a lot of"));
  });

  it("stuurt Haiku-verzoek met gecachete systeemblokken, zonder thinking, met schema", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(answer));
    await new LiveService(call).check({ ...ctx(), text: TEXT, previous: "" });
    const req = call.mock.calls[0][0];
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.thinkingOff).toBe(true);
    expect(req.system?.every((b) => b.cache)).toBe(true);
    expect(req.jsonSchema).toBeDefined();
    expect(req.user).toContain("Section: Results");
  });

  it("cache: dezelfde alinea kost maar één aanroep, ook na herstart (opslag)", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(answer));
    await new LiveService(call).check({ ...ctx(), text: TEXT, previous: "" });
    await new LiveService(call).check({ ...ctx(), text: TEXT, previous: "andere context" });
    expect(call).toHaveBeenCalledTimes(1);
    await new LiveService(call).check({ ...ctx(), section: "Methods", text: TEXT, previous: "" });
    expect(call).toHaveBeenCalledTimes(2); // andere sectie = opnieuw
  });

  it("na toepassen schuift de cache mee naar de nieuwe tekst (geen nieuwe aanroep)", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(answer));
    const s = new LiveService(call);
    const items = await s.check({ ...ctx(), text: TEXT, previous: "" });
    const f = items[0];
    s.transfer(TEXT, ctx(), f.start, f.length, "substantial");
    const newText = TEXT.replace("a lot of", "substantial");
    const left = s.cached(newText, ctx())!;
    expect(left.map((i) => i.quote)).toEqual(["clearly shows"]);
    expect(newText.substr(left[0].start, left[0].length)).toBe("clearly shows");
  });
});

describe("getallen blijven heilig", () => {
  it("een taalsuggestie die een getal verandert wordt weggegooid", async () => {
    const text = "The pH was 16 and the temperature were 15 °C during the 1,5 h test.";
    const answer = JSON.stringify({
      findings: [
        { category: "taal", quote: "pH was 16", replacement: "pH was 7.6", title: "Taal", explanation: "" },
        { category: "taal", quote: "temperature were", replacement: "temperature was", title: "Werkwoord", explanation: "" },
        { category: "taal", quote: "1,5 h", replacement: "1.5 h", title: "Decimaalteken", explanation: "" },
      ],
    });
    const items = await new LiveService(vi.fn(async () => result(answer))).check({ ...ctx(), text, previous: "" });
    expect(items.map((i) => i.replacement)).toEqual(["temperature was", "1.5 h"]);
  });
});

describe("kostenschatting", () => {
  it("is klein voor Haiku", () => {
    const usd = estimateUsd("claude-haiku-5-5", Array(100).fill(TEXT), starterProfiles()[0]);
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBeLessThan(0.1);
  });
});
