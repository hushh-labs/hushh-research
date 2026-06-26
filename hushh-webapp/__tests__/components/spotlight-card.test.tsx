import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SpotlightCard } from "@/components/kai/cards/spotlight-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe("SpotlightCard", () => {
  it("renders card title with heading semantics", () => {
    render(
      <SpotlightCard
        symbol="NVDA"
        companyName="Nvidia"
        title="AI infrastructure momentum"
        price="$900.00"
        decision="WATCH"
        summary="Demand remains durable across accelerated compute workloads."
        context="Renaissance market spotlight"
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "AI infrastructure momentum",
      }),
    ).toBeTruthy();
  });
});
