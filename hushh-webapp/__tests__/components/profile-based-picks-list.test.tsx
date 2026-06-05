import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileBasedPicksList } from "@/components/kai/cards/profile-based-picks-list";
import { CacheService } from "@/lib/services/cache-service";

const getDashboardProfilePicks = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getDashboardProfilePicks: (...args: unknown[]) => getDashboardProfilePicks(...args),
  },
}));

describe("ProfileBasedPicksList", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    getDashboardProfilePicks.mockReturnValue(new Promise(() => undefined));
  });

  it("keeps loading rows dimensionally aligned with loaded picks", () => {
    const { container } = render(
      <ProfileBasedPicksList
        userId="user-1"
        vaultOwnerToken="HCT:test"
        symbols={["AAPL", "MSFT"]}
        onAdd={vi.fn()}
      />
    );

    const skeletons = Array.from(container.querySelectorAll('[data-slot="skeleton"]'));
    const firstRow = skeletons[0]?.parentElement?.parentElement;

    expect(skeletons).toHaveLength(15);
    expect(firstRow?.className).toContain("p-3");
    expect(skeletons[0]?.className).toContain("h-9");
    expect(skeletons[0]?.className).toContain("w-9");
    expect(skeletons[1]?.className).toContain("h-4");
    expect(skeletons[2]?.className).toContain("h-3");
    expect(skeletons[3]?.className).toContain("h-3");
    expect(skeletons[4]?.className).toContain("h-8");
    expect(skeletons[4]?.className).toContain("w-8");
  });
});
