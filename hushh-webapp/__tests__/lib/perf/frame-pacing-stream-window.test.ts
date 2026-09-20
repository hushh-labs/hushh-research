// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { writeFile: async () => undefined },
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
}));

import { startFramePacingProbe } from "@/lib/perf/frame-pacing";

type Tick = (now: number) => void;

/**
 * A streaming reply produces no pointer or scroll input, so the probe keeps
 * a "stream" window open while the assistant bubble carries the streaming
 * marker; without it the whole stream lands in the idle bucket and the
 * chat lane measures nothing.
 */
describe("frame pacing probe stream window", () => {
  let queued: Tick | null = null;
  let now = 0;

  const frame = (ms = 16.7) => {
    now += ms;
    const cb = queued;
    queued = null;
    cb?.(now);
  };

  beforeEach(() => {
    now = 0;
    queued = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queued = cb as Tick;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("opens a stream window while the marker is present and closes it when it leaves", () => {
    const probe = startFramePacingProbe({ hud: false });
    // Boot: the probe samples the refresh rate for its first second.
    for (let i = 0; i < 70; i += 1) frame();
    expect(probe.export().windows).toHaveLength(0);

    const bubble = document.createElement("div");
    bubble.setAttribute("data-agent-streaming", "true");
    document.body.appendChild(bubble);
    for (let i = 0; i < 40; i += 1) frame();

    let windows = probe.export().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.kind).toBe("stream");
    expect(windows[0]?.frames).toBeGreaterThan(20);

    bubble.removeAttribute("data-agent-streaming");
    for (let i = 0; i < 20; i += 1) frame();
    const closedAt = probe.export().windows[0]?.duration_ms ?? 0;
    for (let i = 0; i < 20; i += 1) frame();

    windows = probe.export().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.duration_ms).toBe(closedAt);
    probe.stop();
  });

  it("does not open a stream window without the marker", () => {
    const probe = startFramePacingProbe({ hud: false });
    for (let i = 0; i < 120; i += 1) frame();
    expect(probe.export().windows).toHaveLength(0);
    probe.stop();
  });
});
