import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { HUSHH_MARK_PATH } from "@/lib/brand/hushh-mark";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({
  OnboardingHeroBackground: () => null,
}));

// Browser coverage verifies GSAP; keep component tests focused on the flow.
vi.mock("@/lib/morphy-ux/gsap", () => ({
  getGsap: vi.fn(async () => null),
}));

const storyTitles = [
  "Start with a clearer day.",
  "Find what you already have.",
  "Make the next move easier.",
  "Share only what you choose.",
];

function activeStory() {
  const heading = screen.getByRole("heading", { level: 1 });
  const section = heading.closest("section");
  if (!section) throw new Error("The active story must be a slide.");
  return within(section);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("IntroStep voice contract", () => {
  it("moves through four stories with next, keyboard, and dots without signing in", () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));

    for (let index = 0; index < storyTitles.length; index += 1) {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[index]);
      expect(activeStory().getByRole("button", {
        name: `Screen ${index + 1}: ${storyTitles[index]}`,
      })).toHaveAttribute("aria-current", "step");
      if (index < storyTitles.length - 1) {
        fireEvent.click(activeStory().getByRole("button", { name: "Next screen" }));
      }
    }
    const carousel = screen.getByRole("region", { name: "Introducing One" });
    fireEvent.keyDown(carousel, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[2]);
    fireEvent.keyDown(carousel, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[3]);
    fireEvent.click(activeStory().getByRole("button", {
      name: `Screen 1: ${storyTitles[0]}`,
    }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[0]);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("keeps reduced-motion stories static while allowing navigation and releases timers", () => {
    vi.useFakeTimers();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        ...media,
        media: query,
        matches: query === "(prefers-reduced-motion: reduce)",
      })),
    );
    const onLogin = vi.fn();
    const { unmount } = render(<IntroStep onLogin={onLogin} />);
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    act(() => vi.advanceTimersByTime(20000));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[0]);
    fireEvent.click(activeStory().getByRole("button", {
      name: `Screen 3: ${storyTitles[2]}`,
    }));
    act(() => vi.advanceTimersByTime(20000));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[2]);
    expect(onLogin).not.toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks early voice sign-in and gives the final Start with One control tap/voice parity", async () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()).toMatchObject({
        screenId: "one_intro",
        actions: [expect.objectContaining({ actionId: "onboarding.claim_one" })],
        controls: [expect.objectContaining({ id: "onboarding_claim_one" })],
      });
      expect(resolveLocalOnboardingHandler("onboarding.claim_one")).not.toBeNull();
    });
    expect((await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}))?.status).toBe("blocked");
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    expect((await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}))?.status).toBe("blocked");
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(activeStory().getByRole("button", { name: "Skip", exact: true }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[3]);
    const button = activeStory().getByRole("button", { name: "Start with One", exact: true });
    expect(button).toHaveAttribute("data-voice-control-id", "onboarding_claim_one");
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);
    const result = await resolveLocalOnboardingHandler("onboarding.claim_one")?.({});
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "started",
      summary: "Opening sign-in.",
      routeAfter: "/login",
      screenAfter: "login",
    });
    fireEvent.click(activeStory().getByRole("button", { name: "Previous screen" }));
    expect((await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}))?.status).toBe("blocked");
    expect(onLogin).toHaveBeenCalledTimes(2);
  });

  it("retains the welcome and returns there through Back without signing in", () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    expect(screen.getByRole("heading", { name: "One", exact: true })).toBeInTheDocument();
    expect(screen.getByText("Your agents. Yours to own.")).toBeInTheDocument();
    expect(screen.getByText("Your personal team of AI agents.")).toBeInTheDocument();
    expect(screen.getByText("You choose what to share.").parentElement?.querySelector("img")).not.toBeNull();
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    const welcomeMark = document.querySelector("[data-hushh-mark] img");
    const markUrl = new URL(welcomeMark?.getAttribute("src") ?? "", "http://localhost");
    expect(markUrl.searchParams.get("url") ?? markUrl.pathname).toBe(HUSHH_MARK_PATH);
    expect(screen.queryByRole("button", { name: "Start with One", exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "2");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(storyTitles[0]);
    expect(activeStory().getAllByRole("button", { name: /^Screen \d/ })).toHaveLength(4);
    fireEvent.click(activeStory().getByRole("button", { name: "Previous screen" }));
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    expect(screen.getByRole("heading", { name: "One", exact: true })).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("keeps the root public navigation to Research, Blog, and Developers", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    const publicNav = screen.getByRole("navigation", { name: "Explore Hussh" });
    expect(publicNav.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute(
      "href",
      "/research",
    );
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute(
      "href",
      "/blog",
    );
    expect(screen.getByRole("link", { name: "Developers" })).toHaveAttribute(
      "href",
      "/developers",
    );
  });
});
