# Detector-API – contract tussen Word-add-in en AI-detector

Versie: **1**. Dit document is de afspraak tussen de Word-add-in *Wetenschappelijk Schrijven* (tabblad
**AI-check**) en het aparte detectorproject. Beide modi gebruiken **hetzelfde contract**; alleen adres en
authenticatie verschillen.

| Modus | Adres | Authenticatie | Modellen | Kosten |
|---|---|---|---|---|
| **Lokaal** | `https://localhost:8765` | geen | lichte modellen (CPU) | gratis, tekst blijft op de laptop |
| **Cloud** | eigen Modal-endpoint, `https://<iets>.modal.run` | `Authorization: Bearer <token>` | volledige modellen (GPU) | betaald per seconde, eigen limiet |

De add-in stuurt tekst **alleen** naar deze twee adressen (localhost of een `*.modal.run`-adres dat de
gebruiker zelf instelt) en nooit naar externe detectiediensten. Het token staat alleen in de lokale opslag van
de add-in, nooit in het document.

---

## Algemeen

- Alles is JSON (`Content-Type: application/json; charset=utf-8`).
- Alle scores zijn **gekalibreerde kansen dat de tekst door een taalmodel geschreven of herschreven is**, van 0 tot 1.
- Labels: `"human"` (waarschijnlijk menselijk), `"uncertain"` (onzeker), `"ai"` (waarschijnlijk AI). De detector
  bepaalt de drempels (gekalibreerd, gericht op weinig vals-positieven) en kiest `"uncertain"` als de
  onzekerheidsmarge de grens overlapt.
- Zinnen worden teruggegeven als **letterlijke tekst** (`text`), exact zoals in de alinea. De add-in zoekt die
  zelf op in de alinea (geen tekenposities nodig; Python- en JavaScript-posities verschillen bij sommige tekens).
- Lokaal is HTTPS verplicht (de add-in draait op HTTPS). Gebruik bij voorkeur het certificaat van
  `office-addin-dev-certs` (`~/.office-addin-dev-certs/localhost.crt` en `localhost.key`); dat wordt op deze
  computer al vertrouwd.

### CORS en Private Network Access (belangrijk)

Sta precies deze origins toe:

```
https://hellingsmark-blip.github.io     (definitieve add-in)
https://localhost:3000                  (ontwikkelversie)
```

- Beantwoord de preflight (`OPTIONS`) met `Access-Control-Allow-Origin: <origin>`,
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`
  en `Access-Control-Max-Age: 600`.
- **Lokaal ook:** `Access-Control-Allow-Private-Network: true` op de preflight. Zonder deze header kan
  Edge/WebView2 (waarin Word de add-in draait) een verzoek van `github.io` naar `localhost` blokkeren.
- Geen `*` als origin.

---

## `GET /health`

Snel antwoord (lokaal < 1 s). In de cloud mag dit de container wekken; de add-in toont dan
"Cloud-detector wordt opgestart…".

**Antwoord 200**

```json
{
  "status": "ok",
  "api_version": 1,
  "mode": "local",
  "warm": true,
  "models": [
    { "signal": "perplexity", "name": "gpt2", "version": "…" },
    { "signal": "classifier", "name": "deberta-v3-small-mabr", "version": "2026-12-01" }
  ],
  "signals": ["perplexity", "burstiness", "classifier", "stylometry"],
  "max_chars": 60000,
  "cost_usd_per_1000_words": null,
  "limit_remaining_usd": null
}
```

| Veld | Betekenis |
|---|---|
| `mode` | `"local"` of `"cloud"` |
| `warm` | cloud: `true` als de modellen al geladen zijn; lokaal altijd `true` |
| `models` | actieve modellen (getoond bij elk resultaat) |
| `signals` | welke signalen meedoen; mogelijke namen: `perplexity`, `burstiness`, `binoculars`, `fast_detectgpt`, `classifier`, `stylometry` |
| `max_chars` | maximale totale tekstlengte per `/analyze` |
| `cost_usd_per_1000_words` | cloud: geschatte kosten (voor de schatting vooraf); lokaal `null` |
| `limit_remaining_usd` | cloud: resterend tegoed binnen de eigen limiet; anders `null` |

---

## `POST /analyze`

**Verzoek**

```json
{
  "api_version": 1,
  "section": "Results",
  "paragraphs": [
    { "id": "p12", "text": "The MABR removed 85 % of the ammonium. This shows that …" },
    { "id": "p13", "text": "…" }
  ]
}
```

- `paragraphs`: alinea's in documentvolgorde; `id` is een vrije tekst die de add-in terugkrijgt.
- `section` (optioneel): sectienaam (`Abstract`, `Introduction`, `Methods`, `Results`, `Discussion`,
  `Conclusion`, of de tekst van het kopje). Mag de drempels of de interpretatie beïnvloeden.

**Antwoord 200**

```json
{
  "api_version": 1,
  "mode": "local",
  "models": [ { "signal": "classifier", "name": "deberta-v3-small-mabr", "version": "2026-12-01" } ],
  "overall": { "score": 0.18, "low": 0.08, "high": 0.31, "label": "human" },
  "signals_overall": {
    "perplexity": { "score": 0.22, "contribution": -0.41 },
    "classifier": { "score": 0.12, "contribution": -1.10 }
  },
  "paragraphs": [
    {
      "id": "p12",
      "score": 0.21, "low": 0.09, "high": 0.38, "label": "human",
      "sentences": [
        {
          "text": "The MABR removed 85 % of the ammonium.",
          "score": 0.10,
          "signals": {
            "perplexity": { "score": 0.15, "contribution": -0.6 },
            "stylometry": { "score": 0.30, "contribution": 0.1 }
          }
        }
      ]
    }
  ],
  "warnings": ["Korte tekst (< 150 woorden): lage betrouwbaarheid."],
  "elapsed_ms": 1840,
  "cost_usd": null
}
```

| Veld | Betekenis |
|---|---|
| `overall` | totaalscore met onzekerheidsmarge (`low`–`high`) en label |
| `signals_overall` / `signals` | per signaal: eigen score (0–1) en **bijdrage** aan de eindscore (positief = richting AI, negatief = richting mens; bv. bijdrage aan de logit van het ensemble) |
| `paragraphs[].id` | zelfde `id` als in het verzoek; ontbrekende alinea's mogen (bv. te kort), de add-in toont dan "niet beoordeeld" |
| `sentences[].text` | letterlijke tekst van de zin in de alinea |
| `warnings` | korte Nederlandse meldingen, worden letterlijk getoond |
| `cost_usd` | cloud: werkelijke kosten van deze analyse; lokaal `null` |

### Foutcodes

| Code | Wanneer | Wat de add-in doet |
|---|---|---|
| 400 | ongeldig verzoek | toont de `detail`-tekst |
| 401 | cloud: token ontbreekt of is fout | "Toegangstoken ongeldig — controleer Instellingen" |
| 402 | cloud: eigen limiet bereikt | toont de `detail`-tekst |
| 413 | tekst langer dan `max_chars` | vraagt een kleiner stuk te analyseren |
| 503 | cloud: koude start / modellen laden | toont "Cloud-detector wordt opgestart…" en probeert opnieuw na `Retry-After` seconden (max. ± 3 minuten) |

Foutantwoorden: `{ "detail": "Nederlandse uitleg" }`.

---

## Testen met curl

```bash
curl -k https://localhost:8765/health
curl -k -X POST https://localhost:8765/analyze -H "Content-Type: application/json" \
  -d '{"api_version":1,"paragraphs":[{"id":"p1","text":"Some text to analyse here."}]}'
# Preflight zoals de add-in hem stuurt:
curl -k -i -X OPTIONS https://localhost:8765/analyze -H "Origin: https://hellingsmark-blip.github.io" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Private-Network: true"
```
