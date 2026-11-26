/**
 * Notatie (fase 3): lokale, regelgebaseerde controle — geen API, geen kosten.
 *
 * Drie regels:
 *  1. Chemische formules: H2O → H₂O, NH4+ → NH₄⁺, SO4 2- → SO₄²⁻, Ca2+ → Ca²⁺
 *  2. Eenheden met exponent: cm-2 / cm^-2 → cm⁻², m3 → m³, mol L-1 → mol L⁻¹
 *  3. Spatie tussen getal en eenheid: 5mA → 5 mA (niet bij % en °)
 *
 * De uitkomst is een lijst "segmenten" (tekst + sub/superscript). Die worden in Word met échte
 * opmaak (font.subscript / font.superscript) toegepast, niet met Unicode-tekens.
 *
 * Liever een gemiste melding dan een foute: bij twijfel (labels als M2, R1, Fig. 2, S1) niets melden.
 */

export interface Segment {
  text: string;
  script?: "sub" | "sup";
}

export type NotationKind = "formula" | "unit-exp" | "spacing";

export interface NotationFinding {
  kind: NotationKind;
  /** Letterlijke tekst in de alinea die vervangen wordt. */
  quote: string;
  /** Positie in de alineatekst. */
  start: number;
  /** Hoeveelste keer (0 = eerste) deze quote in de alinea voorkomt; nodig om in Word de juiste treffer te kiezen. */
  occurrence: number;
  /** Nieuwe inhoud. */
  segments: Segment[];
  /** Korte titel (Nederlands) voor het zijpaneel. */
  title: string;
  /** Uitleg (Nederlands), voor "Waarom?". */
  why: string;
  /** true = alleen melden als Word laat zien dat er nog géén sub/superscript op staat. */
  needsFormatCheck: boolean;
  /** Stukje omringende tekst om de plek te herkennen. */
  before: string;
  after: string;
}

// ---------- Herkenningslijsten ----------

export const ELEMENTS = new Set(
  ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
    "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm " +
    "Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No " +
    "Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" ")
);

/** Eén element met een getal is meestal een label (C1, S2, K3); alleen deze moleculen tellen. */
const SINGLE_ELEMENT_OK = new Set(["H2", "N2", "O2", "O3", "Cl2", "F2", "Br2", "I2", "S8", "P4"]);

/** Ionen zonder getal: alleen deze (anders te veel fout-positieven, bv. "N- and P-removal"). */
const IONS_WITHOUT_DIGIT = new Set(["H+", "Li+", "Na+", "K+", "Ag+", "Cs+", "Rb+", "Cu+", "Cl-", "F-", "Br-", "OH-", "HS-", "CN-", "SCN-"]);

/** Neutrale moleculen: een streepje erna is een koppelteken ("CO2- and CH4-emissions"), geen lading. */
const NEUTRAL = new Set(["CO2", "CH4", "N2O", "H2O", "O2", "N2", "NH3", "H2S", "H2", "O3", "SO2", "CO"]);

/** Woorden waarna een nummer een label is (Fig. 5A, Table S2, Sample 3m). */
const LABEL_WORDS = /^(fig|figs|figure|figures|table|tables|eq|eqs|equation|equations|section|appendix|chapter|sample|samples|reactor|run|phase|stage|panel|no|nr|model|type|case|group|scenario|option|experiment|exp|test|batch|series|version|step|level|site|zone|point|line|cell|module)\.?$/i;

/** Eenheden (hoofdlettergevoelig). */
export const UNITS = [
  "m", "cm", "mm", "µm", "μm", "um", "nm", "km", "dm",
  "L", "mL", "µL", "μL", "dL",
  "g", "kg", "mg", "µg", "μg", "ng",
  "mol", "mmol", "µmol", "μmol", "kmol", "eq", "meq",
  "s", "ms", "min", "h", "d", "yr",
  "A", "mA", "µA", "μA", "V", "mV", "kV", "W", "mW", "kW", "MW", "Wh", "kWh", "J", "kJ", "MJ",
  "Pa", "kPa", "MPa", "bar", "mbar", "S", "mS", "µS", "μS", "Ω", "kΩ", "K", "Hz", "kHz", "Da", "kDa",
];
const UNIT_SET = new Set(UNITS);
/** Lengte-eenheden waarbij een getal zonder minteken (m2, m3) een exponent is. */
const AREA_VOLUME = new Set(["m", "cm", "mm", "µm", "μm", "um", "nm", "km", "dm"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UNIT_ALT = [...UNITS].sort((a, b) => b.length - a.length).map(esc).join("|");

const MINUS = /[-−]/;

// ---------- Hulpfuncties ----------

function merge(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.script === s.script) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

function prevWord(text: string, start: number): string {
  const m = /(\S+)\s*$/.exec(text.slice(0, start));
  return m ? m[1] : "";
}

function stripPunct(t: string): string {
  return t.replace(/^[([{]+/, "").replace(/[,;:)\]}.]+$/, "");
}

function isUnitLike(tok: string): boolean {
  const t = stripPunct(tok).replace(/\^?[-−]?\d$/, "");
  return UNIT_SET.has(t) || t.split("/").every((p) => UNIT_SET.has(p));
}

/** Staat er vóór de eenheid iets wat op een hoeveelheid wijst (getal, andere eenheid, "N", "COD")? */
function unitContextOk(text: string, start: number): boolean {
  const ch = text[start - 1];
  if (ch === undefined) return false;
  if (ch === "(" || ch === "[" || ch === "/" || ch === "·" || ch === "⋅") return true;
  if (!/\s/.test(ch)) return false;
  const prev = prevWord(text, start);
  const p = stripPunct(prev);
  return /\d$/.test(p) || isUnitLike(prev) || /^[A-Z][A-Z0-9+\-−]{0,7}$/.test(p);
}

/** Geldige exponent? Zonder minteken en zonder ^ alleen bij lengte-eenheden (m2, cm3). */
function exponentOk(unit: string, caret: string, minus: string, digit: string): boolean {
  if (minus) return /[1-4]/.test(digit);
  if (caret) return /[2-4]/.test(digit);
  return AREA_VOLUME.has(unit) && (digit === "2" || digit === "3");
}

function countBefore(text: string, quote: string, start: number): number {
  let n = 0;
  let i = text.indexOf(quote);
  while (i !== -1 && i < start) {
    n++;
    i = text.indexOf(quote, i + quote.length);
  }
  return n;
}

// ---------- Regel 1: chemische formules ----------

function checkFormulas(text: string, out: Omit<NotationFinding, "occurrence" | "before" | "after">[]): void {
  const tokenRe = /(?<![A-Za-z0-9])[A-Z][A-Za-z0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    const parts = token.match(/[A-Z][a-z]?|\d+/g) || [];
    if (parts.join("") !== token) continue; // bevat iets anders dan symbolen + cijfers
    const symbols = parts.filter((p) => !/\d/.test(p));
    const digits = parts.filter((p) => /\d/.test(p));
    if (!symbols.every((s) => ELEMENTS.has(s))) continue;
    if (digits.some((d) => d === "1" || d.startsWith("0") || d.length > 2)) continue; // labels / geen formule
    if (LABEL_WORDS.test(prevWord(text, start))) continue;

    // Lading direct erachter (+, -, −) of met spatie en getal ("SO4 2-").
    const rest = text.slice(end);
    let charge = "";
    let chargeLen = 0;
    let digitIsCharge = false;
    const multi = symbols.length > 1;
    const direct = /^([+\-−])(?![A-Za-z0-9+])/.exec(rest);
    const spaced = /^ (\d)([+\-−])(?![A-Za-z0-9+])/.exec(rest);
    if (direct && !(MINUS.test(direct[1]) && NEUTRAL.has(token))) {
      charge = direct[1];
      chargeLen = 1;
      const lastPart = parts[parts.length - 1];
      if (!multi && /^\d$/.test(lastPart)) digitIsCharge = true; // Ca2+ → Ca²⁺
      else if (multi && /^\d{2}$/.test(lastPart)) continue; // "PO43-": dubbelzinnig, overslaan
    } else if (spaced && multi && /\d$/.test(token)) {
      charge = spaced[1] + spaced[2];
      chargeLen = spaced[0].length;
    }

    const hasDigit = digits.length > 0;
    if (!hasDigit && !charge) continue;
    if (!hasDigit && !IONS_WITHOUT_DIGIT.has(token + charge.replace("−", "-"))) continue;
    if (!multi && hasDigit && !charge && !SINGLE_ELEMENT_OK.has(token)) continue;

    const segs: Segment[] = [];
    parts.forEach((p, i) => {
      const isLast = i === parts.length - 1;
      if (/\d/.test(p)) segs.push({ text: p, script: digitIsCharge && isLast ? "sup" : "sub" });
      else segs.push({ text: p });
    });
    if (charge) segs.push({ text: charge, script: "sup" });

    out.push({
      kind: "formula",
      quote: text.slice(start, end + chargeLen),
      start,
      segments: merge(segs),
      title: "Chemische formule",
      why: "Aantallen atomen horen in subscript en ladingen in superscript (bv. NH₄⁺, SO₄²⁻).",
      needsFormatCheck: true,
    });
  }
}

// ---------- Regel 2: eenheden met exponent ----------

function checkUnitExponents(text: string, out: Omit<NotationFinding, "occurrence" | "before" | "after">[]): void {
  // Niet direct na een cijfer: dat geval ("5cm-2") pakt de spatieregel samen op.
  const re = new RegExp(`(?<![A-Za-z0-9µμΩ])(${UNIT_ALT})(\\^?)([-−]?)(\\d)(?![A-Za-z0-9])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [quote, unit, caret, minus, digit] = m;
    if (!exponentOk(unit, caret, minus, digit)) continue;
    if (!unitContextOk(text, m.index)) continue;
    out.push({
      kind: "unit-exp",
      quote,
      start: m.index,
      segments: merge([{ text: unit }, { text: minus + digit, script: "sup" }]),
      title: "Eenheid met exponent",
      why: "Exponenten in eenheden horen in superscript (bv. g N m⁻² d⁻¹, mol L⁻¹), zonder ^.",
      needsFormatCheck: true,
    });
  }
}

// ---------- Regel 3: spatie tussen getal en eenheid ----------

function checkSpacing(text: string, out: Omit<NotationFinding, "occurrence" | "before" | "after">[]): void {
  const re = new RegExp(
    `(?<![A-Za-z0-9.,])(\\d+(?:[.,]\\d+)?)(${UNIT_ALT})(?:(\\^?)([-−]?)(\\d))?(?![A-Za-z0-9µμ])`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [quote, num, unit, caret = "", minus = "", digit = ""] = m;
    if (digit && !exponentOk(unit, caret, minus, digit)) continue;
    const prev = prevWord(text, m.index);
    if (LABEL_WORDS.test(prev)) continue; // Fig. 5A, Table 2S
    // "the 1990s", "the 80s" zijn jaartallen, geen seconden.
    if (unit === "s" && (/^(19|20)\d0$/.test(num) || /^(the|early|mid|late)$/i.test(prev))) continue;
    const segs: Segment[] = [{ text: num + " " + unit }];
    if (digit) segs.push({ text: minus + digit, script: "sup" });
    out.push({
      kind: "spacing",
      quote,
      start: m.index,
      segments: merge(segs),
      title: digit ? "Spatie + exponent bij eenheid" : "Spatie tussen getal en eenheid",
      why: "Tussen een getal en de eenheid hoort een spatie (5 mA, 20 mg L⁻¹); alleen bij % en ° niet.",
      needsFormatCheck: false, // de ontbrekende spatie is hoe dan ook fout
    });
  }
}

// ---------- Publieke functie ----------

/**
 * Controleert één alineatekst. `ignore` = teksten die de gebruiker met "Negeer altijd" heeft weggezet.
 */
export function checkNotation(text: string, ignore: string[] = []): NotationFinding[] {
  const raw: Omit<NotationFinding, "occurrence" | "before" | "after">[] = [];
  checkFormulas(text, raw);
  checkUnitExponents(text, raw);
  checkSpacing(text, raw);

  // Overlappende bevindingen: de eerste (en bij gelijke start de langste) wint.
  raw.sort((a, b) => a.start - b.start || b.quote.length - a.quote.length);
  const ignored = new Set(ignore);
  const out: NotationFinding[] = [];
  let lastEnd = -1;
  for (const f of raw) {
    if (f.start < lastEnd) continue;
    lastEnd = f.start + f.quote.length;
    if (ignored.has(f.quote)) continue;
    out.push({
      ...f,
      occurrence: countBefore(text, f.quote, f.start),
      before: text.slice(Math.max(0, f.start - 30), f.start),
      after: text.slice(f.start + f.quote.length, f.start + f.quote.length + 30),
    });
  }
  return out;
}

/** Tekst zoals hij na toepassen in Word wordt (zonder opmaak), bv. voor tests. */
export function plainText(segs: Segment[]): string {
  return segs.map((s) => s.text).join("");
}
