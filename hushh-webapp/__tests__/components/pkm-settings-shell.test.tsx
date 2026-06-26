import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/profile/pkm",
}));

vi.mock("@/lib/morphy-ux/hooks/use-page-enter", () => ({
  usePageEnterAnimation: vi.fn(),
}));

vi.mock("@/lib/morphy-ux/gsap", () => ({
  getGsap: vi.fn(),
  prefersReducedMotion: () => true,
}));

vi.mock("@/lib/morphy-ux/gsap-init", () => ({
  ensureMorphyGsapReady: vi.fn(),
  getMorphyEaseName: () => "power2.out",
}));

describe("PkmSettingsShell", () => {
  it("renders shell heading semantics", () => {
    render(
      <PkmSettingsShell
        title="Memory controls"
        description="Manage what Kai can remember."
      >
        <div>Settings content</div>
      </PkmSettingsShell>
    );

    expect(
      screen.getByRole("heading", { name: "Memory controls", level: 1 })
    ).toBeTruthy();
    expect(screen.getByText("Profile / Privacy")).toBeTruthy();
    expect(screen.getByText("Manage what Kai can remember.")).toBeTruthy();
  });
});
