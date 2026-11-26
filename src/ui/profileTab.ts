/**
 * Tabblad Profiel: profielen beheren en het actieve profiel bewerken (fase 5).
 * Wijzigingen worden direct (na een korte pauze) opgeslagen in localStorage.
 */
import {
  activeProfile, createProfile, deleteActive, DocType, duplicateActive, exportProfiles, importProfiles, Profile,
  renameActive, updateActive,
} from "../profiles";

interface Ctx {
  /** Actief profiel is gewisseld (nieuw, gedupliceerd, hernoemd, verwijderd of geïmporteerd). */
  onSwitched: () => void;
  /** Gebruiker wil alles opnieuw laten controleren met het (bewerkte) profiel. */
  onRecheck: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let ctxRef: Ctx;
let saveTimer: number | undefined;
let nameMode: "new" | "rename" = "new";

function msg(id: string, text: string, kind: "" | "ok" | "err" = ""): void {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + kind;
}

/** Bewaart een wijziging aan het actieve profiel (met een kleine vertraging bij typen). */
function save(change: (p: Profile) => void, delay = 400): void {
  updateActive(change);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(
    () => msg("pfSaved", "Opgeslagen. Nieuwe controles gebruiken dit profiel; klik hierboven om alles opnieuw te controleren."),
    delay
  );
}

// ---------- Tabellen (woordenlijst, afkortingen, feitenblad) ----------

function rowInputs(
  box: HTMLElement, a: string, b: string, phA: string, phB: string,
  onA: (v: string) => void, onB: (v: string) => void, onDelete: () => void
): void {
  const row = document.createElement("div");
  row.className = "kv";
  const ia = document.createElement("input");
  ia.type = "text";
  ia.value = a;
  ia.placeholder = phA;
  ia.addEventListener("input", () => onA(ia.value));
  const ib = document.createElement("input");
  ib.type = "text";
  ib.value = b;
  ib.placeholder = phB;
  ib.addEventListener("input", () => onB(ib.value));
  const del = document.createElement("button");
  del.textContent = "×";
  del.title = "Verwijderen";
  del.addEventListener("click", onDelete);
  row.append(ia, ib, del);
  box.append(row);
}

function renderGlossary(p: Profile): void {
  const box = $("pfGlossary");
  box.innerHTML = "";
  p.glossary.forEach((g, i) =>
    rowInputs(
      box, g.preferred, g.avoid.join(", "), "Voorkeursterm", "Vermijden (komma's)",
      (v) => save((q) => (q.glossary[i].preferred = v)),
      (v) => save((q) => (q.glossary[i].avoid = v.split(",").map((s) => s.trim()).filter(Boolean))),
      () => {
        save((q) => q.glossary.splice(i, 1), 0);
        renderGlossary(activeProfile());
      }
    )
  );
}

function renderAbbr(p: Profile): void {
  const box = $("pfAbbr");
  box.innerHTML = "";
  p.abbreviations.forEach((a, i) =>
    rowInputs(
      box, a.short, a.full, "Afkorting", "Voluit",
      (v) => save((q) => (q.abbreviations[i].short = v.trim())),
      (v) => save((q) => (q.abbreviations[i].full = v)),
      () => {
        save((q) => q.abbreviations.splice(i, 1), 0);
        renderAbbr(activeProfile());
      }
    )
  );
}

function renderFacts(p: Profile): void {
  const box = $("pfFacts");
  box.innerHTML = "";
  p.facts.forEach((f, i) =>
    rowInputs(
      box, f.key, f.value, "Veld", "Waarde (leeg = onbekend)",
      (v) => save((q) => (q.facts[i].key = v)),
      (v) => save((q) => (q.facts[i].value = v)),
      () => {
        save((q) => q.facts.splice(i, 1), 0);
        renderFacts(activeProfile());
      }
    )
  );
}

/** Vult alle velden met het actieve profiel. */
export function renderProfileTab(): void {
  const p = activeProfile();
  $("profileName").textContent = p.name;
  $<HTMLSelectElement>("pfDocType").value = p.docType;
  $<HTMLSelectElement>("pfVariant").value = p.variant;
  $<HTMLInputElement>("pfWe").checked = p.allowWe;
  $<HTMLInputElement>("pfI").checked = p.allowI;
  $<HTMLTextAreaElement>("pfField").value = p.field;
  $<HTMLTextAreaElement>("pfWishes").value = p.supervisorWishes;
  $<HTMLTextAreaElement>("pfFactsText").value = p.factsText;
  renderGlossary(p);
  renderAbbr(p);
  renderFacts(p);
  msg("pfSaved", "");
}

// ---------- Export / import ----------

function showExport(all: boolean): void {
  const json = exportProfiles(all);
  $<HTMLTextAreaElement>("pfExportText").value = json;
  const a = $<HTMLAnchorElement>("pfDownload");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = all ? "profielen-alle.json" : `profiel-${activeProfile().name}.json`;
  $("pfExportBox").classList.remove("hidden");
}

function doImport(json: string): void {
  try {
    const r = importProfiles(json);
    const parts = [];
    if (r.added.length) parts.push(`toegevoegd: ${r.added.join(", ")}`);
    if (r.replaced.length) parts.push(`vervangen: ${r.replaced.join(", ")}`);
    msg("pfImportMsg", "Geïmporteerd — " + parts.join("; ") + ".", "ok");
    $<HTMLTextAreaElement>("pfImportText").value = "";
    ctxRef.onSwitched();
  } catch (e) {
    msg("pfImportMsg", "Importeren mislukt: " + (e instanceof Error ? e.message : String(e)), "err");
  }
}

// ---------- Init ----------

export function initProfileTab(ctx: Ctx): void {
  ctxRef = ctx;

  $<HTMLSelectElement>("pfDocType").addEventListener("change", (e) =>
    save((p) => (p.docType = (e.target as HTMLSelectElement).value as DocType), 0)
  );
  $<HTMLSelectElement>("pfVariant").addEventListener("change", (e) =>
    save((p) => (p.variant = (e.target as HTMLSelectElement).value === "American" ? "American" : "British"), 0)
  );
  $<HTMLInputElement>("pfWe").addEventListener("change", (e) => save((p) => (p.allowWe = (e.target as HTMLInputElement).checked), 0));
  $<HTMLInputElement>("pfI").addEventListener("change", (e) => save((p) => (p.allowI = (e.target as HTMLInputElement).checked), 0));
  $<HTMLTextAreaElement>("pfField").addEventListener("input", (e) => save((p) => (p.field = (e.target as HTMLTextAreaElement).value)));
  $<HTMLTextAreaElement>("pfWishes").addEventListener("input", (e) =>
    save((p) => (p.supervisorWishes = (e.target as HTMLTextAreaElement).value))
  );
  $<HTMLTextAreaElement>("pfFactsText").addEventListener("input", (e) =>
    save((p) => (p.factsText = (e.target as HTMLTextAreaElement).value))
  );

  $("pfGlossaryAdd").addEventListener("click", () => {
    save((p) => p.glossary.push({ preferred: "", avoid: [] }), 0);
    renderGlossary(activeProfile());
  });
  $("pfAbbrAdd").addEventListener("click", () => {
    save((p) => p.abbreviations.push({ short: "", full: "" }), 0);
    renderAbbr(activeProfile());
  });
  $("pfFactsAdd").addEventListener("click", () => {
    save((p) => p.facts.push({ key: "", value: "" }), 0);
    renderFacts(activeProfile());
  });
  $("pfRecheck").addEventListener("click", () => {
    ctx.onRecheck();
    msg("pfSaved", "Eerder gecontroleerde alinea's worden opnieuw gecontroleerd (kost tegoed).", "ok");
  });

  // Nieuw / hernoem: één invoerveld
  const openName = (mode: "new" | "rename") => {
    nameMode = mode;
    $("pfNameLabel").textContent = mode === "new" ? "Naam nieuw profiel" : "Nieuwe naam";
    $<HTMLInputElement>("pfNameInput").value = mode === "rename" ? activeProfile().name : "";
    $("pfNameBox").classList.remove("hidden");
    $("pfDeleteBox").classList.add("hidden");
    $<HTMLInputElement>("pfNameInput").focus();
  };
  $("pfNew").addEventListener("click", () => openName("new"));
  $("pfRename").addEventListener("click", () => openName("rename"));
  $("pfNameCancel").addEventListener("click", () => $("pfNameBox").classList.add("hidden"));
  $("pfNameOk").addEventListener("click", () => {
    const v = $<HTMLInputElement>("pfNameInput").value;
    if (nameMode === "new") {
      const n = createProfile(v);
      msg("pfMsg", `Profiel ${n} aangemaakt en actief.`, "ok");
    } else {
      const err = renameActive(v);
      if (err) return msg("pfMsg", err, "err");
      msg("pfMsg", "Profiel hernoemd.", "ok");
    }
    $("pfNameBox").classList.add("hidden");
    ctx.onSwitched();
  });
  $("pfDup").addEventListener("click", () => {
    const n = duplicateActive();
    msg("pfMsg", `Kopie ${n} gemaakt en actief.`, "ok");
    ctx.onSwitched();
  });
  $("pfDelete").addEventListener("click", () => {
    $("pfDeleteText").textContent = `Profiel ${activeProfile().name} definitief verwijderen? Exporteer het eerst als je het wilt bewaren.`;
    $("pfDeleteBox").classList.remove("hidden");
    $("pfNameBox").classList.add("hidden");
  });
  $("pfDeleteCancel").addEventListener("click", () => $("pfDeleteBox").classList.add("hidden"));
  $("pfDeleteOk").addEventListener("click", () => {
    const err = deleteActive();
    $("pfDeleteBox").classList.add("hidden");
    if (err) return msg("pfMsg", err, "err");
    msg("pfMsg", "Profiel verwijderd.", "ok");
    ctx.onSwitched();
  });

  $("pfExportOne").addEventListener("click", () => showExport(false));
  $("pfExportAll").addEventListener("click", () => showExport(true));
  $("pfCopy").addEventListener("click", async () => {
    const t = $<HTMLTextAreaElement>("pfExportText");
    t.select();
    try {
      await navigator.clipboard.writeText(t.value);
      msg("pfImportMsg", "Gekopieerd naar het klembord.", "ok");
    } catch {
      document.execCommand("copy");
    }
  });
  $<HTMLInputElement>("pfImportFile").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) doImport(await f.text());
    (e.target as HTMLInputElement).value = "";
  });
  $("pfImport").addEventListener("click", () => {
    const t = $<HTMLTextAreaElement>("pfImportText").value.trim();
    if (!t) return msg("pfImportMsg", "Plak eerst JSON of kies een bestand.", "err");
    doImport(t);
  });

  renderProfileTab();
}
