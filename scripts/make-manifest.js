/**
 * Maakt het definitieve manifest (voor GitHub Pages) uit het ontwikkel-manifest.
 *
 * Gebruik:  node scripts/make-manifest.js https://<gebruikersnaam>.github.io/<repo> dist/manifest.xml
 *
 * - alle adressen https://localhost:3000 → het opgegeven adres;
 * - eigen Id, zodat de dev- en de echte versie naast elkaar geïnstalleerd kunnen zijn;
 * - naam zonder "(dev)".
 * Er staat niets geheims in het manifest (geen API key).
 */
const fs = require("fs");
const path = require("path");

const PROD_ID = "3f9d2c61-5b7e-4a8c-9e14-6d2b8f0c7a95";

const base = (process.argv[2] || "").replace(/\/+$/, "");
const out = process.argv[3] || "dist/manifest.xml";
if (!/^https:\/\/[^/]+(\/.*)?$/.test(base)) {
  console.error("Geef het https-adres van de site op, bv. https://jouwnaam.github.io/wetenschappelijk-schrijven");
  process.exit(1);
}
const origin = new URL(base).origin;

let xml = fs.readFileSync(path.join(__dirname, "..", "manifest.xml"), "utf8");
xml = xml
  .replace(/<!--[\s\S]*?-->\s*<OfficeApp/, "<!-- Definitief manifest (gegenereerd door scripts/make-manifest.js). -->\n<OfficeApp")
  .replace(/<Id>[^<]+<\/Id>/, `<Id>${PROD_ID}</Id>`)
  .replace("Wetenschappelijk Schrijven (dev)", "Wetenschappelijk Schrijven")
  .replace(/<AppDomain>https:\/\/localhost:3000<\/AppDomain>/, `<AppDomain>${origin}</AppDomain>`)
  .replace(/https:\/\/localhost:3000/g, base);

if (/localhost/.test(xml)) {
  console.error("Er staat nog 'localhost' in het manifest — controleer manifest.xml.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, xml);
console.log(`Manifest geschreven naar ${out} (adres: ${base})`);
