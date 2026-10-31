import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchPuppyJobs,
  setPuppyJobPaused,
} from "@/lib/services/puppy-one-service";

/**
 * The jobs half of the Puppy One service.
 *
 * Both calls have the same duty as the readings: never throw. A machine with
 * no agent answering is the ordinary case on this route, not an exception,
 * and a surface that has to catch would grow its own flavour of "broken" for
 * a state that is not broken at all.
 *
 * The second duty is narrower and easier to lose: `jobs` is ALWAYS an array.
 * A caller rendering a list must never have to decide what a missing array
 * means, and "no jobs" must stay distinguishable from "could not ask".
 */

const fetchMock = vi.fn();

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe("fetchPuppyJobs", () => {
  it("passes the gateway's list through", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        configured: true,
        reachable: true,
        jobs: [
          {
            id: "auto-dream",
            name: "Auto-Dream",
            schedule: "10 3 * * *",
            paused: false,
            nextRunAt: "2026-09-03T03:10:00-07:00",
            lastStatus: "ok",
            lastError: null,
            failureStreak: 0,
          },
        ],
      }),
    );

    const result = await fetchPuppyJobs();
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.name).toBe("Auto-Dream");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hermes/jobs",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps not-configured intact, with an array to render", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        configured: false,
        reason: "not_configured",
        message: "Set HERMES_API_SERVER_KEY to see Puppy One's scheduled work.",
      }),
    );

    const result = await fetchPuppyJobs();
    expect(result.configured).toBe(false);
    expect(result.reason).toBe("not_configured");
    // Absent upstream, still an array here: "no jobs" is the caller's
    // simplest case and it should not have to guard for undefined.
    expect(result.jobs).toEqual([]);
  });

  it("reads a refused or unreachable route as unreachable, never as zero jobs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    expect(await fetchPuppyJobs()).toEqual({
      configured: true,
      reachable: false,
      jobs: [],
    });

    fetchMock.mockRejectedValue(new Error("connection refused"));
    expect(await fetchPuppyJobs()).toEqual({
      configured: true,
      reachable: false,
      jobs: [],
    });
  });
});

describe("setPuppyJobPaused", () => {
  it("asks for the action the caller's boolean means", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, id: "x", action: "pause" }));

    const result = await setPuppyJobPaused({ id: "x", paused: true });
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "x",
      action: "pause",
    });

    await setPuppyJobPaused({ id: "x", paused: false });
    const [, resumeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(resumeInit.body))).toEqual({
      id: "x",
      action: "resume",
    });
  });

  it("carries the route's own refusal through", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, error: "Pass a job id and either pause or resume." },
        false,
      ),
    );
    expect(await setPuppyJobPaused({ id: "", paused: true })).toEqual({
      ok: false,
      error: "Pass a job id and either pause or resume.",
    });
  });

  it("never throws at an unreachable machine, and never claims success", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    expect(await setPuppyJobPaused({ id: "x", paused: true })).toEqual({
      ok: false,
      error: "Puppy One is not answering on this machine.",
    });

    // A 200 with no `ok` is not an agreement. Anything short of an explicit
    // yes leaves the caller free to keep showing the job's real state.
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(await setPuppyJobPaused({ id: "x", paused: false })).toEqual({
      ok: false,
      error: "Puppy One could not change that job.",
    });
  });
});
