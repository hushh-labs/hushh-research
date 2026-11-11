import { describe, expect, it, vi } from "vitest";
import { coalescedInsightsRead } from "@/lib/calendar/calendar-insights-resource";

describe("Calendar Insights in-flight reads", () => {
  it("shares one same-context read while letting one consumer leave safely", async () => {
    let finish!: (value: string) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve; }));
    const first = new AbortController();
    const second = new AbortController();
    const abandoned = coalescedInsightsRead("owner:account:day", first.signal, load);
    const retained = coalescedInsightsRead("owner:account:day", second.signal, load);
    expect(load).toHaveBeenCalledTimes(1);
    first.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(load.mock.calls[0]?.[0].aborted).toBe(false);
    finish("five meetings");
    await expect(retained).resolves.toBe("five meetings");
  });
});
