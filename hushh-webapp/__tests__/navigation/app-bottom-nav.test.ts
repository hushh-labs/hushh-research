import { describe, expect, it } from "vitest";

import {
  resolveBottomNavActiveKey,
  resolveBottomNavAction,
  resolveBottomNavContextKey,
  resolveBottomNavigationScope,
  resolveBottomNavHref,
  resolveBottomNavOptionKeys,
  resolveInvestorActiveNav,
  resolveInvestorNavSlot,
  resolveOneActiveNav,
  resolveOneNavSlot,
  resolveRiaActiveNav,
  resolveRiaNavSlot,
} from "@/lib/navigation/app-bottom-nav";
import { ROUTES } from "@/lib/navigation/routes";

describe("app bottom navigation", () => {
  it("uses One navigation for root and shared agent routes", () => {
    expect(resolveBottomNavigationScope("/", "investor")).toBe("one");
    expect(resolveBottomNavigationScope("/one/location", "investor")).toBe(
      "one",
    );
    expect(
      resolveBottomNavigationScope("/one/connected-systems", "investor"),
    ).toBe("one");
    expect(resolveBottomNavigationScope("/consents", "ria")).toBe("one");
    expect(resolveBottomNavigationScope("/agent", "ria")).toBe("one");
    expect(resolveBottomNavigationScope(ROUTES.MARKETPLACE, "investor")).toBe(
      "one",
    );
    expect(resolveBottomNavigationScope("/kaizen", "investor")).toBe("one");
    expect(resolveBottomNavigationScope("/marketplace-old", "ria")).toBe("one");
  });

  it("keeps investor and RIA route families scoped to their own nav", () => {
    expect(resolveBottomNavigationScope("/one/kai/portfolio", "investor")).toBe(
      "investor",
    );
    expect(resolveBottomNavigationScope("/ria/clients", "ria")).toBe("ria");
  });

  it("resolves One active mode and rotating middle slot by route", () => {
    expect(resolveOneActiveNav("/")).toBe("dashboard");
    expect(resolveOneActiveNav(ROUTES.AGENT)).toBe("search");
    expect(resolveOneActiveNav(ROUTES.PROFILE)).toBe("profile");
    expect(resolveOneActiveNav(ROUTES.GMAIL)).toBe("gmail");
    expect(resolveOneActiveNav(ROUTES.PROFILE_RECEIPTS)).toBe("gmail");
    expect(resolveOneActiveNav(ROUTES.ONE_KYC)).toBe("email");
    expect(resolveOneActiveNav(ROUTES.ONE_LOCATION)).toBe("location");
    expect(resolveOneActiveNav("/consents?tab=active")).toBe("guardian");
    expect(resolveOneActiveNav(ROUTES.PKM)).toBe("pkm");
    expect(resolveOneActiveNav(ROUTES.CONNECTED_SYSTEMS)).toBe("connected");
    expect(resolveOneActiveNav(ROUTES.MARKETPLACE)).toBe("connect");
    expect(resolveOneNavSlot(ROUTES.ONE_KYC)).toBe("email");
    expect(resolveOneNavSlot(ROUTES.PROFILE)).toBe("pkm");
    expect(resolveOneNavSlot(ROUTES.CONNECTED_SYSTEMS)).toBe("connected");
    expect(resolveOneNavSlot(ROUTES.MARKETPLACE)).toBe("connect");
  });

  it("keeps global destinations out of contextual route-family slots", () => {
    expect(resolveBottomNavHref("dashboard", "one")).toBe(ROUTES.ONE_HOME);
    expect(resolveBottomNavHref("dashboard", "investor")).toBe(ROUTES.ONE_HOME);
    expect(resolveBottomNavHref("dashboard", "ria")).toBe(ROUTES.ONE_HOME);
    expect(resolveBottomNavHref("search", "one")).toBeNull();
    expect(resolveBottomNavHref("search", "investor")).toBeNull();
    expect(resolveBottomNavAction("search", "one")).toEqual({
      type: "command",
      mode: "search",
    });
    expect(resolveBottomNavHref("profile", "ria")).toBe(ROUTES.PROFILE);
  });

  it("builds scoped bottom navigation without duplicating Search", () => {
    expect(resolveBottomNavOptionKeys(ROUTES.CONNECTED_SYSTEMS, "one")).toEqual(
      ["dashboard", "connected", "connect", "profile"],
    );
    expect(resolveBottomNavOptionKeys(ROUTES.GMAIL, "one")).toEqual([
      "dashboard",
      "gmail",
      "connect",
      "profile",
    ]);
    expect(resolveBottomNavOptionKeys(ROUTES.ONE_HOME, "one")).toEqual([
      "dashboard",
      "connect",
      "profile",
    ]);
    expect(resolveBottomNavOptionKeys(ROUTES.PROFILE, "one")).toEqual([
      "dashboard",
      "connect",
      "profile",
    ]);
    expect(resolveBottomNavOptionKeys(ROUTES.MARKETPLACE, "one")).toEqual([
      "dashboard",
      "connect",
      "profile",
    ]);
    expect(resolveBottomNavOptionKeys(ROUTES.KAI_ANALYSIS, "investor")).toEqual(
      ["finance", "portfolio", "analysis", "connect", "profile"],
    );
    expect(resolveBottomNavOptionKeys(ROUTES.RIA_PICKS, "ria")).toEqual([
      "ria-home",
      "clients",
      "picks",
      "connect",
      "profile",
    ]);
    expect(resolveBottomNavOptionKeys(ROUTES.RIA_HOME, "ria")).not.toContain(
      "finance",
    );
    expect(
      resolveBottomNavOptionKeys(ROUTES.KAI_HOME, "investor"),
    ).not.toContain("ria-home");
    expect(resolveBottomNavOptionKeys(ROUTES.KAI_HOME, "investor")).toContain(
      "portfolio",
    );
  });

  it("maps One context nav actions to the intended routes", () => {
    expect(resolveBottomNavHref("finance", "one")).toBe(ROUTES.KAI_HOME);
    expect(resolveBottomNavHref("connect", "one")).toBe(ROUTES.MARKETPLACE);
    expect(resolveBottomNavHref("gmail", "one")).toBe(ROUTES.GMAIL);
    expect(resolveBottomNavHref("email", "one")).toBe(ROUTES.ONE_KYC);
    expect(resolveBottomNavHref("location", "one")).toBe(ROUTES.ONE_LOCATION);
    expect(resolveBottomNavHref("guardian", "one")).toBe(
      "/consents?tab=pending",
    );
    expect(resolveBottomNavHref("guardian", "ria")).toBe(
      "/consents?tab=pending&actor=ria&view=outgoing",
    );
    expect(resolveBottomNavHref("pkm", "one")).toBe(ROUTES.PKM);
    expect(resolveBottomNavHref("connected", "one")).toBe(
      ROUTES.CONNECTED_SYSTEMS,
    );
  });

  it("resolves Investor and RIA context slots from the active route", () => {
    expect(resolveInvestorActiveNav(ROUTES.KAI_HOME)).toBe("finance");
    expect(resolveInvestorActiveNav(ROUTES.KAI_PORTFOLIO)).toBe("portfolio");
    expect(resolveInvestorActiveNav(ROUTES.KAI_ANALYSIS)).toBe("analysis");
    expect(resolveInvestorNavSlot(ROUTES.KAI_HOME)).toBe("finance");
    expect(resolveInvestorNavSlot(ROUTES.KAI_ANALYSIS)).toBe("analysis");

    expect(resolveRiaActiveNav(ROUTES.RIA_HOME)).toBe("ria-home");
    expect(resolveRiaActiveNav(ROUTES.RIA_CLIENTS)).toBe("clients");
    expect(resolveRiaActiveNav(ROUTES.RIA_PICKS)).toBe("picks");
    expect(resolveRiaNavSlot(ROUTES.RIA_HOME)).toBe("clients");
    expect(resolveRiaNavSlot(ROUTES.RIA_PICKS)).toBe("picks");
  });

  it("uses the shared active and context resolvers by scope", () => {
    expect(resolveBottomNavActiveKey(ROUTES.AGENT, "one")).toBe("search");
    expect(resolveBottomNavActiveKey(ROUTES.KAI_ANALYSIS, "investor")).toBe(
      "analysis",
    );
    expect(resolveBottomNavActiveKey(ROUTES.RIA_CLIENTS, "ria")).toBe(
      "clients",
    );
    expect(resolveBottomNavContextKey(ROUTES.CONNECTED_SYSTEMS, "one")).toBe(
      "connected",
    );
    expect(resolveBottomNavContextKey(ROUTES.KAI_HOME, "investor")).toBe(
      "finance",
    );
    expect(resolveBottomNavContextKey(ROUTES.RIA_HOME, "ria")).toBe("clients");
  });
});
