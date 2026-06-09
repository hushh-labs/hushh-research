import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";

describe("AppPageShell", () => {
  it("defaults signed-in page shells to compact density", () => {
    render(
      <AppPageShell>
        <AppPageHeaderRegion>Header</AppPageHeaderRegion>
        <AppPageContentRegion>Content</AppPageContentRegion>
      </AppPageShell>
    );

    const shell = screen.getByRole("main");
    expect(shell.getAttribute("data-app-density")).toBe("compact");
  });

  it("allows explicit comfortable density overrides", () => {
    render(<AppPageShell density="comfortable">Content</AppPageShell>);

    expect(screen.getByRole("main").getAttribute("data-app-density")).toBe("comfortable");
  });

  it("preserves shell rendering when header region is omitted", () => {
    render(
      <AppPageShell>
        <AppPageContentRegion>Standalone content</AppPageContentRegion>
      </AppPageShell>
    );

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByText("Standalone content")).toBeTruthy();
  });

  it("forwards the ref to the underlying DOM elements", () => {
    const shellRef = { current: null };
    const headerRef = { current: null };
    const contentRef = { current: null };

    render(
      <AppPageShell ref={shellRef}>
        <AppPageHeaderRegion ref={headerRef}>Header</AppPageHeaderRegion>
        <AppPageContentRegion ref={contentRef}>Content</AppPageContentRegion>
      </AppPageShell>
    );

    expect(shellRef.current).toBeInstanceOf(HTMLElement);
    expect(headerRef.current).toBeInstanceOf(HTMLElement);
    expect(contentRef.current).toBeInstanceOf(HTMLElement);
  });

  it("applies glassmorphism classes when the glass prop is true", () => {
    render(<AppPageShell glass>Content</AppPageShell>);
    const shell = screen.getByRole("main");
    expect(shell.className).toContain("backdrop-blur-md");
    expect(shell.className).toContain("bg-white/10");
  });

  it("applies transition classes to AppPageShell and its regions", () => {
    render(
      <AppPageShell>
        <AppPageHeaderRegion>Header</AppPageHeaderRegion>
        <AppPageContentRegion>Content</AppPageContentRegion>
      </AppPageShell>
    );

    expect(screen.getByRole("main").className).toContain("transition-all");
    expect(screen.getByRole("main").className).toContain("duration-300");
    expect(screen.getByText("Header").className).toContain("transition-all");
    expect(screen.getByText("Content").className).toContain("transition-all");
  });
});
