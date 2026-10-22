import { describe, expect, it, vi } from "vitest";
import { attachWebPersonAvatarHosts, webPersonMarkerPlaceholder } from "@/lib/one-location/web-person-avatar-markers";

describe("local person marker content", () => {
  it("keeps two colocated identities separate and preserves SDK elements and listeners", async () => {
    const map = document.createElement("div");
    const first = document.createElement("gmp-advanced-marker");
    const second = document.createElement("gmp-advanced-marker");
    first.title = "opaque-first";
    second.title = "opaque-second";
    const fallback = document.createElement("img");
    first.appendChild(fallback);
    map.append(second, first);
    let clicks = 0;
    first.addEventListener("click", () => { clicks += 1; });
    const batch = await attachWebPersonAvatarHosts(map, new Map([
      ["first-grant", "opaque-first"], ["second-grant", "opaque-second"],
    ]));
    const host = batch.hosts.get("first-grant")!;
    expect(host.parentElement).toBe(first);
    expect(batch.hosts.get("second-grant")!.parentElement).toBe(second);
    expect(first.title).toBe("Private location");
    expect(host.style.width).toBe("44px");
    host.click();
    expect(clicks).toBe(1);
    // Clustering detaches the original marker; its local content follows it.
    first.remove();
    expect(host.parentElement).toBe(first);
    map.appendChild(first);
    expect(first.firstChild).toBe(host);
    batch.destroy();
    expect(first.firstChild).toBe(fallback);
    expect(host.parentElement).toBeNull();
    expect(batch.hosts.size).toBe(0);
    batch.destroy();
  });

  it("leaves compatibility adapters alone when no public marker element exists", async () => {
    const map = document.createElement("div");
    const unrelated = document.createElement("gmp-advanced-marker");
    unrelated.title = "place";
    map.appendChild(unrelated);
    vi.useFakeTimers();
    const pending = attachWebPersonAvatarHosts(map, new Map([["grant", "missing"]]));
    await vi.advanceTimersByTimeAsync(1500);
    const batch = await pending;
    vi.useRealTimers();
    expect(batch.hosts.size).toBe(0);
    expect(unrelated.title).toBe("place");
    batch.destroy();
    expect(map.firstChild).toBe(unrelated);
  });
  it("waits for the SDK draw and cancels obsolete marker installation", async () => {
    const map = document.createElement("div");
    const pending = attachWebPersonAvatarHosts(map, new Map([["grant", "opaque"]]));
    const marker = document.createElement("gmp-advanced-marker");
    marker.title = "opaque";
    map.appendChild(marker);
    const batch = await pending;
    expect(batch.hosts.get("grant")!.parentElement).toBe(marker);
    batch.destroy();
    const controller = new AbortController();
    const cancelled = attachWebPersonAvatarHosts(map, new Map([["next", "later"]]), controller.signal);
    controller.abort();
    expect((await cancelled).hosts.size).toBe(0);
  });

  it("preserves fresh versus stale styling in its neutral fallback", () => {
    expect(webPersonMarkerPlaceholder(false)).toContain("dodgerblue");
    expect(webPersonMarkerPlaceholder(true)).toContain("gray");
  });

});
