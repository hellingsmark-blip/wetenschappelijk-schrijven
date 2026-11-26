import { describe, expect, it } from "vitest";
import { checkNotation, NotationFinding, Segment } from "../src/notation/rules";

/** Schrijft segmenten leesbaar uit: _x_ = subscript, ^x^ = superscript. */
const show = (segs: Segment[]) =>
  segs.map((s) => (s.script === "sub" ? `_${s.text}_` : s.script === "sup" ? `^${s.text}^` : s.text)).join("");
const fixes = (text: string) => checkNotation(text).map((f: NotationFinding) => `${f.quote} => ${show(f.segments)}`);

describe("chemische formules", () => {
  it("zet aantallen in subscript", () => {
    expect(fixes("Water (H2O) and CO2 were measured.")).toEqual(["H2O => H_2_O", "CO2 => CO_2_"]);
  });
  it("ladingen in superscript", () => {
    expect(fixes("Removal of NH4+ and NO3- was high.")).toEqual(["NH4+ => NH_4_^+^", "NO3- => NO_3_^-^"]);
    expect(fixes("Na+ and Cl- ions")).toEqual(["Na+ => Na^+^", "Cl- => Cl^-^"]);
  });
  it("SO4 2- en Ca2+", () => {
    expect(fixes("sulphate (SO4 2-) and Ca2+")).toEqual(["SO4 2- => SO_4_^2-^", "Ca2+ => Ca^2+^"]);
  });
  it("NH4+-N en NO3--N", () => {
    expect(fixes("NH4+-N and NO3--N")).toEqual(["NH4+ => NH_4_^+^", "NO3- => NO_3_^-^"]);
    expect(fixes("NO3-N was low")).toEqual(["NO3 => NO_3_"]);
  });
  it("koppelteken na neutraal molecuul is geen lading", () => {
    expect(fixes("CO2- and CH4-emissions")).toEqual(["CO2 => CO_2_", "CH4 => CH_4_"]);
  });
  it("geen fout-positieven bij labels en afkortingen", () => {
    expect(fixes("Reactor R1, sample M2, Fig. 2, Table S2, sample C1 and K3")).toEqual([]);
    expect(fixes("The MABR, WWTP, COD, BOD5, PVDF, AEM, CEM and MEM-EIP")).toEqual([]);
    expect(fixes("N- and P-removal, C++ code, In 2021, As shown")).toEqual([]);
  });
  it("respecteert de negeerlijst", () => {
    expect(checkNotation("CO2 and H2O", ["CO2"]).map((f) => f.quote)).toEqual(["H2O"]);
  });
});

describe("eenheden met exponent", () => {
  it("negatieve exponenten", () => {
    expect(fixes("a load of 2 g N m-2 d-1")).toEqual(["m-2 => m^-2^", "d-1 => d^-1^"]);
    expect(fixes("20 mol L-1 and 5 mA cm^-2")).toEqual(["L-1 => L^-1^", "cm^-2 => cm^-2^"]);
  });
  it("m2 en m3 na een getal", () => {
    expect(fixes("a volume of 5 m3 and 10 m2")).toEqual(["m3 => m^3^", "m2 => m^2^"]);
  });
  it("geen labels als sample S-1 of A-1", () => {
    expect(fixes("sample S-1 and type A-1")).toEqual([]);
    expect(fixes("see S1 and S2")).toEqual([]);
  });
});

describe("spatie tussen getal en eenheid", () => {
  it("voegt een spatie toe", () => {
    expect(fixes("at 5mA for 24h with 0.5mm")).toEqual(["5mA => 5 mA", "24h => 24 h", "0.5mm => 0.5 mm"]);
  });
  it("combineert spatie en exponent", () => {
    expect(fixes("a flux of 10cm-2")).toEqual(["10cm-2 => 10 cm^-2^"]);
  });
  it("niet bij %, °, jaartallen en figuurlabels", () => {
    expect(fixes("85% at 20°C in the 1990s, see Fig. 5A and 1st and 2nd")).toEqual([]);
  });
  it("al goed geschreven tekst geeft niets", () => {
    expect(fixes("At 5 mA and 20 °C, the load was 2 g N per day.")).toEqual([]);
  });
});

describe("posities", () => {
  it("telt de hoeveelste keer een quote voorkomt", () => {
    const f = checkNotation("CO2 here and CO2 there");
    expect(f.map((x) => x.occurrence)).toEqual([0, 1]);
    expect(f[1].start).toBe(13);
  });
});
