import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/hermes/models/route";

/**
 * The Puppy One model route.
 *
 * The checks that matter are the ones that stop the picker from misreporting
 * the runtime: the loopback key must never leave the server, an unknown
 * reasoning effort must be refused rather than silently dropped, a model change
 * must be described as applying to the next session because that is what Hermes
 * actually does with it, and the list must describe models that exist.
 *
 * The gateway endpoint this reads is not live yet, so every GET here runs
 * against a mocked fetch shaped to the published contract.
 */

const ORIGINAL_ENV = { ...process.env };

function request(url: string, init?: RequestInit) {
  return new Request(url, init) as never;
}

/** The documented payload of GET /api/hussh-one/models. */
function gatewayPayload(overrides: Record<string, unknown> = {}) {
  return {
    current: { model: "google/gemma-4-26b-a4b-qat", provider: "lmstudio" },
    providers: [
      {
        id: "lmstudio",
        name: "LM Studio",
        onDevice: true,
        authenticated: true,
        isCurrent: true,
        models: [
          {
            id: "google/gemma-4-26b-a4b-qat",
            variant: "MLX",
            quantization: "4bit",
            state: "loaded",
            contextLength: 262144,
            supportsReasoning: true,
          },
          {
            id: "nvidia/nemotron-3-nano-omni",
            variant: "GGUF",
            quantization: "Q4_K_M",
            state: "not-loaded",
            contextLength: 262144,
            supportsReasoning: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function stubGateway(payload: unknown) {
  const sent = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json(payload),
  );
  vi.stubGlobal("fetch", sent);
  return sent;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/hermes/models", () => {
  it("reports not-configured as a calm state, not an error", async () => {
    delete process.env.HERMES_API_SERVER_KEY;
    const response = await GET(request("http://localhost/api/hermes/models"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(false);
    expect(body.providers).toEqual([]);
  });

  it("reads the filtered list, not the every-provider one", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = stubGateway(gatewayPayload());

    await GET(request("http://localhost/api/hermes/models"));

    // /api/model/options returned Nous Portal, Fireworks, OpenRouter, NovitaAI
    // and OpenAI with no credentials and no models. Five dead rows above the
    // models that exist is the bug; reading the endpoint that already excludes
    // them is the fix, and it is a fix only if this URL is the one called.
    const [url, init] = sent.mock.calls[0];
    expect(url).toContain("/api/hussh-one/models");
    expect(url).not.toContain("/api/model/options");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer k",
    );
  });

  it("carries the build details the picker shows beside each model", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(gatewayPayload());

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: "lmstudio",
      name: "LM Studio",
      onDevice: true,
      isCurrent: true,
    });
    expect(body.providers[0].models).toEqual([
      {
        id: "google/gemma-4-26b-a4b-qat",
        variant: "MLX",
        quantization: "4bit",
        state: "loaded",
        supportsReasoning: true,
      },
      {
        id: "nvidia/nemotron-3-nano-omni",
        variant: "GGUF",
        quantization: "Q4_K_M",
        state: "not-loaded",
        supportsReasoning: true,
      },
    ]);
    expect(body.current).toEqual({
      model: "google/gemma-4-26b-a4b-qat",
      provider: "lmstudio",
    });
  });

  it("treats an absent or unrecognised variant as unknown, never as a guess", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            models: [
              { id: "a" },
              { id: "b", variant: null },
              { id: "c", variant: "mlx" },
              { id: "d", variant: "safetensors" },
              { id: "e", variant: 7 },
            ],
          },
        ],
      }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    // A chip is a claim about how the model executes. Only the two builds the
    // contract defines get one; everything else renders nothing at all, so an
    // unreadable value can never reach the owner styled as a fact.
    expect(
      body.providers[0].models.map((m: { id: string; variant: string | null }) => [
        m.id,
        m.variant,
      ]),
    ).toEqual([
      ["a", null],
      ["b", null],
      ["c", "MLX"],
      ["d", null],
      ["e", null],
    ]);
  });

  it("keeps an absent field absent rather than defaulting it", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({
        providers: [
          { id: "lmstudio", name: "LM Studio", models: [{ id: "bare" }] },
        ],
      }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    // "unknown" and "none" are different facts about a model. Inventing a
    // quantization or a load state would print the wrong one.
    expect(body.providers[0].models[0]).toEqual({
      id: "bare",
      variant: null,
      quantization: null,
      state: null,
      supportsReasoning: false,
    });
  });

  it("takes the gateway's word on where a turn runs, and falls back only when it is silent", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({
        providers: [
          // Silent: read from the provider id.
          { id: "lmstudio", name: "LM Studio", models: [{ id: "a" }] },
          { id: "openai", name: "OpenAI", models: [{ id: "gpt-5" }] },
          // Stated: the gateway knows things the id does not encode.
          { id: "somelocal", name: "Some Local", onDevice: true, models: [{ id: "b" }] },
        ],
      }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    expect(
      Object.fromEntries(
        body.providers.map((p: { id: string; onDevice: boolean }) => [p.id, p.onDevice]),
      ),
    ).toEqual({ lmstudio: true, openai: false, somelocal: true });
  });

  it("does not re-filter or re-dedupe what the gateway sent", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            authenticated: true,
            models: [{ id: "a" }, { id: "a" }],
          },
        ],
      }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    // The gateway owns the authentication and dedupe rules; it is the only
    // place that knows which credentials are live. A second copy of that policy
    // here would be the copy that goes stale. The picker survives a repeat by
    // rendering it, which is covered in the picker's own tests.
    expect(body.providers[0].models.map((m: { id: string }) => m.id)).toEqual([
      "a",
      "a",
    ]);
  });

  it("still reads a bare-string model rather than rendering an empty row", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({
        providers: [
          { id: "lmstudio", name: "LM Studio", models: ["qwen/qwen3.8-27b", "", 4] },
        ],
      }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    // The older wire shape listed models as plain strings, and mapping it wrong
    // once made every row render as "". A model with no id cannot be pinned, so
    // it is dropped instead of offered.
    expect(body.providers[0].models.map((m: { id: string }) => m.id)).toEqual([
      "qwen/qwen3.8-27b",
    ]);
  });

  it("answers about this bridge, whatever the payload claims", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    stubGateway(
      gatewayPayload({ configured: false, reachable: false, providers: [] }),
    );

    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();

    // `configured` and `reachable` describe the bridge, not the gateway. The
    // flags are written after the payload so an echoed key cannot flip them.
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
  });

  it("passes a refresh through to the gateway", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = stubGateway(gatewayPayload());

    await GET(request("http://localhost/api/hermes/models?refresh=1"));
    expect(sent.mock.calls[0][0]).toContain("refresh=true");

    await GET(request("http://localhost/api/hermes/models"));
    expect(sent.mock.calls[1][0]).not.toContain("refresh");
  });

  it("never forwards the loopback key to the browser", async () => {
    process.env.HERMES_API_SERVER_KEY = "super-secret-host-rce-key";
    stubGateway(gatewayPayload());
    const response = await GET(request("http://localhost/api/hermes/models"));
    expect(JSON.stringify(await response.json())).not.toContain(
      "super-secret-host-rce-key",
    );
  });

  it("reports an unreachable Hermes without throwing", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();
    expect(body).toMatchObject({ configured: true, reachable: false });
  });

  it("reports a refusing Hermes as unreachable, not as an empty list", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const body = await (
      await GET(request("http://localhost/api/hermes/models"))
    ).json();
    // "No models are configured" and "the agent is not answering" are different
    // sentences, and the picker prints whichever this says.
    expect(body).toMatchObject({ configured: true, reachable: false });
  });
});

describe("POST /api/hermes/models", () => {
  function post(payload: Record<string, unknown>) {
    return POST(
      request("http://localhost/api/hermes/models", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("refuses an unknown reasoning effort instead of dropping it", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);

    const response = await post({
      provider: "lmstudio",
      model: "m",
      reasoningEffort: "ultra",
    });
    expect(response.status).toBe(400);
    // Forwarding it would leave the UI showing a setting that is not in force.
    expect(sent).not.toHaveBeenCalled();
  });

  it("accepts every effort LM Studio clamps to", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      const body = await (
        await post({ provider: "lmstudio", model: "m", reasoningEffort: effort })
      ).json();
      expect(body.ok).toBe(true);
    }
  });

  it("says the change lands on the next session, not this one", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const body = await (
      await post({ provider: "lmstudio", model: "google/gemma-4-e2b" })
    ).json();
    // Hermes writes config, which only new sessions read. Claiming it applied
    // now would leave the header naming a model that is not answering.
    expect(body.appliesTo).toBe("next-session");
    expect(body.onDevice).toBe(true);
  });

  it("passes an expensive-model warning through as a question", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: false,
          confirm_required: true,
          confirm_message: "gpt-5 bills per token.",
        }),
      ),
    );
    const body = await (await post({ provider: "openai", model: "gpt-5" })).json();
    expect(body.confirmRequired).toBe(true);
    expect(body.confirmMessage).toContain("bills per token");
  });

  it("requires both a provider and a model", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    expect((await post({ provider: "lmstudio" })).status).toBe(400);
    expect((await post({ model: "m" })).status).toBe(400);
  });
});
