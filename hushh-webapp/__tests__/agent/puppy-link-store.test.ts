import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTrustedDevices: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    listTrustedDevices: mocks.listTrustedDevices,
  },
}));

import {
  PUPPY_LINK_POLL_MS,
  getPuppyLinkSnapshot,
  refreshPuppyLink,
  resetPuppyLinkStoreForTests,
  subscribePuppyLink,
} from "@/lib/services/puppy-one-service";

/**
 * One reader of the link for the whole page.
 *
 * The chat panel and the machine strip used to poll One on their own
 * cadences, and disagreed on screen for up to five minutes after a heartbeat.
 * These pin the two things that stop that: every subscriber shares one poll,
 * and a page with no Puppy surface costs One nothing.
 */

function devices(rows: unknown[]) {
  return { ok: true, json: async () => ({ devices: rows }) } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetPuppyLinkStoreForTests();
  mocks.listTrustedDevices.mockResolvedValue(devices([]));
});

afterEach(() => {
  resetPuppyLinkStoreForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the shared Puppy One link store", () => {
  it("reads once for any number of subscribers, and tells all of them", async () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribePuppyLink(first);
    subscribePuppyLink(second);

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toEqual(second.mock.calls[0][0]);
    expect(getPuppyLinkSnapshot()?.state).toBe("unlinked");
  });

  it("polls on one interval, not one per subscriber", async () => {
    subscribePuppyLink(() => {});
    subscribePuppyLink(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUPPY_LINK_POLL_MS);
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(PUPPY_LINK_POLL_MS);
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the last subscriber leaves", async () => {
    const stopFirst = subscribePuppyLink(() => {});
    const stopSecond = subscribePuppyLink(() => {});
    await vi.advanceTimersByTimeAsync(0);

    stopFirst();
    await vi.advanceTimersByTimeAsync(PUPPY_LINK_POLL_MS);
    // One subscriber is still listening, so the poll goes on.
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(2);

    stopSecond();
    await vi.advanceTimersByTimeAsync(PUPPY_LINK_POLL_MS * 3);
    // Nobody is listening: One is not asked again.
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight read rather than starting a second", async () => {
    let release: (value: Response) => void = () => {};
    mocks.listTrustedDevices.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const a = refreshPuppyLink();
    const b = refreshPuppyLink();
    expect(a).toBe(b);
    expect(mocks.listTrustedDevices).toHaveBeenCalledTimes(1);

    release(
      devices([
        {
          device_id: "dev-1",
          device_name: "Kushal's Mac",
          status: "active",
          created_at: Date.now(),
          last_heartbeat_at: Date.now(),
          heartbeat: { current_model: "gemma" },
        },
      ]),
    );
    const link = await a;
    expect(link.state).toBe("live");
    expect(getPuppyLinkSnapshot()).toBe(link);
  });

  it("turns a failed read into unavailable, never into install advice", async () => {
    mocks.listTrustedDevices.mockRejectedValueOnce(new Error("backend down"));
    const heard = vi.fn();
    subscribePuppyLink(heard);
    await vi.advanceTimersByTimeAsync(0);
    expect(heard.mock.calls[0][0].state).toBe("unavailable");
  });
});
