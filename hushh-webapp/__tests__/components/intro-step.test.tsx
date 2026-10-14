import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function enterStories() {
  fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
  expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "2");
}

describe("IntroStep", () => {
  it("preserves the welcome and hands the four mentor stories to sign-in", async () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    expect(screen.getByRole("heading", { name: "Your private AI agent for everyday life." })).toBeInTheDocument();
    enterStories();
    const titles = [
      /Big plans\.\s*Less busywork\./,
      /Find answers\.\s*Not more tabs\./,
      /Your people\.\s*Right here\./,
      /Your information\.\s*Your call\./,
    ];
    for (const [index, title] of titles.entries()) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(document.querySelectorAll(".ao-slide")).toHaveLength(1);
      expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", String(index + 2));
      expect(onLogin).not.toHaveBeenCalled();
      if (index < titles.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
  });

  it("honors the explicit Skip action from the first story", async () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);
    enterStories();
    fireEvent.click(screen.getByRole("button", { name: "Skip", exact: true }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
  });

  it("unwinds native Back through the stories and welcome, then releases its layer", () => {
    const onLogin = vi.fn();
    const view = render(<IntroStep onLogin={onLogin} />);
    expect(unwindBackLayer("/")).toBe(false);
    enterStories();
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    act(() => expect(unwindBackLayer("/")).toBe(true));
    expect(screen.getByRole("heading", { name: /Big plans\.\s*Less busywork\./ })).toBeInTheDocument();
    act(() => expect(unwindBackLayer("/")).toBe(true));
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    expect(unwindBackLayer("/")).toBe(false);
    expect(onLogin).not.toHaveBeenCalled();
    enterStories();
    view.unmount();
    expect(unwindBackLayer("/")).toBe(false);
  });

  it("keeps voice sign-in guarded until the final story and releases its handler on leave", async () => {
    const onLogin = vi.fn();
    const view = render(<IntroStep onLogin={onLogin} />);
    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()).toMatchObject({
        screenId: "one_intro",
        actions: [expect.objectContaining({ actionId: "onboarding.claim_one" })],
        controls: [expect.objectContaining({ id: "onboarding_claim_one" })],
      });
      expect(resolveLocalOnboardingHandler("onboarding.claim_one")).not.toBeNull();
    });
    expect(await resolveLocalOnboardingHandler("onboarding.claim_one")?.({})).toMatchObject({ status: "blocked" });
    enterStories();
    expect(await resolveLocalOnboardingHandler("onboarding.claim_one")?.({})).toMatchObject({ status: "blocked" });
    expect(onLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Screen 4 of 4: Stay in control" }));
    expect(screen.getByRole("button", { name: "Get started", exact: true })).toHaveAttribute("data-voice-control-id", "onboarding_claim_one");
    expect(await resolveLocalOnboardingHandler("onboarding.claim_one")?.({})).toEqual({
      status: "started",
      summary: "Opening sign-in.",
      routeAfter: "/login",
      screenAfter: "login",
    });
    expect(onLogin).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    expect(await resolveLocalOnboardingHandler("onboarding.claim_one")?.({})).toMatchObject({ status: "blocked" });
    expect(onLogin).toHaveBeenCalledOnce();
    view.unmount();
    expect(resolveLocalOnboardingHandler("onboarding.claim_one")).toBeNull();
  });

  it("keeps the public Research, Blog, and Developers destinations", () => {
    render(<IntroStep onLogin={vi.fn()} />);
    expect(screen.getByRole("navigation", { name: "Explore Hussh" }).querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/research");
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("link", { name: "Developers" })).toHaveAttribute("href", "/developers");
  });
});
