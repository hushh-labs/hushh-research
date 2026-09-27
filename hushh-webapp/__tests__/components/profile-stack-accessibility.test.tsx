import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";

describe("Profile screen stack keyboard isolation", () => {
  it("keeps only the visible screen interactive when opening and closing a detail", async () => {
    const rootContent = <button type="button">Root action</button>;
    const entry = {
      key: "account",
      title: "Account",
      content: <button type="button">Detail action</button>,
    };
    const view = render(
      <ProfileStackNavigator rootContent={rootContent} entries={[entry]} />,
    );

    const rootScreen = screen.getByText("Root action").closest("section");
    const detailScreen = screen.getByText("Detail action").closest("section");
    expect(rootScreen?.hasAttribute("inert")).toBe(true);
    expect(detailScreen?.hasAttribute("inert")).toBe(false);

    view.rerender(
      <ProfileStackNavigator rootContent={rootContent} entries={[]} />,
    );
    await waitFor(() => {
      expect(rootScreen?.hasAttribute("inert")).toBe(false);
      expect(
        !detailScreen?.isConnected || detailScreen.hasAttribute("inert"),
      ).toBe(true);
    });
  });
});
