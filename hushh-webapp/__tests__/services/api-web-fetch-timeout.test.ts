/**
 * Ceiling for the browser `fetch` path in `apiFetch`.
 *
 * The native branch bounds itself explicitly; the web branch relied on the Next
 * proxy, which bounds only ITS upstream call. When the proxy is the slow hop —
 * or the route is not proxied at all — a request that never receives a response
 * left the promise pending for the life of the tab, and every screen awaiting
 * it spun with no error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithWebTimeout } from "@/lib/services/api-service";

describe("fetchWithWebTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a request that never responds", async () => {
    // The core guarantee: a silent server cannot hang the caller forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject((init.signal as AbortSignal).reason),
            );
          }),
      ),
    );

    const promise = fetchWithWebTimeout("https://example.test/x", {});
    const captured = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(61_000);

    const error = (await captured) as DOMException;
    expect(error.name).toBe("TimeoutError");
  });

  it("stays above the proxy's own ceiling so its 504 wins", async () => {
    // The Next proxy times its upstream call out at 45s and returns a real 504,
    // which the retry logic understands. Aborting earlier would replace a
    // retryable status with a client-side abort and break that recovery.
    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        seenSignal = init.signal as AbortSignal;
        return new Promise(() => undefined);
      }),
    );

    void fetchWithWebTimeout("https://example.test/x", {}).catch(
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(45_000);
    expect(seenSignal?.aborted).toBe(false);
  });

  it("returns a normal response untouched", async () => {
    const body = new Response("ok", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body));

    await expect(
      fetchWithWebTimeout("https://example.test/x", {}),
    ).resolves.toBe(body);
  });

  it("clears its timer once the response lands", async () => {
    // A leaked timer would abort a signal nobody is listening to and, in a long
    // session, accumulate one per request.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await fetchWithWebTimeout("https://example.test/x", {});

    expect(clearSpy).toHaveBeenCalled();
  });

  it("still honours a caller's own abort signal", async () => {
    // Callers that cancel their own work (a superseded request, an unmounted
    // screen) must keep working — the ceiling is additional, not a replacement.
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );

    const promise = fetchWithWebTimeout("https://example.test/x", {
      signal: caller.signal,
    });
    const captured = promise.catch((error: unknown) => error);

    caller.abort(new Error("caller cancelled"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(captured).resolves.toBeInstanceOf(Error);
  });

  it("aborts immediately when the caller's signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort(new Error("already gone"));

    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        seenSignal = init.signal as AbortSignal;
        return Promise.reject(new Error("aborted"));
      }),
    );

    await fetchWithWebTimeout("https://example.test/x", {
      signal: caller.signal,
    }).catch(() => undefined);

    expect(seenSignal?.aborted).toBe(true);
  });

  it("passes the caller's method and headers through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithWebTimeout("https://example.test/x", {
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/x",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Test": "1" },
        body: "payload",
      }),
    );
  });
});
