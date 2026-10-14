import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

vi.mock("@/lib/morphy-ux/gsap", () => ({ getGsap: vi.fn(async () => null) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function advanceStory(index: number) {
  const story = screen.getByRole("region", { name: new RegExp(`^${index} of 4:`) });
  fireEvent.click(within(story).getByRole("button", { name: "Next screen", exact: true }));
}

function enterStories() {
  fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
  expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "2");
}

function skipToFinalStory() {
  enterStories();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "5");
}

describe("IntroStep", () => {
  it("shows the welcome, then one of four everyday-life stories at a time", () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);

    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    expect(screen.getByRole("heading", { name: "Your private AI agent for everyday life." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start with One" })).not.toBeInTheDocument();

    enterStories();
    const storyTitles = [
      "Start with a clearer day.",
      "Find what you already have.",
      "Make the next move easier.",
      "Share only what you choose.",
    ];
    for (const [index, title] of storyTitles.entries()) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(document.querySelectorAll('[data-intro-v2-card="true"]:not([hidden])')).toHaveLength(1);
      expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", String(index + 2));
      if (index < storyTitles.length - 1) {
        expect(screen.queryByRole("button", { name: "Start with One" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Next screen" }));
      }
    }
    fireEvent.click(screen.getByRole("button", { name: "Start with One" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("supports Skip, Back, and direct story selection without starting sign-in", () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);

    skipToFinalStory();
    expect(screen.getByRole("heading", { name: "Share only what you choose." })).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    expect(screen.getByRole("heading", { name: "Make the next move easier." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Screen 2: Find what you already have." }));
    expect(screen.getByRole("heading", { name: "Find what you already have." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    expect(screen.getByRole("heading", { name: "Your private AI agent for everyday life." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create your One", exact: true })).toBeVisible();
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("keeps reduced-motion welcome artwork static while allowing navigation", () => {
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
    expect(document.querySelector('[data-motion="static"]')).not.toBeNull();
    enterStories();
    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));
    expect(screen.getByRole("heading", { name: "Find what you already have." })).toBeInTheDocument();
  });

  it("keeps early voice admission blocked and shares final sign-in authority with tapping", async () => {
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
    let result;
    await act(async () => { result = await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}); });
    expect(result).toMatchObject({ status: "blocked" });
    expect(onLogin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    await act(async () => { result = await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}); });
    expect(result).toMatchObject({ status: "blocked" });
    expect(onLogin).not.toHaveBeenCalled();
    for (const step of [1, 2, 3]) advanceStory(step);
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "5");
    const button = screen.getByRole("button", { name: "Start with One", exact: true });
    expect(button).toHaveAttribute("data-voice-control-id", "onboarding_claim_one");
    expect(button.querySelector(":scope > .morphy-ripple-host")).not.toBeNull();
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);
    await act(async () => { result = await resolveLocalOnboardingHandler("onboarding.claim_one")?.({}); });
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "started", summary: "Opening sign-in.", routeAfter: "/login", screenAfter: "login" });
  });

  it("keeps the public navigation to Research, Blog, and Developers", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    const publicNav = screen.getByRole("navigation", { name: "Explore Hussh" });
    expect(publicNav.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/research");
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("link", { name: "Developers" })).toHaveAttribute("href", "/developers");
  });
});
