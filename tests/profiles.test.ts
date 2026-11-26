import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import {
  activeProfile, createProfile, deleteActive, duplicateActive, exportProfiles, importProfiles, loadProfiles,
  normalizeProfile, renameActive, setActiveProfile, updateActive,
} from "../src/profiles";

beforeEach(() => useStore(createMemoryStore()));

describe("profielbeheer", () => {
  it("start met MABR actief en MEM-EIP beschikbaar", () => {
    expect(loadProfiles().profiles.map((p) => p.name)).toEqual(["MABR", "MEM-EIP"]);
    expect(activeProfile().name).toBe("MABR");
  });

  it("nieuw, dupliceren met unieke naam, hernoemen en verwijderen", () => {
    expect(createProfile("Artikel")).toBe("Artikel");
    expect(createProfile("Artikel")).toBe("Artikel (2)");
    setActiveProfile("MABR");
    updateActive((p) => (p.facts[0].value = "PVDF"));
    const copy = duplicateActive();
    expect(copy).toBe("MABR kopie");
    expect(activeProfile().facts[0].value).toBe("PVDF");
    expect(renameActive("MEM-EIP")).toMatch(/bestaat al/);
    expect(renameActive("MABR v2")).toBe("");
    expect(activeProfile().name).toBe("MABR v2");
    expect(deleteActive()).toBe("");
    expect(loadProfiles().profiles.some((p) => p.name === "MABR v2")).toBe(false);
  });

  it("het laatste profiel kan niet weg", () => {
    deleteActive();
    expect(deleteActive()).toMatch(/laatste/);
  });

  it("export → import is verliesvrij en vervangt bij dezelfde naam", () => {
    updateActive((p) => {
      p.glossary.push({ preferred: "biofilm", avoid: ["bio-film"] });
      p.ignore.push("CO2");
    });
    const json = exportProfiles(false);
    expect(json).not.toMatch(/sk-ant/);
    updateActive((p) => (p.field = "veranderd"));
    const r = importProfiles(json);
    expect(r.replaced).toEqual(["MABR"]);
    expect(activeProfile().field).not.toBe("veranderd");
    expect(activeProfile().glossary.at(-1)).toEqual({ preferred: "biofilm", avoid: ["bio-film"] });
  });

  it("import accepteert één los profiel en weigert onzin", () => {
    expect(importProfiles(JSON.stringify({ name: "Los", variant: "American" })).added).toEqual(["Los"]);
    expect(() => importProfiles(JSON.stringify({ foo: 1 }))).toThrow(/Geen geldig profiel/);
  });

  it("normalizeProfile vult ontbrekende velden en filtert rommel", () => {
    const p = normalizeProfile({ name: " X ", docType: "roman", abbreviations: [{ short: "", full: "x" }, { short: "SRT", full: "sludge retention time" }] })!;
    expect(p.name).toBe("X");
    expect(p.docType).toBe("verslag");
    expect(p.variant).toBe("British");
    expect(p.abbreviations).toEqual([{ short: "SRT", full: "sludge retention time" }]);
    expect(normalizeProfile({ name: "" })).toBeNull();
  });
});
