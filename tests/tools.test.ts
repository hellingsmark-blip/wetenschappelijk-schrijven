import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { starterProfiles } from "../src/profiles";
import type { ParaInfo } from "../src/features/liveCheck";
import {
  abbreviationReport, checkFiguresTables, countTerm, documentText, matchCase, replaceableOccurrences, sectionRange, shorten,
  supervise, translate, verifyTermGroups,
} from "../src/features/tools";
import { supervisorRole } from "../src/prompts/tools";
import type { ClaudeRequest, ClaudeResult } from "../src/api/claude";

beforeEach(() => useStore(createMemoryStore()));

const P = (text: string, styleBuiltIn = "Normal"): ParaInfo => ({ text, styleBuiltIn, style: styleBuiltIn, inTable: false });
const result = (text: string): ClaudeResult => ({ text, usage: {}, stopReason: "end_turn", model: "claude-sonnet-5-5" });

describe("huidige sectie", () => {
  const doc = [
    P("1 Introduction", "Heading1"), P("Intro text."),
    P("2 Methods", "Heading1"), P("Methods text."), P("2.1 Sampling", "Heading2"), P("Sampling text."),
    P("3 Results", "Heading1"), P("Results text."),
  ];
  it("van kopje tot het volgende kopje van hetzelfde niveau (subkopjes horen erbij)", () => {
    expect(sectionRange(doc, 3)).toEqual({ heading: 2, headingText: "2 Methods", indexes: [3, 4, 5] });
  });
  it("in een subsectie alleen die subsectie", () => {
    expect(sectionRange(doc, 5).indexes).toEqual([5]);
  });
});

describe("figuren & tabellen", () => {
  it("vindt niet-genoemde figuren, ontbrekende bijschriften, gaten en volgorde", () => {
    const doc = [
      P("As shown in Figure 2 and Table 1, removal was high (Figs. 1–2)."),
      P("Figure 1. Reactor set-up.", "Caption"),
      P("Figure 2: Ammonium removal."),
      P("Figure 4. Not mentioned anywhere."),
      P("Table 1. Influent composition.", "Caption"),
      P("See Table 3 for details."),
    ];
    const r = checkFiguresTables(doc);
    expect(r.figures).toEqual(["1", "2", "4"]);
    expect(r.tables).toEqual(["1"]);
    const msgs = r.issues.map((i) => i.message);
    expect(msgs).toContain("Nummering springt van Figuur 2 naar Figuur 4.");
    expect(msgs).toContain("Figuur 4 wordt nergens in de tekst genoemd.");
    expect(msgs).toContain("Tabel 3 wordt genoemd, maar er is geen bijschrift met dat nummer.");
    expect(msgs).toContain("Figuur 2 wordt eerder in de tekst genoemd dan Figuur 1.");
  });
  it("een zin die met 'Figure 3 shows' begint is geen bijschrift; hoofdstuknummering 3.1, 3.2 mag", () => {
    const r = checkFiguresTables([
      P("Figure 3.1 shows the set-up and Figure 3.2 the results."),
      P("Figure 3.1. Set-up.", "Caption"),
      P("Figure 3.2. Results.", "Caption"),
    ]);
    expect(r.figures).toEqual(["3.1", "3.2"]);
    expect(r.issues).toEqual([]);
  });
});

describe("afkortingenlijst", () => {
  it("herkent uitgeschreven, pas later uitgeschreven en ontbrekende afkortingen", () => {
    const doc = [
      P("A membrane aerated biofilm reactor (MABR) was used."),
      P("The SRT was long and the COD was low."),
      P("The sludge retention time (SRT) was 20 d."),
    ];
    const r = abbreviationReport(doc, starterProfiles()[0]);
    const by = Object.fromEntries(r.map((a) => [a.abbr, a]));
    expect(by.MABR.status).toBe("defined");
    expect(by.MABR.full).toBe("membrane aerated biofilm reactor");
    expect(by.SRT.status).toBe("later");
    expect(by.SRT.full).toBe("sludge retention time");
    expect(by.SRT.fromText).toBe(true);
    expect(by.COD.status).toBe("missing");
  });
  it("slaat kopjes in hoofdletters en de literatuurlijst over", () => {
    const r = abbreviationReport([P("RESULTS AND DISCUSSION", "Heading1"), P("References", "Heading1"), P("Smith (2020) WWTP study.")], starterProfiles()[0]);
    expect(r).toEqual([]);
  });
});

describe("termen", () => {
  const text = "The MABR works. A membrane aerated bioreactor is efficient. Membrane aerated bioreactor (MABR) units.";
  it("telt losse woorden, hoofdletterongevoelig", () => {
    expect(countTerm(text, "membrane aerated bioreactor")).toBe(2);
    expect(countTerm("bioreactors", "bioreactor")).toBe(0);
  });
  it("houdt alleen varianten die echt voorkomen", () => {
    const g = verifyTermGroups(text, [{ preferred: "MABR", variants: ["membrane aerated bioreactor", "MBR", "mabr"], explanation: "" }]);
    expect(g[0].variants).toEqual([{ text: "membrane aerated bioreactor", count: 2 }]);
  });
  it("vervangt niet de definitie bij eerste gebruik", () => {
    expect(replaceableOccurrences(text, "membrane aerated bioreactor")).toEqual([true, false]);
  });
  it("behoudt de hoofdletter aan het begin van een zin", () => {
    expect(matchCase("Membrane-aerated", "membrane aerated")).toBe("Membrane aerated");
    expect(matchCase("membrane aerated bioreactor", "MABR")).toBe("MABR");
  });
  it("documenttekst zonder literatuurlijst", () => {
    const t = documentText([P("Intro", "Heading1"), P("Some text here for you."), P("References", "Heading1"), P("Smith 2020.")]);
    expect(t).toBe("Intro\n\nSome text here for you.");
  });
});

describe("Claude-tools (nep-API)", () => {
  it("vertalen gebruikt Sonnet met profiel en geeft de vertaling terug", async () => {
    const call = vi.fn(async (_r: ClaudeRequest) => result(JSON.stringify({ translation: "The WWTP removed ammonium.", note: "" })));
    const r = await translate("De rwzi verwijderde ammonium.", starterProfiles()[0], "claude-sonnet-5-5", call);
    expect(r.translation).toBe("The WWTP removed ammonium.");
    expect(call.mock.calls[0][0].system?.[1].text).toContain('<project_profile name="MABR">');
  });

  it("inkorten probeert het één keer opnieuw als het te lang is", async () => {
    const long = Array(30).fill("word").join(" ");
    const short = Array(9).fill("word").join(" ");
    const call = vi
      .fn()
      .mockResolvedValueOnce(result(JSON.stringify({ text: long, removed: "" })))
      .mockResolvedValueOnce(result(JSON.stringify({ text: short, removed: "Details weg." })));
    const r = await shorten(Array(40).fill("word").join(" "), 10, starterProfiles()[0], "m", call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].user).toContain("previous attempt had 30 words");
    expect(r.words).toBe(9);
  });

  it("begeleidersmodus rekent [P#] om naar documentalinea's en controleert quotes", async () => {
    const answer = JSON.stringify({
      summary: "Goed begin.",
      comments: [
        { paragraph: 2, quote: "removal was high", type: "support", comment: "Onderbouw dit met data." },
        { paragraph: 1, quote: "niet in de tekst", type: "logic", comment: "Logica." },
        { paragraph: 9, quote: "x", type: "other", comment: "Bestaat niet." },
      ],
    });
    const call = vi.fn(async (_r: ClaudeRequest) => result(answer));
    const paras = [
      { index: 10, text: "We operated the reactor for 30 days at 15 °C." },
      { index: 11, text: "The removal was high in all phases." },
    ];
    const r = await supervise("Results", paras, { ...starterProfiles()[1] }, "m", call);
    expect(r.comments.map((c) => [c.para, c.quote])).toEqual([
      [11, "removal was high"],
      [10, "We operated the reactor for 30"],
    ]);
    expect(call.mock.calls[0][0].user).toContain(supervisorRole("thesis"));
    expect(call.mock.calls[0][0].user).toContain("[P2] The removal was high");
  });
});
