import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";

describe("ProfileStackNavigator", () => {
  it("keeps shared stack screens live when their content updates", () => {
    const { rerender } = render(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:my-data",
            title: "Personal Knowledge Model",
            content: <div>Checking your saved domains</div>,
          },
        ]}
      />
    );

    expect(screen.getByText("Checking your saved domains")).toBeTruthy();

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:my-data",
            title: "Personal Knowledge Model",
            content: <div>Financial domain ready</div>,
          },
        ]}
      />
    );

    expect(screen.queryByText("Checking your saved domains")).toBeNull();
    expect(screen.getByText("Financial domain ready")).toBeTruthy();
  });
});
