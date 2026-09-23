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
import { hasRenderCommitSink, reportRenderCommit } from "@/lib/perf/render-commit-sink";

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

  it("attributes React commits to the open window, the idle bucket, and the route enter", () => {
    expect(hasRenderCommitSink()).toBe(false);
    const probe = startFramePacingProbe({ hud: false });
    expect(hasRenderCommitSink()).toBe(true);
    for (let i = 0; i < 70; i += 1) frame();

    // Idle: a commit with no window open lands in the route's idle bucket.
    reportRenderCommit("update", 4, 6, now);
    let exported = probe.export();
    expect(exported.react_profiling).toBe(true);
    expect(exported.idle_by_route[0]?.commits.count).toBe(1);

    // A tap opens a window; commits inside it are counted, top 3 kept by size.
    // jsdom has no PointerEvent, so the probe listened for touchstart.
    document.dispatchEvent(new Event("touchstart", { bubbles: true }));
    frame();
    for (const ms of [3, 40, 12, 25]) reportRenderCommit("update", ms, ms * 2, now);
    exported = probe.export();
    const tapWindow = exported.windows[0];
    expect(tapWindow?.commits.count).toBe(4);
    expect(tapWindow?.commits.max_ms).toBe(40);
    expect(tapWindow?.commits.total_ms).toBe(80);
    expect(tapWindow?.commits.top.map((c) => c.actual_ms)).toEqual([40, 25, 12]);

    // The route changes: the last commit is the destination's first commit,
    // and two frames later the first-frame time is known.
    reportRenderCommit("update", 31, 60, now);
    probe.setRoute("/one/feed", "");
    frame();
    frame(20);
    exported = probe.export();
    expect(exported.windows[0]?.kind).toBe("tap→route");
    expect(exported.windows[0]?.route_enter).toEqual({
      route: "/one/feed",
      first_commit_ms: 31,
      first_frame_ms: expect.any(Number),
    });
    expect(exported.windows[0]?.route_enter?.first_frame_ms).toBeGreaterThan(0);

    probe.stop();
    expect(hasRenderCommitSink()).toBe(false);
  });

  it("keeps a type window open while keyboard input keeps coming", () => {
    const probe = startFramePacingProbe({ hud: false });
    for (let i = 0; i < 70; i += 1) frame();
    document.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) frame();
    document.dispatchEvent(new Event("keydown", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) frame();
    let windows = probe.export().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.kind).toBe("type");
    // 600 ms without input closes it.
    for (let i = 0; i < 45; i += 1) frame();
    const closed = probe.export().windows[0]?.duration_ms ?? 0;
    for (let i = 0; i < 10; i += 1) frame();
    windows = probe.export().windows;
    expect(windows[0]?.duration_ms).toBe(closed);
    expect(windows[0]?.frames).toBeGreaterThan(20);
    probe.stop();
  });

  it("places the worst frames inside the window and counts the document at close", () => {
    document.body.innerHTML = "<main><p>one</p><p>two</p></main>";
    const probe = startFramePacingProbe({ hud: false });
    for (let i = 0; i < 70; i += 1) frame();
    document.dispatchEvent(new Event("input", { bubbles: true }));
    frame();
    frame(90); // one stall, 106.7 ms after the window opened (16.7 + 90)
    for (let i = 0; i < 5; i += 1) frame();
    frame(40);
    for (let i = 0; i < 45; i += 1) frame();
    const [w] = probe.export().windows;
    expect(w?.over_50_count).toBe(1);
    expect(w?.worst_frames[0]).toEqual({ gap_ms: 90, at_ms: 106.7 });
    expect(w?.worst_frames[1]?.gap_ms).toBe(40);
    expect(w?.worst_frames.length).toBeLessThanOrEqual(3);
    expect(w?.dom_nodes).toBe(document.getElementsByTagName("*").length);
    probe.stop();
  });

  it("reads the bottom chrome divergence per scroll frame on the chat route", () => {
    document.body.innerHTML =
      '<div data-app-scroll-root="true"><div data-bottom-shell-motion-stack style="transform: translate3d(0px, 40px, 0px)"></div>' +
      '<form data-agent-chat-composer-form="root" style="transform: translate3d(0px, 10px, 0px)"></form></div>';
    const probe = startFramePacingProbe({ hud: false });
    for (let i = 0; i < 70; i += 1) frame();
    const root = document.querySelector('[data-app-scroll-root="true"]')!;
    root.dispatchEvent(new Event("touchstart", { bubbles: true }));
    for (let i = 0; i < 5; i += 1) frame();
    (document.querySelector("form") as HTMLElement).style.transform = "translate3d(0px, 40px, 0px)";
    for (let i = 0; i < 5; i += 1) frame();
    root.dispatchEvent(new Event("touchend", { bubbles: true }));
    for (let i = 0; i < 70; i += 1) frame();
    const [w] = probe.export().windows;
    expect(w?.kind).toBe("scroll");
    expect(w?.bottom_chrome_sync?.samples).toBeGreaterThan(5);
    expect(w?.bottom_chrome_sync?.max_divergence_px).toBe(30);
    probe.stop();
  });

  it("does not open a stream window without the marker", () => {
    const probe = startFramePacingProbe({ hud: false });
    for (let i = 0; i < 120; i += 1) frame();
    expect(probe.export().windows).toHaveLength(0);
    probe.stop();
  });
});
