import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/hermes/resources/route";

/**
 * The Puppy One machine-resources route.
 *
 * The checks that matter are the ones that stop this surface from lying about
 * the owner's machine: the loopback key (host remote-code-execution) must never
 * leave the server, a machine with no agent running must read as an ordinary
 * state rather than an error, and a partial payload must arrive partial. The
 * gateway OMITS a section whose probe could not answer, and filling one in here
 * would invent a reading nobody took -- a desktop's absent battery rendered as
 * 0%, or a machine with no job data reported as having run nothing.
 */

const ORIGINAL_ENV = { ...process.env };

function request(url = "http://localhost/api/hermes/resources") {
  return new Request(url) as never;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/hermes/resources", () => {
  it("reports not-configured as a calm 200 state, not an error", async () => {
    delete process.env.HERMES_API_SERVER_KEY;
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(false);
    expect(body.reason).toBe("not_configured");
    expect(typeof body.message).toBe("string");
    // Nothing to call: a machine without the bridge configured is the normal
    // case, and probing loopback anyway would be noise.
    expect(sent).not.toHaveBeenCalled();
  });

  it("never forwards the loopback key to the browser", async () => {
    process.env.HERMES_API_SERVER_KEY = "super-secret-host-rce-key";
    const fetchMock = vi.fn(async () =>
      Response.json({ agent: { model: "google/gemma-4-26b-a4b-qat" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain("super-secret-host-rce-key");
    // It goes exactly one place: the Authorization header of the loopback call.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer super-secret-host-rce-key");
  });

  it("reports an unreachable gateway as reachable:false without throwing", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      reachable: false,
    });
  });

  it("treats a non-ok gateway response as unreachable, not as data", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ configured: true, reachable: false });
    expect(body.machine).toBeUndefined();
  });

  it("passes a full reading through section by section", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          generated_at: 1788383733396,
          agent: {
            model: "google/gemma-4-26b-a4b-qat",
            provider: "lmstudio",
            on_device: true,
            on_device_gate: true,
          },
          machine: {
            ram_used_pct: 50.6,
            disk_free_gb: 54.7,
            disk_used_pct: 94.1,
            battery: { present: true, percent: 100, on_ac: true },
          },
          models: { resident_gb: 15.6, available_gb: 67.9, resident: [] },
          jobs: { enabled: 11, disabled: 2 },
        }),
      ),
    );

    const body = await (await GET(request())).json();
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.agent.on_device_gate).toBe(true);
    expect(body.machine.disk_used_pct).toBe(94.1);
    expect(body.models.available_gb).toBe(67.9);
    expect(body.jobs.enabled).toBe(11);
    expect(body.generated_at).toBe(1788383733396);
  });

  it("passes the Hussh One link section through untouched", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          link: {
            connected: true,
            account_email: "owner@example.com",
            environment: "uat",
            session: "expired",
            heartbeat_live: true,
            remedy: "/hussh-one reconnect",
          },
        }),
      ),
    );

    const body = await (await GET(request())).json();
    // The remedy is the device's to word. Rewriting or defaulting it here
    // would hand the owner a command that may not exist on their machine.
    expect(body.link).toEqual({
      connected: true,
      account_email: "owner@example.com",
      environment: "uat",
      session: "expired",
      heartbeat_live: true,
      remedy: "/hussh-one reconnect",
    });
  });

  it("passes a partial payload through without inventing the missing parts", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          agent: { model: "m", on_device: true },
          // A desktop: no battery at all, and the probe says so rather than
          // reporting a percent.
          machine: { ram_used_pct: 41.2, battery: { present: false } },
          // Jobs could not be read on this machine. Absent, not zero.
        }),
      ),
    );

    const body = await (await GET(request())).json();
    expect(body.jobs).toBeUndefined();
    expect(body.models).toBeUndefined();
    expect(body.link).toBeUndefined();
    expect(body.machine.battery).toEqual({ present: false });
    expect(body.machine.battery.percent).toBeUndefined();
    // Absent readings must not acquire a default on the way through: a 0 here
    // would render as a machine with no disk left and no work scheduled.
    expect(body.machine.disk_free_gb).toBeUndefined();
    expect(body.agent.on_device_gate).toBeUndefined();
  });

  it("does not let the payload overwrite what this bridge reports about itself", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ configured: false, reachable: false, agent: {} }),
      ),
    );

    // `configured` and `reachable` describe the bridge, not the gateway. A
    // payload carrying those keys must not be able to answer for us.
    const body = await (await GET(request())).json();
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
  });

  it("survives a gateway that answers 200 with something that is not an object", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const body = await (await GET(request())).json();
    expect(body).toEqual({ configured: true, reachable: true });
  });

  it("bounds the loopback call so a wedged probe cannot hold the handler open", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await GET(request());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
