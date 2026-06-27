import { describe, expect, it } from "vitest";

import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";

describe("getKaiChromeState command bar hiding routes", () => {
  it("hides the command bar on the home route", () => {
    expect(
      getKaiChromeState(ROUTES.HOME, {
        onboardingFlowActive: false,
      }).hideCommandBar,
    ).toBe(true);
  });

  it("hides the command bar on the agent route", () => {
    expect(
      getKaiChromeState(ROUTES.AGENT, {
        onboardingFlowActive: false,
      }).hideCommandBar,
    ).toBe(true);
  });

  it("hides the command bar on phone mandate routes", () => {
    expect(
      getKaiChromeState(
        `${ROUTES.PHONE_MANDATE}/verify`,
        {
          onboardingFlowActive: false,
        },
      ).hideCommandBar,
    ).toBe(true);
  });

  it("hides the command bar on logout routes", () => {
    expect(
      getKaiChromeState(ROUTES.LOGOUT, {
        onboardingFlowActive: false,
      }).hideCommandBar,
    ).toBe(true);
  });

  it("hides the command bar on labs profile appearance routes", () => {
    expect(
      getKaiChromeState(
        `${ROUTES.LABS_PROFILE_APPEARANCE}/settings`,
        {
          onboardingFlowActive: false,
        },
      ).hideCommandBar,
    ).toBe(true);
  });

  it("does not hide the command bar for null pathnames", () => {
    expect(
      getKaiChromeState(null, {
        onboardingFlowActive: false,
      }).hideCommandBar,
    ).toBe(false);
  });
});