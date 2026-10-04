import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BootRouteCommitted, BootSurface } from "@/components/app-ui/boot-surface";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import {
  activeBootStage,
  BOOT_STAGE_LINES,
  BOOT_STAGES,
  BOOT_TIMING,
  bootLineFor,
  IDLE_BOOT_STATE,
  isBootSurfaceShown,
  launchBootState,
  nextBootDeadline,
  reduceBoot,
  type BootStage,
  type BootState,
} from "@/lib/boot/boot-sequence";
import {
  getBootSurfaceState,
  resetBootSurfaceForTests,
  startBootSurface,
  subscribeBootSurface,
} from "@/lib/boot/boot-surface-store";

/**
 * The boot surface's contract: one surface for the whole cold-start chain,
 * a line per REAL stage, nothing painted on a fast path, no flash once shown,
 * a clean hand-off to interactive screens, and a way out of a hang.
 */

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const { showAfterMs, minVisibleMs, exitMs, stuckAfterMs } = BOOT_TIMING;

function run(initial: BootState, events: Array<[BootStage | null | "tick", number]>): BootState {
  return events.reduce<BootState>(
    (state, [event, at]) =>
      event === "tick"
        ? reduceBoot(state, { type: "tick", at })
        : reduceBoot(state, { type: "stage", stage: event, at }),
    initial,
  );
}

describe("boot stage machine", () => {
  it("maps every stage to its own emoji line", () => {
    const texts = new Set<string>();
    for (const stage of BOOT_STAGES) {
      const line = BOOT_STAGE_LINES[stage];
      expect(line.emoji.length, stage).toBeGreaterThan(0);
      expect(line.text, stage).not.toMatch(/[\u2013\u2014]/); // no en or em dashes in copy
      texts.add(line.text);
    }
    expect(texts.size).toBe(BOOT_STAGES.length);
    // U+2728 is the glyph the founder rule bans everywhere.
    expect(JSON.stringify(BOOT_STAGE_LINES)).not.toContain("✨");
    expect(bootLineFor("vault", false)).toEqual({ emoji: "🔐", text: "Opening your vault" });
    expect(bootLineFor("phone", false)).toEqual({ emoji: "📱", text: "Checking your number" });
    expect(bootLineFor("workspace", false)).toEqual({ emoji: "🤝", text: "Getting One ready" });
    // Offline is what is actually blocking, so it outranks the stage.
    expect(bootLineFor("vault", true)?.emoji).toBe("📡");
  });

  it("shows the earliest stage when guards overlap", () => {
    expect(activeBootStage(["workspace", "vault", "phone"])).toBe("vault");
    expect(activeBootStage(["setup", "session"])).toBe("session");
    expect(activeBootStage([])).toBeNull();
  });

  it("paints nothing on a fast path", () => {
    const state = run(IDLE_BOOT_STATE, [
      ["session", 1_000],
      ["vault", 1_060],
      ["phone", 1_120],
      ["tick", 1_000 + showAfterMs - 1],
      [null, 1_000 + showAfterMs - 1],
    ]);
    expect(state.phase).toBe("idle");
    expect(isBootSurfaceShown(state.phase)).toBe(false);
  });

  it("shows only after the threshold, counted across the whole chain", () => {
    const pending = run(IDLE_BOOT_STATE, [["session", 1_000], ["vault", 1_150]]);
    expect(pending.phase).toBe("pending");
    expect(nextBootDeadline(pending)).toBe(1_000 + showAfterMs);
    const shown = reduceBoot(pending, { type: "tick", at: 1_000 + showAfterMs });
    expect(shown.phase).toBe("visible");
    expect(shown.stage).toBe("vault");
  });

  it("honours the minimum visible time by lengthening the exit, never by blocking", () => {
    const shown = run(IDLE_BOOT_STATE, [["session", 0], ["tick", showAfterMs]]);
    // Released 50 ms after it was shown: the exit starts now (input reaches
    // the app this frame) and the fade covers the rest of the minimum.
    const released = reduceBoot(shown, { type: "stage", stage: null, at: showAfterMs + 50 });
    expect(released.phase).toBe("exiting");
    expect(isBootSurfaceShown(released.phase)).toBe(false);
    expect(released.stage).toBe("session"); // the line does not blank while it fades
    expect(released.exitDuration).toBe(minVisibleMs - 50);
    expect(nextBootDeadline(released)).toBe(showAfterMs + minVisibleMs);
    expect(reduceBoot(released, { type: "tick", at: showAfterMs + minVisibleMs - 1 }).phase).toBe("exiting");
    expect(reduceBoot(released, { type: "tick", at: showAfterMs + minVisibleMs }).phase).toBe("idle");

    // A release after the minimum takes the plain 150 ms exit.
    const late = reduceBoot(shown, { type: "stage", stage: null, at: showAfterMs + minVisibleMs });
    expect(late.phase).toBe("exiting");
    expect(late.exitDuration).toBe(exitMs);
    // Never shorter than the plain exit, never longer than the minimum.
    const instant = reduceBoot(shown, { type: "stage", stage: null, at: showAfterMs });
    expect(instant.exitDuration).toBe(minVisibleMs);
  });

  it("stays on the one surface when a guard claims again mid-exit", () => {
    const shown = run(IDLE_BOOT_STATE, [["vault", 0], ["tick", showAfterMs], [null, 2_000]]);
    expect(shown.phase).toBe("exiting");
    const reclaimed = reduceBoot(shown, { type: "stage", stage: "phone", at: 2_050 });
    expect(reclaimed.phase).toBe("visible");
    expect(reclaimed.stage).toBe("phone");
  });

  it("hands off to an interactive screen by releasing, never by waiting on a stage", () => {
    // The vault check resolves to the passphrase gate: the guard releases
    // its stage and renders the unlock screen; the surface exits over it.
    const shown = run(IDLE_BOOT_STATE, [["session", 0], ["tick", showAfterMs], ["vault", 700]]);
    const handedOff = reduceBoot(shown, { type: "stage", stage: null, at: 900 });
    expect(handedOff.phase).toBe("exiting");
    expect(reduceBoot(handedOff, { type: "tick", at: 900 + exitMs }).phase).toBe("idle");
  });

  it("offers a way out when one stage hangs, and resets it on progress", () => {
    const shown = run(IDLE_BOOT_STATE, [["vault", 0], ["tick", showAfterMs]]);
    expect(nextBootDeadline(shown)).toBe(stuckAfterMs);
    expect(reduceBoot(shown, { type: "tick", at: stuckAfterMs - 1 }).stuck).toBe(false);
    const stuck = reduceBoot(shown, { type: "tick", at: stuckAfterMs });
    expect(stuck.stuck).toBe(true);
    expect(nextBootDeadline(stuck)).toBeNull();
    const progressed = reduceBoot(stuck, { type: "stage", stage: "phone", at: stuckAfterMs + 10 });
    expect(progressed.stuck).toBe(false);
    expect(nextBootDeadline(progressed)).toBe(stuckAfterMs + 10 + stuckAfterMs);
  });

  it("continues the native splash without a show-after or minimum", () => {
    const launch = launchBootState("native", 600);
    expect(launch.phase).toBe("launch");
    expect(isBootSurfaceShown(launch.phase)).toBe(true);
    const done = reduceBoot(launch, { type: "stage", stage: null, at: 610 });
    expect(done.phase).toBe("exiting");
  });

  it("lets a fast web document settle before its CSS reveal paints", () => {
    const early = launchBootState("web", 120);
    expect(early.shownAt).toBeNull();
    expect(reduceBoot(early, { type: "stage", stage: null, at: 150 }).phase).toBe("idle");
    // Past the reveal, the minimum visible time counts from the reveal.
    const late = launchBootState("web", 450);
    expect(late.shownAt).toBe(showAfterMs);
    const released = reduceBoot(late, { type: "stage", stage: null, at: 460 });
    expect(released.phase).toBe("exiting");
    // 260 ms on screen leaves 140 ms of the minimum: under the 150 ms floor.
    expect(released.exitDuration).toBe(exitMs);
    const early400 = reduceBoot(launchBootState("web", 300), { type: "stage", stage: null, at: 300 });
    expect(early400.exitDuration).toBe(showAfterMs + minVisibleMs - 300);
  });
});

describe("boot surface with real guards", () => {
  beforeEach(() => {
    // The store reads the performance clock; fake it with the timers so a
    // deadline and the tick that serves it agree.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    resetBootSurfaceForTests(IDLE_BOOT_STATE);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBootSurfaceForTests();
  });

  function Guard({
    stage,
    interactive,
    redirecting,
  }: {
    stage: BootStage | null;
    interactive?: boolean;
    redirecting?: boolean;
  }) {
    if (interactive) return <button type="button">Unlock with passphrase</button>;
    if (stage)
      return <HushhLoader stage={stage} label={`detail ${stage}`} holdThroughNavigation={redirecting} />;
    return <main>Chat</main>;
  }

  function App(props: { stage: BootStage | null; interactive?: boolean; redirecting?: boolean }) {
    return (
      <>
        <BootSurface />
        <BootRouteCommitted />
        <Guard {...props} />
      </>
    );
  }

  // Releases settle in a microtask after the commit; flush it, then time.
  async function advance(ms: number) {
    await act(async () => {
      await Promise.resolve();
    });
    for (let step = 0; step < ms; step += 10) {
      await act(async () => {
        vi.advanceTimersByTime(Math.min(10, ms - step));
        await Promise.resolve();
      });
    }
  }

  it("keeps one surface across a guard chain and announces each real stage", async () => {
    const view = render(<App stage="session" />);
    await advance(20);
    const surface = screen.getByTestId("boot-surface");
    // A guard claims, nothing painted inside the show-after window.
    expect(surface).toHaveAttribute("data-boot-phase", "pending");

    view.rerender(<App stage="vault" />);
    await advance(showAfterMs);
    expect(screen.getByTestId("boot-surface")).toBe(surface);
    expect(surface).toHaveAttribute("data-boot-phase", "visible");
    expect(screen.getByRole("status")).toHaveTextContent("Opening your vault");
    expect(surface.querySelector("[data-boot-line='current']")).toHaveTextContent("🔐Opening your vault");

    view.rerender(<App stage="phone" />);
    await advance(20);
    expect(screen.getByTestId("boot-surface")).toBe(surface);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your number");
    // The guard's own loader paints nothing; the detail stays diagnostic only.
    expect(document.querySelector("[data-boot-detail='detail phone']")).toHaveAttribute("hidden");
    expect(document.querySelectorAll("[data-boot-surface]")).toHaveLength(1);

    view.rerender(<App stage={null} />);
    await advance(10);
    // Released: input reaches the app at once while the surface fades.
    expect(surface).toHaveAttribute("data-boot-phase", "exiting");
    expect(surface).toHaveAttribute("aria-hidden", "true");
    await advance(minVisibleMs);
    expect(surface).toHaveAttribute("data-boot-phase", "idle");
    expect(surface).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(getBootSurfaceState().phase).toBe("idle");
  });

  it("does not flash a warm guard chain", async () => {
    const phases: string[] = [];
    const view = render(<App stage="session" />);
    const unsubscribe = subscribeBootSurface(() => phases.push(getBootSurfaceState().phase));
    await advance(40);
    view.rerender(<App stage="vault" />);
    await advance(40);
    view.rerender(<App stage={null} />);
    await advance(showAfterMs + minVisibleMs + exitMs);
    const surface = screen.getByTestId("boot-surface");
    expect(surface).toHaveAttribute("data-boot-phase", "idle");
    expect(surface.querySelector("[data-boot-line]")).toBeNull();
    unsubscribe();
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.filter((phase) => isBootSurfaceShown(phase as BootState["phase"]))).toEqual([]);
  });

  it("hands the vault stage to the interactive unlock screen", async () => {
    const view = render(<App stage="vault" />);
    await advance(showAfterMs + minVisibleMs);
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "visible");
    view.rerender(<App stage={null} interactive />);
    await advance(20);
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "exiting");
    await advance(exitMs);
    expect(screen.getByRole("button", { name: "Unlock with passphrase" })).toBeInTheDocument();
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "idle");
  });

  it("holds a redirecting guard's stage until the destination route commits", async () => {
    navigation.pathname = "/one";
    const view = render(<App stage="redirect" redirecting />);
    await advance(showAfterMs + 20);
    const surface = screen.getByTestId("boot-surface");
    expect(surface).toHaveAttribute("data-boot-phase", "visible");
    // The guard unmounts a few frames before the destination commits.
    view.rerender(<App stage={null} redirecting />);
    await advance(120);
    expect(surface).toHaveAttribute("data-boot-phase", "visible");
    expect(screen.getByRole("status")).toHaveTextContent("Taking you to sign in");
    // The destination commits on its own path: the hold ends and the surface exits.
    navigation.pathname = "/login";
    view.rerender(<App stage={null} />);
    await advance(10);
    expect(surface).toHaveAttribute("data-boot-phase", "exiting");
    navigation.pathname = "/";
  });

  it("never lets a hold stall a page that does not navigate", async () => {
    // A non-redirecting stage releases at once.
    const view = render(<App stage="session" />);
    await advance(showAfterMs + minVisibleMs);
    view.rerender(<App stage={null} />);
    await advance(10);
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "exiting");
    // A redirect whose navigation never commits is released by the safety timer.
    view.rerender(<App stage="redirect" redirecting />);
    await advance(showAfterMs + 20);
    view.rerender(<App stage={null} redirecting />);
    await advance(3_900);
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "visible");
    await advance(200);
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "exiting");
  });

  it("counts a guard's server-rendered, not-yet-hydrated holder as held", async () => {
    // On the web a guard can arrive as server HTML long before its script
    // hydrates; the shell's commit marker must not read that as "nothing held".
    function Shell({ serverHolder, hiddenHolder }: { serverHolder: boolean; hiddenHolder?: boolean }) {
      return (
        <>
          <BootSurface />
          <BootRouteCommitted />
          {serverHolder ? (
            <div>
              <span hidden data-boot-stage="session" />
            </div>
          ) : null}
          {hiddenHolder ? (
            <div style={{ display: "none" }}>
              <span hidden data-boot-stage="vault" />
            </div>
          ) : null}
        </>
      );
    }
    resetBootSurfaceForTests();
    const view = render(<Shell serverHolder />);
    act(() => startBootSurface("web"));
    await advance(showAfterMs + 50);
    const surface = screen.getByTestId("boot-surface");
    expect(surface).toHaveAttribute("data-boot-phase", "launch");
    expect(screen.getByRole("status")).toHaveTextContent("Checking it's you");
    // Hydration drops the holder without a claim or release: the re-check sees it.
    view.rerender(<Shell serverHolder={false} />);
    await advance(150);
    expect(surface).toHaveAttribute("data-boot-phase", "exiting");

    // Markup inside a hidden subtree (a retained route) is not a hold.
    view.unmount();
    resetBootSurfaceForTests();
    render(<Shell serverHolder={false} hiddenHolder />);
    act(() => startBootSurface("web"));
    await advance(showAfterMs + 150);
    expect(screen.getByTestId("boot-surface")).not.toHaveAttribute("data-boot-phase", "launch");
  });

  it("offers Try again when a stage hangs", async () => {
    render(<App stage="phone" />);
    await advance(showAfterMs + stuckAfterMs);
    expect(screen.getByText("This is taking longer than usual.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("holds the cold document's surface until the route has committed", async () => {
    resetBootSurfaceForTests();
    render(<BootSurface />);
    act(() => startBootSurface("web"));
    await advance(1_000);
    // No guard has claimed, but the route tree has not committed either.
    expect(screen.getByTestId("boot-surface")).toHaveAttribute("data-boot-phase", "launch");
  });
});
