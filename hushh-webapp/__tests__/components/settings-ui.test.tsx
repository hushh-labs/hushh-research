import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LogOut, Phone } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";

describe("SettingsRow", () => {
  it("wraps both primary action and trailing in a single interactive row", () => {
    const handleOpen = vi.fn();
    const handleTrailing = vi.fn();
    render(
      <SettingsRow
        title="Open privacy"
        description="Manage vault controls"
        onClick={handleOpen}
        trailing={
          <button type="button" onClick={handleTrailing}>
            Manage
          </button>
        }
      />,
    );

    // Clicking the primary area fires the row onClick
    fireEvent.click(screen.getByRole("button", { name: /open privacy/i }));

    // The trailing button is also reachable
    const trailingButton = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.trim() === "Manage");
    expect(trailingButton).toBeTruthy();
    fireEvent.click(trailingButton!);

    // Both handlers fire (trailing click propagation stopped, so only trailing fires)
    expect(handleOpen).toHaveBeenCalledTimes(1);
    expect(handleTrailing).toHaveBeenCalledTimes(1);
  });

  it("keeps a trailing switch accessible within the unified row", () => {
    const handleOpen = vi.fn();
    render(
      <SettingsRow
        title="Enable sync"
        description="Warm secure data on unlock"
        onClick={handleOpen}
        trailing={<input type="checkbox" aria-label="Enable sync switch" />}
      />,
    );

    // Row is clickable
    fireEvent.click(screen.getByRole("button", { name: /enable sync/i }));
    expect(handleOpen).toHaveBeenCalledTimes(1);

    // Switch is still accessible
    expect(screen.getByLabelText("Enable sync switch")).toBeTruthy();
  });

  it("renders a non-interactive row without creating a button wrapper", () => {
    render(
      <SettingsRow
        title="Current status"
        description="Nothing to do right now"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /current status/i }),
    ).toBeNull();
    expect(screen.getByText("Current status").textContent).toBe(
      "Current status",
    );
  });

  it("uses compact single-line geometry when a grouped menu has no subtext", () => {
    const { container } = render(
      <SettingsRow
        icon={undefined}
        title="Security"
        density="compact"
        chevron
        onClick={() => {}}
      />,
    );

    const rowShell = container.querySelector('[data-testid="settings-row"]');
    expect(rowShell?.className).toContain("[--settings-row-py:10px]");
    expect(screen.queryByTestId("settings-row-description")).toBeNull();
  });

  it("uses the calm iPhone settings list label by default", () => {
    const { container } = render(
      <SettingsRow title="Security & privacy" density="compact" />,
    );

    const title = container.querySelector('[data-slot="settings-row-title"]');
    expect(title?.className).toContain("ui-text-row-label");
    expect(title?.getAttribute("data-ui-role")).toBe("body");
    expect(title?.className).not.toContain("font-semibold");
  });

  it("protects row labels from the global title-slot typography", () => {
    const globalsCss = readFileSync(
      join(process.cwd(), "app/globals.css"),
      "utf8",
    );

    expect(globalsCss).toContain('[data-slot="settings-row-title"] {');
    expect(globalsCss).toContain(
      "font-size: var(--type-row-label-size) !important;",
    );
    expect(globalsCss).toContain(
      "font-weight: var(--type-row-label-weight) !important;",
    );
  });

  it("keeps row descriptions visually subordinate to page subtitles and body text", () => {
    const globalsCss = readFileSync(
      join(process.cwd(), "app/globals.css"),
      "utf8",
    );

    expect(globalsCss).toContain("--type-page-subtitle-size: 15px;");
    expect(globalsCss).toContain("--type-page-subtitle-line: 20px;");
    expect(globalsCss).toContain("--type-row-label-size: 17px;");
    expect(globalsCss).toContain("--type-row-label-line: 22px;");
    expect(globalsCss).toContain("--type-row-description-size: 13px;");
    expect(globalsCss).toContain("--type-row-description-line: 18px;");
    expect(globalsCss).toMatch(
      /:is\(\.ui-text-row-description\)\s*\{\s*color:\s*var\(--app-tertiary-label\)\s*!important;/,
    );
  });

  it("uses Inter as the product UI font family", () => {
    const globalsCss = readFileSync(
      join(process.cwd(), "app/globals.css"),
      "utf8",
    );

    expect(globalsCss).toContain(
      '--font-family-product: "InterVariable", "Inter", system-ui, sans-serif;',
    );
    expect(globalsCss).not.toContain(
      '--font-family-product:\n    -apple-system, BlinkMacSystemFont, "InterVariable"',
    );
  });

  it("publishes semantic icon tone while destructive actions retain red", () => {
    const { container, rerender } = render(
      <SettingsRow icon={undefined} iconTone="blue" title="Account" />,
    );

    expect(
      container.querySelector('[data-slot="settings-row-icon"]'),
    ).toBeNull();

    rerender(<SettingsRow icon={Phone} iconTone="blue" title="Account" />);
    expect(
      container
        .querySelector('[data-slot="settings-row-icon"]')
        ?.getAttribute("data-icon-tone"),
    ).toBe("blue");

    rerender(
      <SettingsRow
        icon={LogOut}
        iconTone="blue"
        title="Sign out"
        tone="destructive"
      />,
    );
    expect(
      container
        .querySelector('[data-slot="settings-row-icon"]')
        ?.getAttribute("data-icon-tone"),
    ).toBe("red");
  });

  it("uses square iOS-style icon wells, shared inset-group radius, and standard card depth", () => {
    const { container } = render(
      <SettingsGroup>
        <SettingsRow icon={Phone} title="Phone number" />
      </SettingsGroup>,
    );

    const group = container.querySelector('[data-slot="settings-group-shell"]');
    const icon = container.querySelector('[data-slot="settings-row-icon"]');

    expect(group?.className).toContain("--app-card-radius-standard");
    expect(group?.className).toContain(
      "shadow-[var(--app-card-shadow-standard)]",
    );
    expect(icon?.className).toContain("rounded-[10px]");
    expect(icon?.className).not.toContain("rounded-2xl");
  });

  it("aligns inset separators to actual leading visuals", () => {
    const { container, rerender } = render(
      <SettingsGroup separatorInset>
        <SettingsRow title="Plain row" />
        <SettingsRow title="Last row" />
      </SettingsGroup>,
    );

    expect(
      container.querySelector('[data-testid="settings-row"]')?.className,
    ).toContain("after:left-0");

    rerender(
      <SettingsGroup separatorInset>
        <SettingsRow icon={Phone} title="Icon row" />
        <SettingsRow title="Last row" />
      </SettingsGroup>,
    );

    expect(
      container.querySelector('[data-testid="settings-row"]')?.className,
    ).toContain("after:left-[62px]");
  });

  it("inherits route-family separator and density defaults", () => {
    const { container } = render(
      <SettingsPresentationProvider separatorInset density="compact">
        <SettingsGroup>
          <SettingsRow icon={Phone} title="Phone number" />
          <SettingsRow title="Sign-in provider" />
        </SettingsGroup>
      </SettingsPresentationProvider>,
    );

    const group = container.querySelector(
      '[data-slot="settings-group-shell"] > div',
    );
    const rows = container.querySelectorAll('[data-testid="settings-row"]');

    expect(group?.getAttribute("data-inset-separators")).toBe("true");
    expect(rows[0]?.className).toContain("[--settings-row-py:10px]");
    expect(
      rows[0]?.querySelector('[data-slot="settings-row-icon"]')?.className,
    ).not.toContain("sm:h-10");
  });

  it("supports asChild rows without losing row content", () => {
    render(
      <SettingsRow
        asChild
        title="Open profile"
        description="Go to privacy workspace"
      >
        <a href="/one/profile" data-testid="profile-link" />
      </SettingsRow>,
    );

    const link = screen.getByTestId("profile-link");
    expect(link.tagName).toBe("A");
    expect(link.textContent).toContain("Open profile");
    expect(link.textContent).toContain("Go to privacy workspace");
    expect(link.querySelector(".morphy-ripple-host")).not.toBeNull();
  });
});

describe("SettingsSegmentedTabs", () => {
  it("keeps the active tab selected and switches tabs through user interaction", () => {
    const handleValueChange = vi.fn();
    render(
      <SettingsSegmentedTabs
        value="my"
        onValueChange={handleValueChange}
        options={[
          { value: "kai", label: "Kai list" },
          { value: "my", label: "My list" },
        ]}
      />,
    );

    const active = screen.getByRole("button", { name: "My list" });
    const inactive = screen.getByRole("button", { name: "Kai list" });

    expect(active.getAttribute("data-state")).toBe("active");
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(inactive.getAttribute("data-state")).toBe("inactive");
    expect(inactive.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(active);
    expect(handleValueChange).not.toHaveBeenCalled();

    fireEvent.click(inactive);
    expect(handleValueChange).toHaveBeenCalledWith("kai");
  });
  it("preserves inactive segmented tab accessibility state", () => {
    render(
      <SettingsSegmentedTabs
        value="kai"
        onValueChange={() => {}}
        options={[
          { value: "kai", label: "Kai list" },
          { value: "my", label: "My list" },
        ]}
      />,
    );

    const inactive = screen.getByRole("button", { name: "My list" });

    expect(inactive.getAttribute("data-state")).toBe("inactive");
    expect(inactive.getAttribute("aria-pressed")).toBe("false");
  });

  it("disables the whole segmented control while its selection is settling", () => {
    const handleValueChange = vi.fn();
    render(
      <SettingsSegmentedTabs
        value="statement"
        onValueChange={handleValueChange}
        disabled
        options={[
          { value: "statement", label: "Statement" },
          { value: "plaid", label: "Brokerage" },
        ]}
      />,
    );

    const brokerage = screen.getByRole("button", { name: "Brokerage" });
    expect(brokerage).toBeDisabled();
    fireEvent.click(brokerage);
    expect(handleValueChange).not.toHaveBeenCalled();
  });
});

describe("SettingsDetailPanel", () => {
  it("preserves dialog accessibility semantics", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(
      <SettingsDetailPanel
        open
        onOpenChange={() => {}}
        title="Settings"
        description="Settings dialog"
      >
        <div>Content</div>
      </SettingsDetailPanel>,
    );

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Settings dialog")).toBeTruthy();
    expect(
      document
        .querySelector('[data-slot="dialog-header"]')
        ?.className.includes("bg-[var(--activeGlassColor)]"),
    ).toBe(true);
  });

  it("places supplied identity media before the detail title", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(
      <SettingsDetailPanel
        open
        onOpenChange={() => {}}
        leading={<span data-testid="detail-identity">Logo</span>}
        title="Nvidia"
        description="NVDA • Semiconductors"
      >
        <div>Content</div>
      </SettingsDetailPanel>,
    );

    const dialog = screen.getByRole("dialog", { name: "Nvidia" });
    const identity = screen.getByTestId("detail-identity");
    const title = screen.getByRole("heading", { name: "Nvidia" });

    expect(
      identity.compareDocumentPosition(title) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(dialog.textContent).toContain("NVDA • Semiconductors");
  });

  it("closes from the explicit close button", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const handleOpenChange = vi.fn();
    render(
      <SettingsDetailPanel
        open
        onOpenChange={handleOpenChange}
        title="Settings"
        description="Settings dialog"
      >
        <div>Content</div>
      </SettingsDetailPanel>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /close detail panel/i }),
    );

    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses the shared physics-enabled bottom sheet when requested", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(
      <SettingsDetailPanel
        open
        onOpenChange={() => {}}
        title="Decision"
        mobilePresentation="sheet"
        showCloseButton={false}
      >
        <div>Content</div>
      </SettingsDetailPanel>,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-slot="sheet-drag-handle"]'),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
