import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HermesBridgeError,
  getHermesBridgeStatus,
  listHermesJobs,
  runHermesTurn,
} from "@/lib/hermes/client";

/**
 * Contract tests for the Hermes client. The behaviours pinned here are the ones
 * a person would notice if they regressed: an offline machine must read as
 * offline rather than as an error page, and an agent failure that Hermes
 * reports with HTTP 200 must never be rendered as if it were an answer.
 */

vi.mock("@/lib/hermes/local-identity", () => ({
  readHermesLocalIdentity: vi.fn(async () => ({
    deviceId: "tdv_test",
    environment: "uat",
    vaultLocked: false,
    unavailableReason: null,
  })),
}));

const ENV = {
  HERMES_LOCAL_BRIDGE_ENABLED: "true",
  HERMES_LOCAL_API_KEY: "test-key",
  HERMES_LOCAL_BASE_URL: "http://127.0.0.1:8642",
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("getHermesBridgeStatus", () => {
  it("reports disabled without calling the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const bridge = await getHermesBridgeStatus({} as NodeJS.ProcessEnv);

    expect(bridge.reachability).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports online and carries the device identity through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "ok", version: "0.20.0", platforms: {} }),
      ),
    );

    const bridge = await getHermesBridgeStatus(ENV);

    expect(bridge.reachability).toBe("online");
    expect(bridge.status?.version).toBe("0.20.0");
    expect(bridge.identity.deviceId).toBe("tdv_test");
  });

  it("treats an unreachable machine as offline, not as a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const bridge = await getHermesBridgeStatus(ENV);

    expect(bridge.reachability).toBe("offline");
    expect(bridge.status).toBeNull();
    // Identity still resolves: an asleep machine is still an enrolled machine.
    expect(bridge.identity.deviceId).toBe("tdv_test");
  });

  it("distinguishes a rejected credential from an absent machine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );

    const bridge = await getHermesBridgeStatus(ENV);

    expect(bridge.reachability).toBe("unauthorized");
  });

  it("sends the bearer credential to Hermes", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ status: "ok", platforms: {} }));
    vi.stubGlobal("fetch", fetchSpy);

    await getHermesBridgeStatus(ENV);

    const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
  });
});

describe("listHermesJobs", () => {
  it("returns the jobs array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ jobs: [{ id: "a", name: "nightly" }] })),
    );

    await expect(listHermesJobs(ENV)).resolves.toHaveLength(1);
  });

  it("tolerates a payload without a jobs array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));

    await expect(listHermesJobs(ENV)).resolves.toEqual([]);
  });

  it("refuses when the bridge is disabled", async () => {
    await expect(listHermesJobs({} as NodeJS.ProcessEnv)).rejects.toBeInstanceOf(
      HermesBridgeError,
    );
  });
});

describe("runHermesTurn", () => {
  it("returns the answer and the session id Hermes echoes back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            model: "hussh-one",
          },
          { headers: { "X-Hermes-Session-Id": "api-123" } },
        ),
      ),
    );

    const result = await runHermesTurn("do the thing", { env: ENV });

    expect(result.content).toBe("done");
    expect(result.session_id).toBe("api-123");
    expect(result.failed).toBe(false);
  });

  it("marks an in-band agent failure as failed instead of as an answer", async () => {
    // Hermes returns HTTP 200 with finish_reason "error" when the agent itself
    // failed; rendering that as a normal reply would show an error message in
    // the voice of the assistant.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [
            { message: { content: "provider exploded" }, finish_reason: "error" },
          ],
          hermes: { failed: true, error: "provider exploded" },
        }),
      ),
    );

    const result = await runHermesTurn("hi", { env: ENV });

    expect(result.failed).toBe(true);
    expect(result.error).toBe("provider exploded");
  });

  it("rejects an empty prompt and an over-long prompt", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(runHermesTurn("   ", { env: ENV })).rejects.toBeInstanceOf(
      HermesBridgeError,
    );
    await expect(
      runHermesTurn("x".repeat(4_001), { env: ENV }),
    ).rejects.toBeInstanceOf(HermesBridgeError);
  });

  it("threads a session id when one is supplied", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await runHermesTurn("hello", { sessionId: "api-9", env: ENV });

    const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Hermes-Session-Id")).toBe("api-9");
  });
});
