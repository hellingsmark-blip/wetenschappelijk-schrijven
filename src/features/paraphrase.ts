/**
 * Parafraseren: aanroep naar Claude met cache per geselecteerde tekst + profiel.
 * Bevat geen Word-code, zodat het met een nep-API te testen is.
 */
import { callClaude, ClaudeRequest, ClaudeResult } from "../api/claude";
import type { Profile } from "../profiles";
import { profileContext } from "../prompts/profileContext";
import {
  PARAPHRASE_SCHEMA, PARAPHRASE_SYSTEM, ParaphraseVariant, paraphraseUserMessage, parseParaphrase,
} from "../prompts/paraphrase";

export const MIN_WORDS = 5;
export const MAX_WORDS = 400;

type Caller = (req: ClaudeRequest) => Promise<ClaudeResult>;

export class ParaphraseService {
  private cache = new Map<string, ParaphraseVariant[]>();

  constructor(private call: Caller = (r) => callClaude(r)) {}

  private key(text: string, profile: Profile): string {
    return profileContext(profile) + "\u0000" + text;
  }

  cached(text: string, profile: Profile): ParaphraseVariant[] | undefined {
    return this.cache.get(this.key(text, profile));
  }

  /**
   * Haalt vier varianten op. Met `again = true` wordt de cache genegeerd en vragen we
   * om andere formuleringen dan de vorige.
   */
  async variants(text: string, profile: Profile, model: string, section: string | null, again = false): Promise<ParaphraseVariant[]> {
    const k = this.key(text, profile);
    const prev = this.cache.get(k);
    if (prev && !again) return prev;

    const res = await this.call({
      model,
      system: [
        { text: PARAPHRASE_SYSTEM, cache: true },
        { text: profileContext(profile), cache: true },
      ],
      user: paraphraseUserMessage(text, section, again && prev ? prev.map((v) => v.text) : []),
      maxTokens: 6000,
      effort: "low",
      jsonSchema: PARAPHRASE_SCHEMA as unknown as Record<string, unknown>,
    });
    if (res.stopReason === "max_tokens") throw new Error("Antwoord afgekapt — selecteer een kortere passage.");
    const out = parseParaphrase(res.text);
    this.cache.set(k, out);
    return out;
  }
}
