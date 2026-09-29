import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({
  OnboardingHeroBackground: () => null,
}));

// Browser coverage verifies GSAP; keep component tests focused on the flow.
vi.mock("@/lib/morphy-ux/gsap", () => ({
  getGsap: vi.fn(async () => null),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("IntroStep voice contract", () => {
  it("cycles Circles and agents every 2.5 seconds and releases timers on leave", () => {
    vi.useFakeTimers();
    const onLogin = vi.fn();
    const { unmount } = render(<IntroStep onLogin={onLogin} />);
    for (const name of [
      "Family",
      "Friends",
      "Finance",
      "Business",
      "Family",
      "Friends",
      "Finance",
      "Business",
    ]) {
      expect(screen.getByRole("button", { name, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      act(() => vi.advanceTimersByTime(2499));
      expect(screen.getByRole("button", { name, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      act(() => vi.advanceTimersByTime(1));
    }
    expect(
      screen.getByRole("button", { name: "Family", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Finance", exact: true }),
    );
    expect(
      screen.getByRole("button", { name: "Finance", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", { name: "Finance Circle" }),
    ).toBeVisible();
    act(() => vi.advanceTimersByTime(2500));
    expect(
      screen.getByRole("button", { name: "Business", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    const agents = Array.from(
      document.querySelectorAll("[data-agent-tour] button"),
    );
    for (const agent of agents) {
      expect(agent).toHaveAttribute("aria-pressed", "true");
      act(() => vi.advanceTimersByTime(2500));
    }
    expect(agents[0]).toHaveAttribute("aria-pressed", "true");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(20000));
    expect(agents[0]).toHaveAttribute("aria-pressed", "true");
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(2500));
    expect(agents[1]).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: /pause|replay/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Examples")).not.toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reduced-motion previews static but lets people explore each Circle", () => {
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
    render(<IntroStep onLogin={vi.fn()} />);
    act(() => vi.advanceTimersByTime(20000));
    expect(
      screen.getByRole("button", { name: "Family", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "Pause Circle tour" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Business", exact: true }),
    );
    expect(
      screen.getByRole("heading", { name: "Business Circle" }),
    ).toBeVisible();
  });

  it("publishes and executes the same Claim your One control used by tapping", async () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);

    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()).toMatchObject({
        screenId: "one_intro",
        actions: [
          expect.objectContaining({ actionId: "onboarding.claim_one" }),
        ],
        controls: [expect.objectContaining({ id: "onboarding_claim_one" })],
      });
      expect(
        resolveLocalOnboardingHandler("onboarding.claim_one"),
      ).not.toBeNull();
    });

    expect(
      screen.queryByRole("button", { name: "Sign in", exact: true }),
    ).not.toBeInTheDocument();
    const earlyResult = await resolveLocalOnboardingHandler(
      "onboarding.claim_one",
    )?.({});
    expect(earlyResult?.status).toBe("blocked");
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    const button = screen.getByRole("button", { name: "Sign in", exact: true });
    expect(button).toHaveAttribute(
      "data-voice-control-id",
      "onboarding_claim_one",
    );
    expect(button.querySelector(":scope > .morphy-ripple-host")).not.toBeNull();
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);

    const handler = resolveLocalOnboardingHandler("onboarding.claim_one");
    const result = await handler?.({});
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "started",
      summary: "Opening sign-in.",
      routeAfter: "/login",
      screenAfter: "login",
    });
  });

  it("shows exactly three previews, with no login until an account action", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    expect(
      screen.getByRole("heading", { name: "Your people, closer." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "hushh", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Screen 3: Get started" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    expect(
      screen.getByRole("img", { name: "hushh", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Calendar", exact: true }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    expect(
      screen.getByRole("img", { name: "hushh", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Just ask One." }),
    ).toBeInTheDocument();
    const prompts = screen.getAllByTestId("preview-chat-prompt");
    const replies = screen.getAllByTestId("preview-chat-reply");
    expect(prompts).toHaveLength(2);
    expect(replies).toHaveLength(2);
    expect(prompts[0]).toHaveTextContent(
      "Find 30 free minutes tomorrow afternoon",
    );
    expect(prompts[1]).toHaveTextContent(
      "Can you share my location with my Family Circle for the next 2 hours, until I reach home?",
    );
    expect(replies[0]).toHaveTextContent("Open 30-minute slots tomorrow:");
    expect(replies[0]).toHaveTextContent(
      "12:00–12:30 PM · 12:30–1:00 PM · 1:00–1:30 PM",
    );
    expect(replies[1]).toHaveTextContent(
      "Stop sharing early when you reach home.",
    );
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByText("Google Calendar")).toBeVisible();
    expect(
      screen.getByText("Finding free time on your calendar."),
    ).toBeVisible();
    expect(prompts[0].closest("[data-chat-turn]")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    expect(prompts[1].closest("[data-chat-turn]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Location", exact: true }),
    );
    expect(prompts[1].closest("[data-chat-turn]")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    expect(prompts[0].closest("[data-chat-turn]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.queryByText("Connect and share on your terms."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /pause|replay/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("An example conversation"),
    ).not.toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create your One" }));
    expect(onLogin).toHaveBeenCalledOnce();
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
