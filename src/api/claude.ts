/**
 * Claude API-client voor gebruik rechtstreeks vanuit de add-in (browser).
 * - Gebruikt `fetch` naar https://api.anthropic.com/v1/messages met de header
 *   `anthropic-dangerous-direct-browser-access: true` (persoonlijke tool, eigen key).
 * - Controleert het budget vóór elke aanroep en boekt de kosten erna.
 * - 401/403 → duidelijke melding; 429/529/5xx → kort wachten en opnieuw proberen.
 * - Geen telemetrie en geen andere externe verbindingen.
 */
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from "../config";
import { canSpend, recordUsage, Usage } from "../budget";
import { getApiKey } from "../storage";
import { loadSettings } from "../settings";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ClaudeRequest {
  model: string;
  /** Systeemprompt + profiel + feitenblad. Het laatste blok met `cache: true` wordt gecachet. */
  system?: { text: string; cache?: boolean }[];
  /** Eenvoudig: één gebruikersbericht. */
  user: string;
  maxTokens?: number;
  effort?: Effort;
  /** Zet denken uit waar het model dat toestaat (Haiku 5.5 bij effort ≤ high). */
  thinkingOff?: boolean;
  /** JSON Schema voor gestructureerde output (output_config.format). */
  jsonSchema?: Record<string, unknown>;
}

export interface ClaudeResult {
  text: string;
  usage: Usage;
  stopReason: string;
  model: string;
}

export type ClaudeErrorKind = "no-key" | "auth" | "budget" | "rate" | "network" | "refusal" | "bad-request" | "server";

export class ClaudeError extends Error {
  constructor(public kind: ClaudeErrorKind, message: string, public status?: number) {
    super(message);
  }
}

/** Afhankelijkheden die tests kunnen vervangen (nep-fetch, geen echte wachttijd). */
export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  apiKey: () => string;
  usdToEur: () => number;
}

const defaultDeps: Deps = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  apiKey: getApiKey,
  usdToEur: () => loadSettings().usdToEur,
};

/** Wachttijden tussen pogingen bij 429/529/5xx. */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

export function buildBody(req: ClaudeRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    messages: [{ role: "user", content: req.user }],
  };
  if (req.system && req.system.length) {
    const blocks: SystemBlock[] = req.system.map((s) => ({ type: "text", text: s.text }));
    // Cache-breekpunt op het laatste blok dat gecachet mag worden (stabiele inhoud vooraan).
    let last = -1;
    req.system.forEach((s, i) => s.cache && (last = i));
    if (last >= 0) blocks[last].cache_control = { type: "ephemeral" };
    body.system = blocks;
  }
  const outputConfig: Record<string, unknown> = {};
  if (req.effort) outputConfig.effort = req.effort;
  if (req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (req.thinkingOff) body.thinking = { type: "disabled" };
  return body;
}

export async function callClaude(req: ClaudeRequest, deps: Deps = defaultDeps): Promise<ClaudeResult> {
  const key = deps.apiKey();
  if (!key) throw new ClaudeError("no-key", "Geen API key ingesteld — vul je key in bij Instellingen.");
  if (!canSpend()) {
    throw new ClaudeError("budget", "Maandbudget bereikt — API-functies staan uit. Verhoog de limiet onderin.");
  }

  const body = JSON.stringify(buildBody(req));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body,
      });
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        await deps.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new ClaudeError("network", "Geen verbinding met de Claude API. Controleer je internet.");
    }

    if (res.ok) {
      const data = await res.json();
      const usage: Usage = data.usage || {};
      recordUsage(req.model, usage, deps.usdToEur());
      if (data.stop_reason === "refusal") {
        throw new ClaudeError("refusal", "Claude weigerde dit verzoek te verwerken.");
      }
      const text = (data.content || [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("");
      return { text, usage, stopReason: data.stop_reason, model: data.model || req.model };
    }

    const status = res.status;
    if (status === 401 || status === 403) {
      throw new ClaudeError("auth", "API key ongeldig of verlopen — plak een nieuwe key in Instellingen.", status);
    }
    const retryable = status === 429 || status === 529 || status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = ra > 0 && ra <= 30 ? ra * 1000 : RETRY_DELAYS_MS[attempt];
      await deps.sleep(wait);
      continue;
    }
    let detail = "";
    try {
      detail = (await res.json())?.error?.message || "";
    } catch {
      /* geen JSON */
    }
    if (status === 429 || status === 529) {
      throw new ClaudeError("rate", "Claude is nu overbelast of je limiet is bereikt. Probeer het zo opnieuw.", status);
    }
    if (status >= 500) throw new ClaudeError("server", `Fout bij Claude (HTTP ${status}). Probeer het later opnieuw.`, status);
    throw new ClaudeError("bad-request", `Verzoek geweigerd (HTTP ${status}): ${detail}`, status);
  }
}

/** Goedkope verbindingstest met het live-model (Haiku): een paar tokens. */
export async function testConnection(model: string, deps: Deps = defaultDeps): Promise<string> {
  const r = await callClaude(
    { model, user: "Reply with the single word: OK", maxTokens: 16, effort: "low", thinkingOff: true },
    deps
  );
  return r.text.trim() || "(lege reactie)";
}
