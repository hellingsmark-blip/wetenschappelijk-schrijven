/**
 * Zet het actieve projectprofiel om in een vaste tekst die in elke prompt meegaat.
 * De uitvoer is deterministisch (zelfde profiel → exact dezelfde tekst), zodat
 * prompt caching werkt.
 */
import type { Profile } from "../profiles";

export function profileContext(p: Profile): string {
  const lines: string[] = [];
  lines.push(`<project_profile name="${p.name}">`);
  lines.push(`Document type: ${p.docType}`);
  lines.push(`English variant: ${p.variant} English (keep spelling consistent with this variant)`);
  lines.push(`First person "we": ${p.allowWe ? "allowed" : "not allowed"}; "I": ${p.allowI ? "allowed" : "not allowed"}`);
  if (p.field.trim()) lines.push(`Field / context: ${p.field.trim()}`);
  if (p.supervisorWishes.trim()) lines.push(`Supervisor / client wishes: ${p.supervisorWishes.trim()}`);
  if (p.glossary.length) {
    lines.push("Preferred terms (use the preferred form, avoid the variants):");
    p.glossary.forEach((g) => lines.push(`- ${g.preferred}${g.avoid.length ? ` (avoid: ${g.avoid.join("; ")})` : ""}`));
  }
  if (p.abbreviations.length) {
    lines.push("Abbreviations:");
    p.abbreviations.forEach((a) => lines.push(`- ${a.short} = ${a.full}`));
  }
  const facts = p.facts.filter((f) => f.value.trim());
  if (facts.length || p.factsText.trim()) {
    lines.push("Fact sheet (ground truth for this project; empty fields omitted):");
    facts.forEach((f) => lines.push(`- ${f.key}: ${f.value.trim()}`));
    if (p.factsText.trim()) lines.push(p.factsText.trim());
  }
  lines.push("</project_profile>");
  return lines.join("\n");
}
