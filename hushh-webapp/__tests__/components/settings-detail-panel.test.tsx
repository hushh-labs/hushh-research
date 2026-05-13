import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDetailPanel } from "@/components/profile/settings-ui";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("SettingsDetailPanel accessibility", () => {
  it("preserves dialog accessibility semantics", () => {
    render(
     <SettingsDetailPanel
  open
  onOpenChange={() => {}}
  title="Settings"
  description="Settings dialog"
>
  <div>Content</div>
</SettingsDetailPanel>
 );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});