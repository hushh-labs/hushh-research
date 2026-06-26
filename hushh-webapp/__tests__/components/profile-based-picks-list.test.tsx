import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileBasedPicksList } from "@/components/kai/cards/profile-based-picks-list";

describe("ProfileBasedPicksList", () => {
  it("renders empty picks state", async () => {
    render(
      <ProfileBasedPicksList
        userId="user-1"
        vaultOwnerToken="token-1"
        symbols={[]}
        onAdd={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("No profile picks available from current market context."),
    ).toBeTruthy();
  });
});
