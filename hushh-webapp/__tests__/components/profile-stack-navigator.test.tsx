import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";

function mountScrollRoot(attribute: string) {
  const root = document.createElement("div");
  root.setAttribute(attribute, "true");
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    root.scrollTop = options.top ?? 0;
  });
  Object.defineProperty(root, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  document.body.append(root);
  return { root, scrollTo };
}

describe("ProfileStackNavigator", () => {
  afterEach(() => {
    document
      .querySelectorAll(
        '[data-profile-pane-scroll-root="true"], [data-app-scroll-root="true"]',
      )
      .forEach((root) => root.remove());
  });

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

  it("resets the route scroll root even while a closing Profile pane remains mounted", () => {
    const appRoot = mountScrollRoot("data-app-scroll-root");
    const paneRoot = mountScrollRoot("data-profile-pane-scroll-root");
    const { rerender } = render(
      <ProfileStackNavigator rootContent={<div>Root</div>} entries={[]} />,
    );

    appRoot.scrollTo.mockClear();
    paneRoot.scrollTo.mockClear();
    appRoot.root.scrollTop = 96;
    paneRoot.root.scrollTop = 48;

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:security",
            title: "Security & privacy",
            content: <div>Security content</div>,
          },
        ]}
      />,
    );

    expect(appRoot.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    });
    expect(paneRoot.scrollTo).not.toHaveBeenCalled();
  });

  it("uses the pane scroll root for in-pane Profile navigation", () => {
    const appRoot = mountScrollRoot("data-app-scroll-root");
    const paneRoot = mountScrollRoot("data-profile-pane-scroll-root");
    const { rerender } = render(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[]}
        resetScroll={false}
      />,
    );

    appRoot.scrollTo.mockClear();
    paneRoot.scrollTo.mockClear();
    paneRoot.root.scrollTop = 48;

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        resetScroll={false}
        entries={[
          {
            key: "panel:security",
            title: "Security & privacy",
            content: <div>Security content</div>,
          },
        ]}
      />,
    );

    expect(paneRoot.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    });
    expect(appRoot.scrollTo).not.toHaveBeenCalled();
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
    // The outer AppPageShell owns the gutter; doubling it shifts nested rows.
    expect(source).not.toContain("px-[var(--page-inline-gutter-standard)]");
    expect(source).toContain("pt-[var(--page-header-section-gap)]");
    expect(source).toContain("<SettingsPresentationProvider");
    expect(source).toContain("separatorInset");
    expect(source).toContain('density="compact"');
  });
});
