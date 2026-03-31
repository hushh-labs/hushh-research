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
});
