# Wetenschappelijk Schrijven – Word-add-in

Een persoonlijke Word-add-in die meekijkt bij het schrijven van wetenschappelijke teksten (MSc Environmental
Sciences, WUR). Hij gebruikt de Claude API met **je eigen API key** en werkt met wisselbare projectprofielen
(standaard **MABR** en **MEM-EIP**).

**Wat hij kan**

| Tabblad | Wat |
|---|---|
| **Suggesties** | Kronkels in je tekst + lijst per categorie: taal, stijl, claimsterkte, helderheid, consistentie (Haiku), technisch (Sonnet), notatie (lokaal, gratis). Per melding: **Toepassen**, **Waarom?**, **Negeer altijd**. |
| **Parafraseer** | Selecteer ≥ 5 woorden → vier varianten (wetenschappelijker, formeler, beknopter, voorzichtiger) met **Vervang**. |
| **Tools** | NL → wetenschappelijk Engels, sectie nakijken, begeleidersmodus, inkorten tot X woorden, figuren & tabellen, afkortingenlijst, termconsistentie. |
| **AI-check** | (fase 8) koppeling met je lokale AI-detector. |
| **Profiel** | Profielen beheren, woordenlijst, afkortingen, feitenblad, negeerlijst, export/import. |
| **⚙ Instellingen** | API key, modellen, budget, koers, aan/uit per categorie en functie, track changes. |

Onderin staat altijd de kostenmeter: `€ x,xx / € 15,00 deze maand` (waarschuwing bij 80 %, stop bij 100 % met
knop **Limiet deze maand verhogen**; op de 1e van de maand weer € 15).

---

## Privacy en veiligheid

- Je **API key** staat alleen in de lokale opslag van de add-in op je eigen computer. Niet in de code, niet op
  GitHub, niet in het manifest en niet in het Word-document.
- In het Word-document wordt alleen de **naam** van het gekoppelde profiel opgeslagen.
- De add-in praat alleen met de Claude API (`api.anthropic.com`) en — vanaf fase 8 — met je eigen detector op
  `localhost`. Geen telemetrie, geen andere diensten.
- Er gaat alleen tekst naar Claude als een functie dat nodig heeft (live controle van gewijzigde alinea's,
  parafraseren, tools). Notatie, figuren & tabellen en de afkortingenlijst werken volledig lokaal.

---

## Installeren (definitieve versie, via GitHub Pages)

De add-in staat online op `https://hellingsmark-blip.github.io/wetenschappelijk-schrijven/`.
Je hoeft daarvoor niets te laten draaien op je computer.

### Stap 1 – manifest downloaden

Op Windows doet manier 1 hieronder dit automatisch. Anders: open in je browser
`https://hellingsmark-blip.github.io/wetenschappelijk-schrijven/manifest.xml`, klik met rechts → **Opslaan als…**
en bewaar het bestand ergens buiten de projectmap (daar staat het ontwikkel-manifest met dezelfde naam).

### Stap 2a – Word op Windows

**Manier 1 (makkelijkst): via het register.** Sluit Word. Open PowerShell en plak deze ene regel. Hij downloadt het
manifest naar `%LOCALAPPDATA%\WetenschappelijkSchrijven\` en meldt het aan bij Word:

```powershell
$d = "$env:LOCALAPPDATA\WetenschappelijkSchrijven"; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest -UseBasicParsing "https://hellingsmark-blip.github.io/wetenschappelijk-schrijven/manifest.xml" -OutFile "$d\manifest.xml"; New-Item -Path "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer" -Force | Out-Null; New-ItemProperty -Path "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer" -Name "WetenschappelijkSchrijven" -Value "$d\manifest.xml" -PropertyType String -Force | Out-Null; "Klaar: $d\manifest.xml"
```

Verwijderen kan later met:

```powershell
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer" -Name "WetenschappelijkSchrijven"
```

Start Word → tabblad **Start** → **Schrijfhulp** (rechts). Zie je de knop niet: **Start → Invoegtoepassingen**
(of **Invoegen → Mijn invoegtoepassingen**) → tabblad **Ontwikkelaarsinvoegtoepassingen** → Wetenschappelijk Schrijven.

**Manier 2: "Mijn invoegtoepassing uploaden".** **Start → Invoegtoepassingen → Meer invoegtoepassingen →
Mijn invoegtoepassingen → Mijn invoegtoepassing uploaden** → kies `manifest.xml`.
(Staat deze knop er niet, gebruik dan manier 1 of 3.)

**Manier 3: gedeelde map (werkt altijd, ook als je organisatie uploaden blokkeert).**
1. Maak een map, bijv. `C:\Users\<jij>\Documents\Invoegtoepassingen`, en zet `manifest.xml` erin.
2. Rechtsklik op de map → **Eigenschappen → Delen → Delen…** → jezelf → **Delen**. Noteer het netwerkpad
   (bijv. `\\JOUW-PC\Invoegtoepassingen`).
3. Word → **Bestand → Opties → Vertrouwenscentrum → Instellingen voor het Vertrouwenscentrum →
   Vertrouwde catalogi voor invoegtoepassingen** → plak het netwerkpad bij *Catalogus-URL* → **Catalogus toevoegen** →
   vink **Weergeven in menu** aan → OK → Word herstarten.
4. **Start → Invoegtoepassingen → Mijn invoegtoepassingen → GEDEELDE MAP** → Wetenschappelijk Schrijven → **Toevoegen**.

### Stap 2b – Word op Mac

1. Sluit Word.
2. Open **Finder → Ga → Ga naar map…** en plak: `~/Library/Containers/com.microsoft.Word/Data/Documents/wef`
   (bestaat de map `wef` niet, maak hem dan aan).
3. Kopieer `manifest.xml` in deze map.
4. Start Word → open een document → **Start → Invoegtoepassingen** (of **Invoegen → Mijn invoegtoepassingen**) →
   kies Wetenschappelijk Schrijven.

### Stap 2c – Word Online (browser)

1. Open een document op [office.com](https://www.office.com) of in OneDrive.
2. **Start → Invoegtoepassingen** (of **Invoegen → Invoegtoepassingen**) → **Meer invoegtoepassingen** /
   **Geavanceerd** → **Mijn invoegtoepassingen** → **Mijn invoegtoepassing uploaden** → kies `manifest.xml` → **Uploaden**.
3. **Geen "Mijn invoegtoepassing uploaden"?** Dan heeft de beheerder (bijv. WUR) uploaden uitgezet. Opties:
   - gebruik Word **desktop** met manier 1 of 3 hierboven (dat werkt meestal wel);
   - of log op office.com in met een **persoonlijk Microsoft-account** (gratis) en upload daar.
     Let op: kronkels in de tekst vereisen een Microsoft 365-abonnement; zonder abonnement staan de
     bevindingen alleen in het zijpaneel.
   - In Word Online moet je het uploaden soms na het wissen van je browsergegevens herhalen.

### Stap 3 – API key invullen

Zijpaneel → **⚙ Instellingen** → plak je key (begint met `sk-ant-`) → **Opslaan** → **Test verbinding**.

- **Verlopen of ingetrokken?** Je ziet dan *"API key ongeldig of verlopen — plak een nieuwe key in Instellingen"*.
  Maak een nieuwe key in de Anthropic Console, plak hem in hetzelfde veld en klik **Opslaan**.
- De key geldt per computer **én per installatie**: de definitieve versie en de ontwikkelversie (`npm.cmd start`)
  hebben elk hun eigen opslag. Vul hem dus ook in de definitieve versie één keer in.

### Stap 4 – profielen meenemen uit de ontwikkelversie

Omdat de opslag per installatie apart is, begint de definitieve versie met de standaardprofielen.
Neem je eigen werk mee:
1. In de **ontwikkelversie**: **Profiel → Exporteer alle → Download .json** (of **Kopiëren**).
2. In de **definitieve versie**: **Profiel → Importeren** → kies het bestand (of plak de JSON) → **Importeer**.

---

## Instellingen en aanpassen

- **Budget en koers:** ⚙ Instellingen → Budget. De limiet gaat op de 1e van de maand automatisch terug naar € 15.
- **Modellen:** ⚙ Instellingen → Modellen (live controle = Haiku; parafraseren, technisch en tools = Sonnet).
- **Prijzen per model** (USD per miljoen tokens): `src/config.ts` → `PRICES`.
- **Prompts** (de instructies aan Claude, in het Engels): map `src/prompts/`:
  `liveCheck.ts`, `technical.ts`, `paraphrase.ts`, `tools.ts`, `profileContext.ts`.
  Na het aanpassen van een prompt worden de opgeslagen resultaten van die controle automatisch ongeldig.
- Na een aanpassing in de code: publiceer een nieuwe versie (hieronder).

---

## Een nieuwe versie publiceren

Elke `git push` naar `main` bouwt en publiceert de add-in automatisch (GitHub Actions, ± 2 minuten).

```powershell
npm.cmd test
```

```powershell
git add -A; git commit -m "Beschrijving van de wijziging"; git push
```

- Volg de voortgang op GitHub → tabblad **Actions**.
- Daarna in Word: zijpaneel sluiten en opnieuw openen. Zie je nog de oude versie, wis dan de Office-cache
  (Word helemaal afsluiten):
  - Windows: verwijder de inhoud van `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\`
  - Mac: verwijder de inhoud van `~/Library/Containers/com.microsoft.Word/Data/Library/Caches/`
- Alleen als je `manifest.xml` hebt veranderd (bijv. knopteksten): verhoog `<Version>` in `manifest.xml`,
  publiceer, download het nieuwe manifest en installeer het opnieuw (stap 1–2).

### Eenmalig: GitHub instellen

1. Maak (gratis) een account op [github.com](https://github.com).
2. **New repository** → naam `wetenschappelijk-schrijven` → **Public** → *zonder* README → **Create repository**.
   (GitHub Pages is gratis voor openbare repositories. Er staat niets geheims in de code.)
3. Koppel en push (eenmalig; Windows opent een venster om in te loggen bij GitHub):

   ```powershell
   git remote add origin https://github.com/hellingsmark-blip/wetenschappelijk-schrijven.git; git push -u origin main
   ```

4. Op GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. Tabblad **Actions** → wacht tot "Publiceer op GitHub Pages" groen is. De add-in staat dan op
   `https://hellingsmark-blip.github.io/wetenschappelijk-schrijven/`.

---

## Ontwikkelversie (op je eigen computer)

Eenmalig:

```powershell
npm.cmd install
```

```powershell
npm.cmd run certs
```

Starten (bouwt, start een lokale server op https://localhost:3000 en opent Word met de add-in "(dev)"):

```powershell
npm.cmd start
```

Stoppen:

```powershell
npm.cmd run stop
```

Automatische tests (met een nep-API; er wordt nooit echt tegoed gebruikt):

```powershell
npm.cmd test
```

> PowerShell zegt *"running scripts is disabled"*? Gebruik dan altijd `npm.cmd` in plaats van `npm`.

---

## Problemen oplossen

| Probleem | Oplossing |
|---|---|
| Knop **Schrijfhulp** ontbreekt | **Start → Invoegtoepassingen → Mijn invoegtoepassingen** en kies de add-in; of installeer opnieuw (stap 2). |
| Zijpaneel blijft leeg/wit | Controleer of `https://hellingsmark-blip.github.io/wetenschappelijk-schrijven/taskpane.html` opent in je browser. Wis de Office-cache (zie boven). |
| "API key ongeldig of verlopen" | Nieuwe key in ⚙ Instellingen plakken → **Opslaan**. |
| "Maandbudget bereikt" | Klik **Limiet deze maand verhogen**, of wacht tot de 1e. Notatie werkt gewoon door. |
| Geen kronkels, wel lijst | Je Word-versie of account ondersteunt de annotaties-API niet (WordApi 1.7, Microsoft 365 vereist). Zie ⚙ Instellingen → Omgeving. |
| Profiel/instellingen weg | De definitieve versie en de ontwikkelversie hebben elk eigen opslag; gebruik export/import (stap 4). |

---

## Opbouw van het project

```
manifest.xml              ontwikkel-manifest (localhost:3000)
scripts/make-manifest.js  maakt het definitieve manifest voor GitHub Pages
.github/workflows/        automatisch bouwen en publiceren
src/config.ts             modellen, prijzen, standaardwaarden
src/prompts/              alle instructies aan Claude (Engels)
src/api/claude.ts         aanroep Claude API (retries, foutmeldingen, kosten)
src/features/             logica zonder Word (live controle, tools, parafraseren)
src/notation/rules.ts     lokale notatieregels
src/word/                 alles wat met Word praat (alinea's, kronkels, vervangen)
src/ui/                   de tabbladen van het zijpaneel
tests/                    automatische tests (nep-API)
```
