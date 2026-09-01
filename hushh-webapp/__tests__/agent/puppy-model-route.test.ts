import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/hermes/models/route";

/**
 * The Puppy One model route.
 *
 * The checks that matter are the ones that stop the picker from misreporting
 * the runtime: the loopback key must never leave the server, an unknown
 * reasoning effort must be refused rather than silently dropped, and a model
 * change must be described as applying to the next session, because that is
 * what Hermes actually does with it.
 */

const ORIGINAL_ENV = { ...process.env };

function request(url: string, init?: RequestInit) {
  return new Request(url, init) as never;
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

  it("marks providers by whether they leave the machine", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          provider: "lmstudio",
          model: "google/gemma-4-26b-a4b-qat",
          providers: [
            {
              id: "lmstudio",
              name: "LM Studio",
              models: [{ id: "google/gemma-4-26b-a4b-qat" }],
            },
            { id: "openai", name: "OpenAI", models: [{ id: "gpt-5" }] },
          ],
        }),
      ),
    );

    const response = await GET(request("http://localhost/api/hermes/models"));
    const body = await response.json();
    const byId = Object.fromEntries(
      body.providers.map((p: { id: string; onDevice: boolean }) => [p.id, p.onDevice]),
    );
    // Cloud providers are shown and labelled rather than hidden: the picker has
    // to be able to say what choosing one gives up.
    expect(byId).toEqual({ lmstudio: true, openai: false });
  });

  it("never forwards the loopback key to the browser", async () => {
    process.env.HERMES_API_SERVER_KEY = "super-secret-host-rce-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ providers: [] })),
    );
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
