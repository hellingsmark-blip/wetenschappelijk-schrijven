/**
 * Eenvoudige woord-diff (LCS) om in het zijpaneel te tonen welke woorden zijn veranderd.
 */

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

/** Splitst in woorden én de spaties ertussen, zodat de tekst exact terug te bouwen is. */
export function tokenize(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) || [];
}

export function wordDiff(a: string, b: string): DiffPart[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length, m = B.length;
  // LCS-tabel (prima voor alinea's; selectie is begrensd tot een paar honderd woorden).
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("same", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return parts;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** HTML met <ins> voor nieuwe en <del> voor verwijderde woorden. Witruimte-wijzigingen worden niet gemarkeerd. */
export function diffHtml(a: string, b: string): string {
  return wordDiff(a, b)
    .map((p) => {
      const t = escapeHtml(p.text);
      if (p.kind === "same" || !p.text.trim()) return p.kind === "del" ? "" : t;
      return p.kind === "add" ? `<ins>${t}</ins>` : `<del>${t}</del>`;
    })
    .join("");
}

export function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) || []).length;
}
