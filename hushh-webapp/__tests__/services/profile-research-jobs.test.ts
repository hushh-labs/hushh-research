import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));
vi.mock("@/lib/vault/one-chat-key", () => ({
  oneChatKeyHeaders: async () => ({ "X-Hussh-Chat-Key": "fixture" }),
}));
import { ProfileResearchService } from "@/lib/services/profile-research-service";

const pending = {
  status: "pending",
  pkm_written: false,
  restart_required: false,
};
const offered = {
  status: "offered",
  pkm_written: false,
  search_suggestions: [],
  report: {
    match_status: "no_match",
    name: "Example Person",
    summary: "No reliable public match.",
    sections: [],
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function run(controller = new AbortController(), isCurrent?: () => boolean) {
  return ProfileResearchService.research({
    vaultKey: "fixture",
    vaultOwnerToken: "fixture-token",
    signal: controller.signal,
    isCurrent,
  });
}
describe("background profile discovery", () => {
  it("exhausted Search attempts are terminal across resume events", async () => {
    const exhausted = {
      status: "unavailable",
      pkm_written: false,
      retry_exhausted: true,
      attempts: 7,
    };
    mocks.apiFetch
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValue(json(exhausted));
    const result = run();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toEqual(exhausted);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
  });
  it.each([
    { retry_exhausted: true },
    { attempts: 7 },
    { retry_exhausted: true, attempts: 8 },
  ])("rejects malformed terminal attempt metadata %j", async (invalid) => {
    mocks.apiFetch.mockResolvedValue(
      json({ status: "unavailable", pkm_written: false, ...invalid }),
    );
    await expect(run()).rejects.toBeDefined();
  });
  it("a low-confidence result is terminal and cannot schedule new discovery", async () => {
    const low = {
      status: "low_confidence",
      pkm_written: false,
      verification: {
        method: "model_assessment",
        identity_score: 80,
        facts: [],
        attempts: 7,
      },
    };
    mocks.apiFetch
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValue(json(low));
    const result = run();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toEqual(low);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
  });
  it.each([
    { identity_score: 101 },
    { identity_score: -1 },
    { attempts: 8 },
    { attempts: 0 },
    { facts: [{ ref: "c8:0:0", score: 90 }] },
    { surprise: true },
  ])("rejects malformed verification metadata %j", async (invalid) => {
    mocks.apiFetch.mockResolvedValue(
      json({
        status: "low_confidence",
        pkm_written: false,
        verification: {
          method: "model_assessment",
          identity_score: 80,
          facts: [],
          attempts: 7,
          ...invalid,
        },
      }),
    );
    await expect(run()).rejects.toBeDefined();
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
  });
  it("starts once and polls beyond the old request deadline with fresh owner headers", async () => {
    let reads = 0;
    mocks.apiFetch.mockImplementation((_path, init) =>
      Promise.resolve(
        json(init.method === "POST" || ++reads < 25 ? pending : offered),
      ),
    );
    const result = run();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await result).toEqual(offered);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      ...Array(25).fill("GET"),
    ]);
    for (const [path, init] of mocks.apiFetch.mock.calls) {
      expect(path).toBe("/api/one/profile-research/jobs");
      expect(init.cache).toBe("no-store");
      expect(init.headers).toEqual({
        Authorization: "Bearer fixture-token",
        "X-Hussh-Chat-Key": "fixture",
      });
      expect(init.body).toBeUndefined();
    }
  });
  it("a lost start response reads status instead of dispatching another model run", async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValue(json(offered));
    const result = run();
    await vi.advanceTimersByTimeAsync(7000);
    expect(await result).toEqual(offered);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
  });
  it("a failed poll backs off and never replays start", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValue(json(offered));
    const result = run();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual(offered);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
  });
  it("an expired checkpoint stops without dispatching a second start", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(json({ ...pending, restart_required: true }))
      .mockResolvedValueOnce(json(pending))
      .mockResolvedValue(json(offered));
    const result = run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ status: "unavailable", pkm_written: false });
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
    ]);
  });
  it("stops on recovery-required status and leaves no resume listener or timer", async () => {
    mocks.apiFetch.mockImplementation((_path, init) =>
      Promise.resolve(
        json(
          init.method === "POST"
            ? pending
            : { ...pending, restart_required: true },
        ),
      ),
    );
    const result = run();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual({ status: "unavailable", pkm_written: false });
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });
  it("owner change stops the scheduled poll", async () => {
    let current = true;
    mocks.apiFetch.mockResolvedValue(json(pending));
    const result = run(new AbortController(), () => current);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    current = false;
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
  });
  it("unmount abort removes timers and stops polling without canceling server work", async () => {
    mocks.apiFetch.mockResolvedValue(json(pending));
    const controller = new AbortController();
    const result = run(controller);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
  });
  it("foreground and online resume wake one poll without a stale timer or duplicate GET", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    let finishRead!: (value: Response) => void;
    mocks.apiFetch.mockResolvedValueOnce(json(pending)).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRead = resolve;
        }),
    );
    const result = run();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    finishRead(json(offered));
    expect(await result).toEqual(offered);
    expect(mocks.apiFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
    ]);
  });
  it.each([401, 403, 400])(
    "authority/contract refusal %s is terminal, not a retry",
    async (status) => {
      mocks.apiFetch.mockResolvedValue(json({}, status));
      await expect(run()).rejects.toMatchObject({ status });
      expect(mocks.apiFetch).toHaveBeenCalledOnce();
    },
  );
  it("malformed responses cannot become a draft or an infinite retry", async () => {
    mocks.apiFetch.mockResolvedValue(
      json({ ...pending, report: offered.report }),
    );
    await expect(run()).rejects.toBeDefined();
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
  });
});
