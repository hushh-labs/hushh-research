// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/connect/advisors-nearby", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    AdvisorsNearby: () => {
      const [count, setCount] = React.useState(0);
      return (
        <button
          type="button"
          data-testid="advisors-pane"
          onClick={() => setCount((current) => current + 1)}
        >
          advisors {count}
        </button>
      );
    },
  };
});

vi.mock("@/components/connect/insurance-agents-nearby", () => ({
  InsuranceAgentsNearby: () => (
    <div data-testid="insurance-pane">insurance</div>
  ),
}));

vi.mock("@/components/connect/places-nearby", () => ({
  PlacesNearby: () => <div data-testid="places-pane">places</div>,
}));

import { NearbyDirectories } from "@/components/connect/nearby-directories";

describe("NearbyDirectories", () => {
  it("keeps a visited Around You directory mounted when switching away and back", () => {
    render(<NearbyDirectories getIdToken={async () => "id-token"} />);

    fireEvent.click(screen.getByTestId("advisors-pane"));
    expect(screen.getByText("advisors 1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("nearby-directory-insurance"));
    expect(screen.getByTestId("insurance-pane")).toBeTruthy();

    fireEvent.click(screen.getByTestId("nearby-directory-advisors"));
    expect(screen.getByText("advisors 1")).toBeTruthy();
  });
});
