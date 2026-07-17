import { describe, expect, it } from "vitest";

import {
  resolveBottomNavActiveKey,
  resolveBottomNavAction,
  resolveBottomNavContextKey,
  resolveBottomNavigationScope,
  resolveBottomNavHref,
  resolveBottomNavOptionKeys,
  resolveBottomNavSpecialistOptionKeys,
  resolveInvestorActiveNav,
  resolveInvestorNavSlot,
  resolveOneActiveNav,
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
    expect(resolveBottomNavigationScope(ROUTES.PROFILE, "investor")).toBe(
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

  it("preserves the last agent-family scope on common Connect and Profile routes", () => {
    expect(
      resolveBottomNavigationScope(ROUTES.PROFILE, "investor", {
        lastAgentNavScope: "investor",
      }),
    ).toBe("investor");
    expect(
      resolveBottomNavigationScope(ROUTES.MARKETPLACE, "investor", {
        lastAgentNavScope: "investor",
      }),
    ).toBe("investor");
    expect(
      resolveBottomNavigationScope(ROUTES.PROFILE, "ria", {
        lastAgentNavScope: "ria",
      }),
    ).toBe("ria");
  });

  it("uses the active One agent app as the first tab on One subroutes", () => {
    expect(resolveOneActiveNav("/")).toBe("dashboard");
    expect(resolveOneActiveNav(ROUTES.ONE_HOME)).toBe("dashboard");
    expect(resolveOneActiveNav(ROUTES.GMAIL)).toBe("gmail");
    expect(resolveOneActiveNav(ROUTES.ONE_KYC)).toBe("email");
    expect(resolveOneActiveNav(ROUTES.ONE_LOCATION)).toBe("location");
    expect(resolveOneActiveNav("/consents?tab=active")).toBe("guardian");
    expect(resolveOneActiveNav(ROUTES.PKM)).toBe("pkm");
    expect(resolveOneActiveNav(ROUTES.ONE_MARKETPLACE)).toBe("marketplace");
    expect(resolveOneActiveNav(ROUTES.CONNECTED_SYSTEMS)).toBe("connected");
    // Global destinations keep their own fixed tab; Profile belongs to One
    // because Profile is not a persistent bottom-bar option.
    expect(resolveOneActiveNav(ROUTES.AGENT)).toBe("search");
    expect(resolveOneActiveNav(ROUTES.PROFILE)).toBe("profile");
    expect(resolveOneActiveNav(ROUTES.PROFILE_RECEIPTS)).toBe("profile");
    expect(resolveOneActiveNav(ROUTES.MARKETPLACE)).toBe("connect");
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
    // Profile is unified across scopes — the RIA advisor profile now lives inside
    // the global /profile section (Regulatory profile panel), so every scope opens it.
    expect(resolveBottomNavHref("profile", "ria")).toBe(ROUTES.PROFILE);
    expect(resolveBottomNavHref("profile", "one")).toBe(ROUTES.PROFILE);
    expect(resolveBottomNavHref("profile", "investor")).toBe(ROUTES.PROFILE);
  });

  it("highlights the Profile tab on unified Profile routes in RIA scope", () => {
    expect(resolveRiaActiveNav(ROUTES.PROFILE)).toBe("profile");
    expect(resolveRiaActiveNav(ROUTES.PROFILE_REGULATORY)).toBe("profile");
    expect(resolveRiaActiveNav(`${ROUTES.PROFILE_REGULATORY}?tab=services`)).toBe(
      "profile",
    );
    // RIA home stays on its own tab.
    expect(resolveRiaActiveNav(ROUTES.RIA_HOME)).toBe("ria-home");
  });

  it("keeps the primary navigation stable across route families", () => {
    for (const [pathname, scope] of [
      [ROUTES.CONNECTED_SYSTEMS, "one"],
      [ROUTES.KAI_ANALYSIS, "investor"],
      [ROUTES.RIA_PICKS, "ria"],
    ] as const) {
      expect(resolveBottomNavOptionKeys(pathname, scope)).toEqual([
        "dashboard",
        "connect",
        "search",
      ]);
    }
  });

  it("exposes specialist workspace groups separately from primary navigation", () => {
    expect(resolveBottomNavSpecialistOptionKeys("one")).toEqual([]);
    expect(resolveBottomNavSpecialistOptionKeys("investor")).toEqual([
      "finance",
      "portfolio",
      "analysis",
    ]);
    expect(resolveBottomNavSpecialistOptionKeys("ria")).toEqual([
      "ria-home",
      "clients",
      "picks",
    ]);
  });

  it("maps One context nav actions to the intended routes", () => {
    expect(resolveBottomNavHref("finance", "one")).toBe(ROUTES.KAI_HOME);
    expect(resolveBottomNavHref("connect", "one")).toBe(ROUTES.CONNECT);
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
    expect(resolveBottomNavHref("marketplace", "one")).toBe(
      ROUTES.ONE_MARKETPLACE,
    );
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

  it("selects the active workspace destination", () => {
    expect(resolveBottomNavActiveKey(ROUTES.AGENT, "one")).toBe("search");
    expect(resolveBottomNavActiveKey(ROUTES.KAI_ANALYSIS, "investor")).toBe(
      "analysis",
    );
    expect(resolveBottomNavActiveKey(ROUTES.RIA_CLIENTS, "ria")).toBe(
      "dashboard",
    );
    expect(resolveBottomNavActiveKey(ROUTES.PROFILE, "ria")).toBe("dashboard");
    expect(resolveBottomNavContextKey(ROUTES.CONNECTED_SYSTEMS, "one")).toBe(
      "connected",
    );
    expect(resolveBottomNavContextKey(ROUTES.KAI_HOME, "investor")).toBe(
      "finance",
    );
    expect(resolveBottomNavContextKey(ROUTES.RIA_HOME, "ria")).toBe("clients");
  });
});
