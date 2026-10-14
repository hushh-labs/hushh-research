import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { HUSHH_MARK_PATH } from "@/lib/brand/hushh-mark";
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

describe("IntroStep voice contract", () => {
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

  it("returns from the first story to welcome without starting authentication", () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    expect(screen.getByRole("heading", { name: "One", exact: true })).toBeInTheDocument();
    const welcomeMark = document.querySelector("[data-hushh-mark] img");
    const markUrl = new URL(welcomeMark?.getAttribute("src") ?? "", "http://localhost");
    expect(markUrl.searchParams.get("url") ?? markUrl.pathname).toBe(HUSHH_MARK_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    const first = screen.getByRole("region", { name: /^1 of 4:/ });
    fireEvent.click(within(first).getByRole("button", { name: "Previous screen", exact: true }));
    expect(screen.getByRole("heading", { name: "One", exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
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
