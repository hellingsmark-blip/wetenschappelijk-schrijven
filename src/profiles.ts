/**
 * Projectprofielen: opslaan, wisselen, aanmaken/dupliceren/hernoemen/verwijderen, import/export (JSON).
 * Alles staat in localStorage van de add-in; in het document staat alleen de profielnaam.
 */
import { loadJSON, saveJSON } from "./storage";

export type DocType = "verslag" | "thesis" | "artikel" | "presentatietekst";

export interface Profile {
  name: string;
  variant: "British" | "American";
  allowWe: boolean;
  allowI: boolean;
  /** Voorkeursterm + te vermijden varianten. */
  glossary: { preferred: string; avoid: string[] }[];
  abbreviations: { short: string; full: string }[];
  field: string;
  supervisorWishes: string;
  docType: DocType;
  factsText: string;
  facts: { key: string; value: string }[];
  ignore: string[];
}

export function blank(name: string): Profile {
  return {
    name,
    variant: "British",
    allowWe: true,
    allowI: false,
    glossary: [],
    abbreviations: [],
    field: "",
    supervisorWishes: "",
    docType: "verslag",
    factsText: "",
    facts: [],
    ignore: [],
  };
}

export function starterProfiles(): Profile[] {
  const mabr = blank("MABR");
  mabr.field = "Wastewater treatment, membrane aerated biofilm reactors (MABR), nitrification/denitrification, Dutch WWTPs (rwzi's)";
  mabr.docType = "verslag";
  mabr.glossary = [{ preferred: "MABR", avoid: ["membrane aerated bioreactor", "membrane-aerated bioreactor"] }];
  mabr.abbreviations = [{ short: "MABR", full: "membrane aerated biofilm reactor" }];
  mabr.facts = [
    "Membrane type", "Membrane surface area", "Air supply / oxygen pressure", "Oxygen transfer rate (OTR)",
    "Loading rate (g N m-2 d-1)", "Nitrification rate", "HRT", "SRT", "Temperature",
    "Influent NH4+-N", "Influent COD", "Biofilm thickness", "WWTP locations mentioned",
  ].map((key) => ({ key, value: "" }));

  const mem = blank("MEM-EIP");
  mem.field = "Electrochemical desalination, ion-exchange membranes, MEM-EIP versus cation-shuttling electrode (CSE)";
  mem.docType = "thesis";
  mem.abbreviations = [
    { short: "CSE", full: "cation-shuttling electrode" },
    { short: "AEM", full: "anion exchange membrane" },
    { short: "CEM", full: "cation exchange membrane" },
  ];
  mem.facts = ["Membranes", "Electrodes", "Current density", "Flow rate", "Concentrations", "Definition MEM-EIP", "Definition CSE"]
    .map((key) => ({ key, value: "" }));
  return [mabr, mem];
}

interface ProfileStore {
  profiles: Profile[];
  active: string;
}

export function loadProfiles(): ProfileStore {
  const s = loadJSON<ProfileStore | null>("profiles", null);
  if (s && s.profiles.length) return s;
  const fresh = { profiles: starterProfiles(), active: "MABR" };
  saveJSON("profiles", fresh);
  return fresh;
}

export function saveProfiles(s: ProfileStore): void {
  saveJSON("profiles", s);
}

export function activeProfile(): Profile {
  const s = loadProfiles();
  return s.profiles.find((p) => p.name === s.active) || s.profiles[0];
}

export function setActiveProfile(name: string): void {
  const s = loadProfiles();
  if (s.profiles.some((p) => p.name === name)) {
    s.active = name;
    saveProfiles(s);
  }
}

// ---------- Beheer ----------

const DOC_TYPES: DocType[] = ["verslag", "thesis", "artikel", "presentatietekst"];
const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");

/** Maakt van willekeurige (geïmporteerde) JSON een geldig profiel, of null. */
export function normalizeProfile(x: unknown): Profile | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const name = str(o.name, 60).trim();
  if (!name) return null;
  const p = blank(name);
  p.variant = o.variant === "American" ? "American" : "British";
  p.allowWe = o.allowWe !== false;
  p.allowI = o.allowI === true;
  p.field = str(o.field);
  p.supervisorWishes = str(o.supervisorWishes);
  p.docType = DOC_TYPES.includes(o.docType as DocType) ? (o.docType as DocType) : "verslag";
  p.factsText = str(o.factsText, 20000);
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  p.glossary = arr(o.glossary)
    .map((g: Record<string, unknown>) => ({
      preferred: str(g?.preferred, 200).trim(),
      avoid: arr(g?.avoid).map((a) => str(a, 200).trim()).filter(Boolean),
    }))
    .filter((g) => g.preferred);
  p.abbreviations = arr(o.abbreviations)
    .map((a: Record<string, unknown>) => ({ short: str(a?.short, 40).trim(), full: str(a?.full, 200).trim() }))
    .filter((a) => a.short);
  p.facts = arr(o.facts)
    .map((f: Record<string, unknown>) => ({ key: str(f?.key, 200).trim(), value: str(f?.value, 2000) }))
    .filter((f) => f.key);
  p.ignore = arr(o.ignore).map((t) => str(t, 300)).filter(Boolean);
  return p;
}

function uniqueName(s: ProfileStore, base: string): string {
  let name = base;
  for (let n = 2; s.profiles.some((p) => p.name === name); n++) name = `${base} (${n})`;
  return name;
}

/** Werkt het actieve profiel bij en slaat op. */
export function updateActive(change: (p: Profile) => void): Profile {
  const s = loadProfiles();
  const p = s.profiles.find((x) => x.name === s.active) || s.profiles[0];
  change(p);
  saveProfiles(s);
  return p;
}

export function createProfile(name: string): string {
  const s = loadProfiles();
  const n = uniqueName(s, name.trim() || "Nieuw profiel");
  s.profiles.push(blank(n));
  s.active = n;
  saveProfiles(s);
  return n;
}

export function duplicateActive(): string {
  const s = loadProfiles();
  const p = s.profiles.find((x) => x.name === s.active) || s.profiles[0];
  const copy = normalizeProfile(JSON.parse(JSON.stringify(p)))!;
  copy.name = uniqueName(s, p.name + " kopie");
  s.profiles.push(copy);
  s.active = copy.name;
  saveProfiles(s);
  return copy.name;
}

/** Geeft een foutmelding terug, of "" als het gelukt is. */
export function renameActive(newName: string): string {
  const s = loadProfiles();
  const name = newName.trim().slice(0, 60);
  if (!name) return "Vul een naam in.";
  if (s.profiles.some((p) => p.name === name && p.name !== s.active)) return "Er bestaat al een profiel met die naam.";
  const p = s.profiles.find((x) => x.name === s.active) || s.profiles[0];
  p.name = name;
  s.active = name;
  saveProfiles(s);
  return "";
}

export function deleteActive(): string {
  const s = loadProfiles();
  if (s.profiles.length <= 1) return "Je kunt het laatste profiel niet verwijderen.";
  s.profiles = s.profiles.filter((p) => p.name !== s.active);
  s.active = s.profiles[0].name;
  saveProfiles(s);
  return "";
}

export function exportProfiles(all: boolean): string {
  const s = loadProfiles();
  const list = all ? s.profiles : [s.profiles.find((x) => x.name === s.active) || s.profiles[0]];
  return JSON.stringify({ app: "Wetenschappelijk Schrijven", version: 1, profiles: list }, null, 2);
}

/** Importeert één profiel, een lijst, of een export van deze add-in. Profielen met dezelfde naam worden vervangen. */
export function importProfiles(json: string): { added: string[]; replaced: string[] } {
  const data = JSON.parse(json);
  const raw: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : [data];
  const list = raw.map(normalizeProfile).filter((p): p is Profile => !!p);
  if (!list.length) throw new Error("Geen geldig profiel gevonden in deze JSON.");
  const s = loadProfiles();
  const added: string[] = [];
  const replaced: string[] = [];
  for (const p of list) {
    const i = s.profiles.findIndex((x) => x.name === p.name);
    if (i >= 0) {
      s.profiles[i] = p;
      replaced.push(p.name);
    } else {
      s.profiles.push(p);
      added.push(p.name);
    }
  }
  saveProfiles(s);
  return { added, replaced };
}

/** "Negeer altijd": tekst op de negeerlijst van het actieve profiel zetten of eraf halen. */
export function addIgnore(text: string): void {
  const s = loadProfiles();
  const p = s.profiles.find((x) => x.name === s.active) || s.profiles[0];
  if (!p.ignore.includes(text)) p.ignore.push(text);
  saveProfiles(s);
}
export function removeIgnore(text: string): void {
  const s = loadProfiles();
  const p = s.profiles.find((x) => x.name === s.active) || s.profiles[0];
  p.ignore = p.ignore.filter((t) => t !== text);
  saveProfiles(s);
}

/**
 * Koppeling profiel ↔ document: alleen de profielNAAM gaat in de documentinstellingen
 * (die reizen mee in het .docx). Nooit de API key of andere gevoelige gegevens.
 */
const DOC_SETTING = "wsProfileName";

export function profileForDocument(): string | null {
  try {
    const v = Office.context.document.settings.get(DOC_SETTING);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Laatste resultaat van het opslaan in het document (voor de diagnoseregel). */
export let lastDocSaveResult = "nog niet geprobeerd";

export function linkProfileToDocument(name: string): void {
  try {
    Office.context.document.settings.set(DOC_SETTING, name);
    Office.context.document.settings.saveAsync((r) => {
      lastDocSaveResult = r.status === Office.AsyncResultStatus.Succeeded ? "gelukt" : "mislukt: " + r.error?.message;
    });
  } catch (e) {
    lastDocSaveResult = "niet beschikbaar: " + String(e);
  }
}
