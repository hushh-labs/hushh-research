import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "loading" }),
}));

import { FriendsMap } from "@/components/one-location/redesign/friends-map";

describe("FriendsMap", () => {
  it("shows a useful empty state before a connection shares", () => {
    render(<FriendsMap entries={[]} />);

    expect(
      screen.getByText("No connections are sharing right now"),
    ).toBeInTheDocument();
  });

  it("keeps sharing entries usable when the map provider is unavailable", () => {
    render(
      <FriendsMap
        entries={[
          {
            id: "friend-1",
            name: "Neelesh Meena",
            point: {
              latitude: 28.6139,
              longitude: 77.209,
              capturedAt: new Date().toISOString(),
              sourcePlatform: "web",
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByText(
        "Map unavailable. Live connections remain available below.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Neelesh Meena/i }),
    ).toHaveTextContent("Live -");
  });
});
