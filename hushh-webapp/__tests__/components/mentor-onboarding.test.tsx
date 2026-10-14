import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOneOnboarding } from "@/components/onboarding/mentor-onboarding/AgentOneOnboarding";

type Completion = (reason: "finished" | "skipped") => void | Promise<void>;

function Harness({ onComplete = vi.fn(), initialIndex = 0 }: { onComplete?: Completion; initialIndex?: number }) {
  const [index, setIndex] = useState(initialIndex);
  return <AgentOneOnboarding index={index} onIndexChange={setIndex} onComplete={onComplete} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mentor onboarding interaction contract", () => {
  it("navigates one mounted story, focuses its heading, and keeps completion explicit", async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    expect(document.querySelectorAll(".ao-slide")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.getByRole("heading", { name: /Find answers\.\s*Not more tabs\./ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    expect(screen.getByRole("heading", { name: /Big plans\.\s*Less busywork\./ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Screen 4 of 4: Stay in control" }));
    expect(screen.getByRole("heading", { name: /Your information\.\s*Your call\./ })).toHaveFocus();
    expect(document.querySelectorAll(".ao-slide")).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledExactlyOnceWith("finished"));
  });

  it("deduplicates completion while the owning route callback is pending", async () => {
    let settle!: () => void;
    const onComplete = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<Harness onComplete={onComplete} />);
    const skip = screen.getByRole("button", { name: "Skip", exact: true });
    fireEvent.click(skip);
    fireEvent.click(skip);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("skipped");
    expect(skip).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continuing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Screen 2 of 4: Find your answers" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("region", { name: "Meet Agent One" }), { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: /Big plans\.\s*Less busywork\./ })).toBeInTheDocument();
    await act(async () => settle());
  });

  it("keeps the current story and allows a retry when completion fails", async () => {
    const onComplete = vi.fn().mockRejectedValueOnce(new Error("route unavailable")).mockResolvedValueOnce(undefined);
    render(<Harness onComplete={onComplete} initialIndex={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not continue. Please try again.");
    expect(screen.getByRole("heading", { name: /Your information\.\s*Your call\./ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps an unavailable invitation from completing through either action", () => {
    const onComplete = vi.fn();
    render(<AgentOneOnboarding index={3} onIndexChange={vi.fn()} onComplete={onComplete} finalActionLabel="Join this Circle" finalActionDisabled invitationContent={<p>This invitation has expired.</p>} />);
    expect(screen.getByText("This invitation has expired.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join this Circle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip", exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Skip", exact: true }));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("uses the original still artwork when reduced motion is requested", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ ...media, media: query, matches: query === "(prefers-reduced-motion: reduce)" })));
    render(<Harness />);
    expect(document.querySelector(".ao-mascot__poster")).toHaveAttribute("src", "/onboarding/mentor-v72/working-poster.png");
    expect(document.querySelector(".ao-mascot__loop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(document.querySelector(".ao-mascot__poster")).toHaveAttribute("src", "/onboarding/mentor-v72/thinking-poster.png");
    expect(document.querySelector(".ao-mascot__loop")).toBeNull();
  });

  it("rests after one loaded animation cycle and cleans up timers on leave", () => {
    vi.useFakeTimers();
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const view = render(<Harness />);
    const loop = document.querySelector(".ao-mascot__loop");
    expect(loop).not.toBeNull();
    fireEvent.load(loop!);
    expect(document.querySelector(".ao-mascot")).toHaveAttribute("data-playing", "true");
    act(() => vi.advanceTimersByTime(2999));
    expect(document.querySelector(".ao-mascot__loop")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector(".ao-mascot__loop")).toBeNull();
    expect(document.querySelector(".ao-mascot__poster")).toHaveStyle({ opacity: "1" });
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    fireEvent.load(document.querySelector(".ao-mascot__loop")!);
    const cycleCall = timeouts.mock.calls.map(([, delay]) => delay).lastIndexOf(3000);
    const cycleTimer = timeouts.mock.results[cycleCall]?.value;
    expect(cycleTimer).toBeDefined();
    view.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(cycleTimer);
  });

  it("falls back to the original poster if an animation cannot load", () => {
    render(<Harness />);
    fireEvent.error(document.querySelector(".ao-mascot__loop")!);
    expect(document.querySelector(".ao-mascot__loop")).toBeNull();
    expect(document.querySelector(".ao-mascot__poster")).toHaveStyle({ opacity: "1" });
    expect(screen.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  });
});
