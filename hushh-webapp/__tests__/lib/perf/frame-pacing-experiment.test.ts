// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFramePacingProbe } from "@/lib/perf/frame-pacing";
type Tick = (now: number) => void;
describe("frame pacing probe attribution experiments", () => {
  let queued: Tick | null = null; let now = 0;
  const frame = (ms = 16.7) => { now += ms; const cb = queued; queued = null; cb?.(now); };
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { queued = cb as Tick; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  it("applies autocorrect-off to the composer once it exists, names it in the export, and keeps ticking", () => {
    const probe = startFramePacingProbe({ hud: false, experiments: ["autocorrect-off"] });
    for (let i = 0; i < 30; i += 1) frame();
    document.body.innerHTML = '<textarea data-testid="agent-chat-composer-textarea"></textarea>';
    for (let i = 0; i < 30; i += 1) frame();
    const ta = document.querySelector("textarea")!;
    expect(ta.getAttribute("autocorrect")).toBe("off");
    expect(ta.getAttribute("spellcheck")).toBe("false");
    expect(queued).not.toBeNull();
    document.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 60; i += 1) frame();
    expect(probe.export().windows.length).toBe(1);
    expect(probe.export().experiments).toEqual(["autocorrect-off"]);
    probe.stop();
  });
});
