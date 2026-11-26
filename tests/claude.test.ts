/** Tests van de API-client met een nep-fetch: er gaat nooit iets naar het echte internet. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, useStore } from "../src/storage";
import { buildBody, callClaude, ClaudeError, Deps, testConnection } from "../src/api/claude";
import { loadBudget, setMonthLimit } from "../src/budget";

const FAKE_KEY = "sk-ant-test-nep";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const okBody = {
  model: "claude-haiku-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 20, output_tokens: 2 },
};

function deps(fetchImpl: (...a: unknown[]) => Promise<Response>, key = FAKE_KEY): Deps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    fetch: fetchImpl as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    apiKey: () => key,
    usdToEur: () => 1,
    sleeps,
  };
}

beforeEach(() => useStore(createMemoryStore()));

describe("verzoek opbouwen", () => {
  it("stuurt de juiste headers en zet cache op het laatste cachebare systeemblok", async () => {
    const f = vi.fn(async () => jsonResponse(200, okBody));
    await callClaude(
      {
        model: "claude-haiku-5-5",
        system: [{ text: "regels", cache: true }, { text: "profiel", cache: true }, { text: "variabel" }],
        user: "tekst",
      },
      deps(f)
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const h = init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(FAKE_KEY);
    expect(h["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init.body as string);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[2].cache_control).toBeUndefined();
  });

  it("zet effort en JSON-schema in output_config", () => {
    const b = buildBody({ model: "m", user: "u", effort: "low", jsonSchema: { type: "object" } });
    expect(b.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
  });
});

describe("foutafhandeling", () => {
  it("zonder key: duidelijke melding, geen netwerkverzoek", async () => {
    const f = vi.fn();
    await expect(callClaude({ model: "claude-haiku-5-5", user: "x" }, deps(f as never, ""))).rejects.toMatchObject({ kind: "no-key" });
    expect(f).not.toHaveBeenCalled();
  });

  it("401 → melding over ongeldige/verlopen key", async () => {
    const f = vi.fn(async () => jsonResponse(401, { error: { message: "invalid x-api-key" } }));
    const err = await callClaude({ model: "claude-haiku-5-5", user: "x" }, deps(f)).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.message).toBe("API key ongeldig of verlopen — plak een nieuwe key in Instellingen.");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("429 → wacht en probeert opnieuw, daarna succes", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 3 ? jsonResponse(429, {}, { "retry-after": "2" }) : jsonResponse(200, okBody)));
    const d = deps(f);
    const r = await callClaude({ model: "claude-haiku-5-5", user: "x" }, d);
    expect(r.text).toBe("OK");
    expect(f).toHaveBeenCalledTimes(3);
    expect(d.sleeps).toEqual([2000, 2000]);
  });

  it("529 blijft → na 3 nieuwe pogingen een melding", async () => {
    const f = vi.fn(async () => jsonResponse(529, {}));
    const d = deps(f);
    await expect(callClaude({ model: "claude-haiku-5-5", user: "x" }, d)).rejects.toMatchObject({ kind: "rate" });
    expect(f).toHaveBeenCalledTimes(4);
    expect(d.sleeps).toEqual([1000, 3000, 8000]);
  });

  it("budget op → geen verzoek", async () => {
    setMonthLimit(0);
    const f = vi.fn();
    await expect(callClaude({ model: "claude-haiku-5-5", user: "x" }, deps(f as never))).rejects.toMatchObject({ kind: "budget" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("kosten boeken", () => {
  it("boekt de usage van een geslaagde respons", async () => {
    const f = vi.fn(async () =>
      jsonResponse(200, { ...okBody, usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 } })
    );
    await callClaude({ model: "claude-haiku-5-5", user: "x" }, deps(f));
    // $0,10 + $0,01 bij koers 1
    expect(loadBudget().spentEur).toBeCloseTo(0.11, 6);
  });

  it("Test verbinding geeft het antwoord terug", async () => {
    const f = vi.fn(async () => jsonResponse(200, okBody));
    expect(await testConnection("claude-haiku-5-5", deps(f))).toBe("OK");
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(16);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
