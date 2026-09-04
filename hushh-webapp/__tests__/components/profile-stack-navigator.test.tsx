import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      />,
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
      />,
    );

    expect(screen.queryByText("Checking your saved domains")).toBeNull();
    expect(screen.getByText("Financial domain ready")).toBeTruthy();
  });
  it("preserves root rendering stability with empty stack entries", () => {
    render(
      <ProfileStackNavigator
        rootContent={<div>Root workspace</div>}
        entries={[]}
      />,
    );

    expect(screen.getByText("Root workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("inherits the canonical app canvas instead of repainting a Profile background", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-stack-navigator.tsx"),
      "utf8",
    );

    expect(source).not.toContain("overflow-hidden bg-background");
  });

  it("uses the shared PageHeader and app gutter tokens for every nested Profile screen", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-stack-navigator.tsx"),
      "utf8",
    );

    expect(source).toContain('from "@/components/app-ui/page-sections"');
    expect(source).toContain("<PageHeader");
    expect(source).toContain('testId="profile-stack-page-header"');
    expect(source).toContain("px-[var(--page-inline-gutter-standard)]");
    expect(source).toContain("pt-[var(--page-header-section-gap)]");
    expect(source).toContain("<SettingsPresentationProvider");
    expect(source).toContain("separatorInset");
    expect(source).toContain('density="compact"');
  });
});
