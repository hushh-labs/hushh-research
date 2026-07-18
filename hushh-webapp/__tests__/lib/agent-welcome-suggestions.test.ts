import { describe, expect, it, beforeEach } from "vitest";

import { resolveAgentWelcomeSuggestions } from "@/lib/agent/agent-welcome-suggestions";
import { CacheService } from "@/lib/services/cache-service";

describe("agent welcome suggestions", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
  });

  it("returns cached, route-aware suggestions for Connect", () => {
    const suggestions = resolveAgentWelcomeSuggestions({
      userId: "user_1",
      pathname: "/marketplace",
      persona: "ria",
      randomSeed: 7,
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions.some((item) => item.id === "connect-request")).toBe(true);

    const second = resolveAgentWelcomeSuggestions({
      userId: "user_1",
      pathname: "/marketplace",
      persona: "ria",
      randomSeed: 7,
    });

    expect(second).toEqual(suggestions);
  });

  it("can rotate suggestions from the cached pool on a fresh chat", () => {
    const first = resolveAgentWelcomeSuggestions({
      userId: "user_2",
      pathname: "/one/kai/portfolio",
      persona: "investor",
      randomSeed: 1,
    }).map((item) => item.id);
    const rotated = resolveAgentWelcomeSuggestions({
      userId: "user_2",
      pathname: "/one/kai/portfolio",
      persona: "investor",
      randomSeed: 99,
    }).map((item) => item.id);

    expect(first).toHaveLength(3);
    expect(rotated).toHaveLength(3);
    expect(rotated).not.toEqual(first);
  });
  
  it("clamps suggestion limits to the supported range", () => {
   const minimum = resolveAgentWelcomeSuggestions({
    userId: "limit-user",
    limit: 0,
   });

   const maximum = resolveAgentWelcomeSuggestions({
    userId: "limit-user",
    limit: 999,
   });

   expect(minimum).toHaveLength(1);
   expect(maximum).toHaveLength(5);
   });

  it("matches route suggestions when pathname contains query parameters", () => {
  const suggestions = resolveAgentWelcomeSuggestions({
    userId: "user-query",
    pathname: "/marketplace?tab=connect",
    randomSeed: 7,
  });

  expect(
    suggestions.some((item) => item.id === "connect-request")
  ).toBe(true);
  });
});
