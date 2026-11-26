import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { starterProfiles } from "../src/profiles";
import { needsTechnical, parseTech, quantitativeStatements, techUserMessage } from "../src/prompts/technical";
import { CheckContext, LiveService } from "../src/features/liveCheck";
import type { ClaudeRequest, ClaudeResult } from "../src/api/claude";

beforeEach(() => useStore(createMemoryStore()));

const TEXT = "Ammonium was converted to nitrate by denitrification at a load of 3 g N m-2 d-1.";
const result = (text: string): ClaudeResult => ({ text, usage: {}, stopReason: "end_turn", model: "claude-sonnet-5-5" });
const ctx = (): CheckContext => ({
  kind: "tech", profile: starterProfiles()[0], model: "claude-sonnet-5-5", section: "Results", firstUse: { firstHere: [], earlier: [] },
});
const ANSWER = JSON.stringify({
  findings: [
    { kind: "term", quote: "denitrification", replacement: "nitrification", title: "Bedoel je nitrification?", explanation: "Ammonium → nitraat is nitrificatie." },
    { kind: "fact", quote: "3 g N m-2 d-1", replacement: "", title: "Klopt 3 g N m⁻² d⁻¹?", explanation: "In Methods staat 2." },
  ],
});

describe("technische prompt-hulpjes", () => {
  it("parseTech valideert soorten", () => {
    const raw = JSON.stringify({ findings: [{ kind: "term", quote: "x", replacement: "", title: "?", explanation: "" }, { kind: "stijl", quote: "y" }] });
    expect(parseTech(raw).map((f) => f.kind)).toEqual(["term"]);
  });
  it("alleen alinea's met cijfers of vaktermen gaan naar Sonnet", () => {
    expect(needsTechnical("The reactor ran for 30 days.")).toBe(true);
    expect(needsTechnical("Denitrification occurred in the anoxic zone.")).toBe(true);
    expect(needsTechnical("This chapter describes the structure of the report.")).toBe(false);
  });
  it("verzamelt kwantitatieve zinnen uit andere alinea's, met sectie", () => {
    const paras = [
      { text: "The loading rate was 2 g N m-2 d-1. The weather was fine.", section: "Methods", skip: false },
      { text: TEXT, section: "Results", skip: false },
      { text: "Smith (2020) studied this.", section: "Introduction", skip: false },
      { text: "Kop met 12 mg", section: null, skip: true },
    ];
    expect(quantitativeStatements(paras, 1)).toEqual(["[Methods] The loading rate was 2 g N m-2 d-1."]);
  });
  it("gebruikersbericht bevat de andere uitspraken", () => {
    expect(techUserMessage("p", "Results", ["[Methods] x 2 mg"])).toContain("<elsewhere>\n- [Methods] x 2 mg\n</elsewhere>");
  });
});

describe("LiveService – technische controle (nep-API)", () => {
  it("vraagt Sonnet zonder 'thinking uit', met feitenblad en andere uitspraken", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(ANSWER));
    await new LiveService(call).check({ ...ctx(), text: TEXT, previous: "", elsewhere: ["[Methods] 2 g N m-2 d-1"] });
    const req = call.mock.calls[0][0];
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.thinkingOff).toBeFalsy();
    expect(req.system?.[0].text).toContain("TECHNICAL CORRECTNESS");
    expect(req.system?.[1].text).toContain('<project_profile name="MABR">');
    expect(req.user).toContain("[Methods] 2 g N m-2 d-1");
  });

  it("zet bevindingen op categorie technisch; vragen zonder vervanging blijven staan", async () => {
    const items = await new LiveService(vi.fn(async () => result(ANSWER))).check({ ...ctx(), text: TEXT, previous: "" });
    expect(items.map((i) => [i.category, i.quote, i.replacement])).toEqual([
      ["technisch", "denitrification", "nitrification"],
      ["technisch", "3 g N m-2 d-1", ""],
    ]);
  });

  it("aparte cache voor live en technisch; force negeert de cache", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(ANSWER));
    const s = new LiveService(call);
    await s.check({ ...ctx(), text: TEXT, previous: "" });
    await s.check({ ...ctx(), text: TEXT, previous: "" });
    expect(call).toHaveBeenCalledTimes(1);
    await s.check({ ...ctx(), text: TEXT, previous: "", force: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(s.cached(TEXT, { ...ctx(), kind: "live", model: "claude-haiku-5-5" })).toBeUndefined();
  });

  it("profiel bewerken laat bestaande resultaten staan (sleutel = profielnaam)", async () => {
    const s = new LiveService(vi.fn(async () => result(ANSWER)));
    await s.check({ ...ctx(), text: TEXT, previous: "" });
    const edited = { ...ctx(), profile: { ...starterProfiles()[0], field: "iets anders" } };
    expect(s.cached(TEXT, edited)).toBeDefined();
    expect(s.cached(TEXT, { ...ctx(), profile: starterProfiles()[1] })).toBeUndefined();
  });
});
