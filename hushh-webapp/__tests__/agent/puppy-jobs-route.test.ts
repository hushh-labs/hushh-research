import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/hermes/jobs/route";

/**
 * The switch that turns Puppy One's scheduled work on and off.
 *
 * This route holds the loopback bearer key, which is host remote-code-execution,
 * and it changes what the owner's machine does while nobody is watching. Three
 * of these tests exist because the first version got them wrong, and one was
 * caught only by running the toggle against the real gateway.
 */

const ORIGINAL_ENV = { ...process.env };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

function post(body: unknown, headers: Record<string, string> = SAME_ORIGIN) {
  return POST(
    new Request("http://localhost/api/hermes/jobs", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    }) as never,
  );
}

function gatewayJob(over: Record<string, unknown> = {}) {
  return {
    id: "6238fa10fe8b",
    name: "WhatsApp Session Janitor (weekly)",
    state: "scheduled",
    schedule_display: "0 5 * * 0",
    next_run_at: "2026-09-06T05:00:00-07:00",
    last_status: "ok",
    failure_streak: 0,
    // Everything below must never reach the browser.
    prompt: "SECRET INSTRUCTIONS",
    api_key: "sk-secret",
    workdir: "/Users/owner/private",
    ...over,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/hermes/jobs", () => {
  it("asks for the disabled ones too, or a paused job could never be switched back on", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn(async () => Response.json({ jobs: [gatewayJob()] }));
    vi.stubGlobal("fetch", sent);

    await GET(new Request("http://localhost/api/hermes/jobs") as never);

    // Measured against the live gateway: without this the job VANISHED from the
    // list the moment it was paused, and its id had to be recovered from disk.
    expect(String(sent.mock.calls[0][0])).toContain("include_disabled=true");
  });

  it("never passes the gateway's row through", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [gatewayJob()] })));

    const body = await (await GET(new Request("http://localhost/api/hermes/jobs") as never)).json();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET INSTRUCTIONS");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("/Users/owner/private");
    expect(body.jobs[0]).toEqual({
      id: "6238fa10fe8b",
      name: "WhatsApp Session Janitor (weekly)",
      schedule: "0 5 * * 0",
      paused: false,
      nextRunAt: "2026-09-06T05:00:00-07:00",
      lastStatus: "ok",
      lastError: null,
      failureStreak: 0,
    });
  });

  it("reads paused from the scheduler's own word for it", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ jobs: [gatewayJob({ state: "paused" })] })),
    );

    const body = await (await GET(new Request("http://localhost/api/hermes/jobs") as never)).json();
    expect(body.jobs[0].paused).toBe(true);
  });

  it("treats not-configured and unreachable as calm states", async () => {
    delete process.env.HERMES_API_SERVER_KEY;
    const off = await (await GET(new Request("http://localhost/api/hermes/jobs") as never)).json();
    expect(off.configured).toBe(false);
    expect(off.jobs).toEqual([]);

    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const down = await (await GET(new Request("http://localhost/api/hermes/jobs") as never)).json();
    expect(down).toMatchObject({ configured: true, reachable: false, jobs: [] });
  });
});

describe("POST /api/hermes/jobs", () => {
  it("refuses a job id that is not a job id", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);

    // encodeURIComponent leaves "." alone, so ".." would still climb out of
    // /api/jobs/{id}/{action} and post to a different gateway endpoint.
    for (const id of ["..", "../../v1/runs", "a/b", ""]) {
      const response = await post({ id, action: "pause" });
      expect(response.status, id).toBe(400);
    }
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses an action outside pause and resume", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);

    for (const action of ["delete", "run", "../run", "pause/../run", ""]) {
      expect((await post({ id: "6238fa10fe8b", action })).status, action).toBe(400);
    }
    expect(sent).not.toHaveBeenCalled();
  });

  it("normalises case and whitespace rather than refusing them", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn(async () => Response.json({ job: gatewayJob({ state: "paused" }) }));
    vi.stubGlobal("fetch", sent);

    // Safe because the result is checked against a closed set before it is
    // used; the alternative is refusing a caller for their capitalisation.
    const body = await (await post({ id: "6238fa10fe8b", action: " PAUSE " })).json();

    expect(body.ok).toBe(true);
    expect(String(sent.mock.calls[0][0])).toContain("/pause");
  });

  it("refuses a cross-site request", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);

    const response = await post(
      { id: "6238fa10fe8b", action: "pause" },
      { "sec-fetch-site": "cross-site", "content-type": "application/json" },
    );

    // The route adds a host-RCE key server-side and runs on a port any page can
    // reach; a site the owner merely visits must not be able to stop their work.
    expect(response.status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
  });

  it("does not call a 2xx refusal a success", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: "Job is mid-run." })),
    );

    const body = await (await post({ id: "6238fa10fe8b", action: "pause" })).json();

    // A 2xx is the gateway answering, not agreeing. Reading the status alone
    // would render the switch as flipped when nothing changed.
    expect(body.ok).toBe(false);
    expect(body.error).toContain("mid-run");
  });

  it("passes a valid toggle through and reports the job back", async () => {
    process.env.HERMES_API_SERVER_KEY = "k";
    const sent = vi.fn(async () =>
      Response.json({ job: gatewayJob({ state: "paused" }) }),
    );
    vi.stubGlobal("fetch", sent);

    const body = await (await post({ id: "6238fa10fe8b", action: "pause" })).json();

    expect(String(sent.mock.calls[0][0])).toContain("/api/jobs/6238fa10fe8b/pause");
    expect(body).toMatchObject({ ok: true, action: "pause" });
    expect(body.job.paused).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET INSTRUCTIONS");
  });
});
