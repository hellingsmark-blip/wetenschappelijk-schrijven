import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { diffHtml, wordCount, wordDiff } from "../src/diff";
import { parseParaphrase, paraphraseUserMessage } from "../src/prompts/paraphrase";
import { profileContext } from "../src/prompts/profileContext";
import { ParaphraseService } from "../src/features/paraphrase";
import { starterProfiles } from "../src/profiles";
import type { ClaudeRequest, ClaudeResult } from "../src/api/claude";

beforeEach(() => useStore(createMemoryStore()));

const GOOD = JSON.stringify({
  variants: [
    { style: "cautious", text: "Nitrification appears to have removed most NH₄⁺-N.", note: "Voorzichtiger." },
    { style: "scientific", text: "Nitrification removed the majority of the NH₄⁺-N.", note: "Wetenschappelijker." },
    { style: "concise", text: "Nitrification removed most NH₄⁺-N.", note: "Korter." },
    { style: "formal", text: "Nitrification removed the majority of NH₄⁺-N.", note: "Formeler." },
  ],
});

describe("woord-diff", () => {
  it("markeert toegevoegde en verwijderde woorden", () => {
    expect(diffHtml("the results clearly show removal", "the results suggest removal")).toBe(
      "the results <del>clearly show</del><ins>suggest</ins> removal"
    );
  });
  it("bouwt beide teksten exact terug", () => {
    const a = "A lot of  ammonium was removed.";
    const b = "Substantial ammonium was removed.";
    const parts = wordDiff(a, b);
    expect(parts.filter((p) => p.kind !== "add").map((p) => p.text).join("")).toBe(a);
    expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(b);
  });
  it("ontsnapt HTML", () => {
    expect(diffHtml("a <b>", "a <c>")).toContain("&lt;c&gt;");
  });
  it("telt woorden", () => {
    expect(wordCount("  one two\nthree ")).toBe(3);
  });
});

describe("JSON-validatie", () => {
  it("accepteert vier varianten en zet ze op vaste volgorde", () => {
    expect(parseParaphrase(GOOD).map((v) => v.style)).toEqual(["scientific", "formal", "concise", "cautious"]);
  });
  it("weigert ongeldige JSON of ontbrekende variant", () => {
    expect(() => parseParaphrase("geen json")).toThrow();
    expect(() => parseParaphrase(JSON.stringify({ variants: [{ style: "formal", text: "x", note: "" }] }))).toThrow(/scientific/);
  });
});

describe("profielcontext", () => {
  it("is deterministisch en laat lege feitenblad-velden weg", () => {
    const [mabr] = starterProfiles();
    mabr.facts[0].value = "PVDF hollow fibre";
    const a = profileContext(mabr);
    expect(a).toBe(profileContext(mabr));
    expect(a).toContain("Membrane type: PVDF hollow fibre");
    expect(a).not.toContain("Membrane surface area");
    expect(a).toContain("British English");
  });
  it("gebruikersbericht bevat selectie en eerdere varianten bij 'Opnieuw'", () => {
    const m = paraphraseUserMessage("tekst", "Methods", ["oud"]);
    expect(m).toContain("Section of the document: Methods");
    expect(m).toContain("- oud");
    expect(m).toContain("<selection>\ntekst\n</selection>");
  });
});

describe("ParaphraseService (nep-API)", () => {
  const result = (text: string): ClaudeResult => ({ text, usage: {}, stopReason: "end_turn", model: "claude-sonnet-5-5" });

  it("gebruikt de cache voor dezelfde tekst en hetzelfde profiel", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(GOOD));
    const s = new ParaphraseService(call);
    const [mabr] = starterProfiles();
    await s.variants("Some selected text here ok", mabr, "claude-sonnet-5-5", null);
    await s.variants("Some selected text here ok", mabr, "claude-sonnet-5-5", null);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("ander profiel → nieuwe aanroep; 'Opnieuw' omzeilt de cache", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(GOOD));
    const s = new ParaphraseService(call);
    const [mabr, mem] = starterProfiles();
    await s.variants("Some selected text here ok", mabr, "m", null);
    await s.variants("Some selected text here ok", mem, "m", null);
    await s.variants("Some selected text here ok", mabr, "m", null, true);
    expect(call).toHaveBeenCalledTimes(3);
    const last = call.mock.calls[2][0];
    expect(last.user).toContain("Give different wordings");
  });

  it("stuurt systeemprompt + profiel als gecachete blokken en een JSON-schema", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(GOOD));
    await new ParaphraseService(call).variants("Some selected text here ok", starterProfiles()[0], "m", null);
    const req = call.mock.calls[0][0];
    expect(req.system?.every((b) => b.cache)).toBe(true);
    expect(req.system?.[1].text).toContain('<project_profile name="MABR">');
    expect(req.jsonSchema).toBeDefined();
  });

  it("afgekapt antwoord geeft duidelijke fout", async () => {
    const call = vi.fn(async () => ({ ...result("{"), stopReason: "max_tokens" }));
    await expect(new ParaphraseService(call).variants("x y z a b", starterProfiles()[0], "m", null)).rejects.toThrow(/afgekapt/);
  });
});
