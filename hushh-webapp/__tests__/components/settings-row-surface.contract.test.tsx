import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { ComponentType } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";

/**
 * A clickable settings row is ONE interactive surface.
 *
 * Founder report: "the component where I have selected has a double box ...
 * the entire thing should be clickable and not layering inside just for the
 * title". A row with a control in its trailing slot (the "Available to
 * request" checkbox, a switch, Allow / Deny) used to render an inner <button>
 * around the title alone, padded inside the row's own padding, with its own
 * ripple and focus ring; the count, the empty space and the chevron beside it
 * did nothing. The geometry half of this contract is measured in a browser by
 * e2e/settings-row-surface.layout.spec.ts; this file holds the structure and
 * the click routing.
 */

const FOCUSABLE =
  'button,a[href],[role="button"],[tabindex]:not([tabindex="-1"])';

/** Every way the old nested structure broke the contract, or [] when it holds. */
function rowSurfaceViolations(row: HTMLElement, calls: () => number): string[] {
  const violations: string[] = [];
  const trailing = row.querySelector<HTMLElement>(
    '[data-slot="settings-row-trailing"]',
  );
  const surfaces = [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !trailing?.contains(el),
  );
  if (surfaces.length !== 1) {
    violations.push(`interactive surfaces=${surfaces.length}`);
  }
  const surface = surfaces[0];
  // Full row: either laid over the whole row, or wrapping the trailing side too.
  const spansRow =
    surface &&
    ((surface.className.includes("absolute") &&
      surface.className.includes("inset-0")) ||
      (trailing ? surface.contains(trailing) : true));
  if (!spansRow) violations.push("surface does not span the row");
  if (surface && /ring-offset/.test(surface.className)) {
    violations.push("focus ring is outset (clipped by the row)");
  }
  const title = row.querySelector<HTMLElement>(
    '[data-slot="settings-row-title"]',
  )!;
  const chevron = row.querySelector<Element>(
    '[data-slot="settings-row-chevron"]',
  );
  const count = trailing?.querySelector<HTMLElement>("[data-count]");
  for (const [where, target] of [
    ["title", title],
    ["chevron", chevron],
    ["count", count],
  ] as const) {
    if (!target) continue;
    const before = calls();
    fireEvent.click(target);
    if (calls() !== before + 1) violations.push(`${where} click missed`);
  }
  return violations;
}

function FinancialRow({
  onOpen,
  onToggle,
}: {
  onOpen: () => void;
  onToggle: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <SettingsGroup>
      <SettingsRow
        title="Financial"
        onClick={onOpen}
        chevron
        trailing={
          <span className="flex items-center gap-3">
            <span data-count>13</span>
            <input
              type="checkbox"
              aria-label="Everything in Financial"
              checked={checked}
              onChange={() => {
                onToggle();
                setChecked((value) => !value);
              }}
            />
          </span>
        }
      />
    </SettingsGroup>
  );
}

/** Frozen copy of the pre-fix split row. The negative control. */
function LegacySplitRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div data-testid="settings-row" className="relative overflow-hidden">
      <div className="relative z-10 grid px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        <button
          type="button"
          onClick={onOpen}
          className="relative min-w-0 rounded-[inherit] px-[var(--settings-row-px)] py-[var(--settings-row-py)] focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          <div data-slot="settings-row-title">Financial</div>
        </button>
        <div role="presentation">
          <div data-slot="settings-row-trailing">
            <span data-count>13</span>
            <input type="checkbox" aria-label="Everything in Financial" />
            <svg data-slot="settings-row-chevron" />
          </div>
        </div>
      </div>
    </div>
  );
}

describe("SettingsRow single interactive surface", () => {
  it("makes the whole row one surface when it holds a checkbox", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<FinancialRow onOpen={onOpen} onToggle={onToggle} />);
    const row = screen.getByTestId("settings-row");

    expect(rowSurfaceViolations(row, () => onOpen.mock.calls.length)).toEqual(
      [],
    );

    const action = row.querySelector<HTMLElement>(
      '[data-slot="settings-row-action"]',
    )!;
    // One named control, and it is the full-row overlay.
    expect(screen.getByRole("button", { name: "Financial" })).toBe(action);
    expect(action.className).toContain("focus-visible:ring-inset");
    expect(action.querySelector(".morphy-ripple-host")?.className).toContain(
      "inset-0",
    );
    // The content is announced once, through the action.
    expect(
      row.querySelector('[data-slot="settings-row-content"] > [aria-hidden="true"]'),
    ).not.toBeNull();
    expect(row.querySelector("button button")).toBeNull();

    // Empty space on the content layer is the row too.
    const before = onOpen.mock.calls.length;
    fireEvent.click(row.querySelector('[data-slot="settings-row-content"]')!);
    expect(onOpen).toHaveBeenCalledTimes(before + 1);
  });

  it("keeps the nested checkbox independent of the row action", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<FinancialRow onOpen={onOpen} onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", {
      name: "Everything in Financial",
    });

    fireEvent.click(box);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(box).toBeChecked();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens from keyboard activation of the one surface", () => {
    const onOpen = vi.fn();
    render(<FinancialRow onOpen={onOpen} onToggle={vi.fn()} />);
    // A button's Enter / Space activation is dispatched as its click.
    fireEvent.click(screen.getByRole("button", { name: "Financial" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("negative control: the old nested structure fails the same contract", () => {
    const onOpen = vi.fn();
    render(<LegacySplitRow onOpen={onOpen} />);
    const violations = rowSurfaceViolations(
      screen.getByTestId("settings-row"),
      () => onOpen.mock.calls.length,
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        "surface does not span the row",
        "focus ring is outset (clipped by the row)",
        "chevron click missed",
        "count click missed",
      ]),
    );
  });

  it("does not open for a click that only bubbled through a portal", () => {
    const onOpen = vi.fn();
    render(
      <SettingsRow
        title="Portfolio"
        onClick={onOpen}
        trailing={
          <>
            <button type="button">Menu</button>
            {createPortal(<span>Menu item</span>, document.body)}
          </>
        }
      />,
    );
    fireEvent.click(screen.getByText("Menu item"));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves an owned trailing node its presses, but not the chevron", () => {
    const onOpen = vi.fn();
    render(
      <SettingsRow
        title="Auto-approve"
        onClick={onOpen}
        chevron
        trailingInteractive
        trailing={<span data-testid="owned">Opaque toggle</span>}
      />,
    );
    fireEvent.click(screen.getByTestId("owned"));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(
      document.querySelector('[data-slot="settings-row-chevron"]')!,
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not fire a disabled row from its content", () => {
    const onOpen = vi.fn();
    render(
      <SettingsRow
        title="Locked"
        onClick={onOpen}
        disabled
        trailing={<input type="checkbox" aria-label="Locked choice" />}
      />,
    );
    fireEvent.click(screen.getByText("Locked"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("SettingsRow control detection survives production builds", () => {
  // The production build emits components as anonymous functions, so a
  // component's name is "" there. A function taken out of an array literal
  // has no inferred name, which reproduces that exactly.
  const [AnonymousSwitch, AnonymousBadge] = [
    function (props: { checked: boolean; onCheckedChange: (next: boolean) => void }) {
      return (
        <button
          type="button"
          role="switch"
          aria-checked={props.checked}
          aria-label="Sync switch"
          onClick={() => props.onCheckedChange(!props.checked)}
        />
      );
    },
    function (props: { label: string }) {
      return <span>{props.label}</span>;
    },
  ] as const;

  it("reproduces a nameless component", () => {
    expect((AnonymousSwitch as ComponentType).name).toBe("");
  });

  it("splits a row whose trailing control has no name, instead of nesting buttons", () => {
    const onOpen = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <SettingsRow
        title="Sync"
        onClick={onOpen}
        trailing={<AnonymousSwitch checked={false} onCheckedChange={onChange} />}
      />,
    );
    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Sync switch" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("negative control: a nameless display-only trailing stays one plain button", () => {
    const { container } = render(
      <SettingsRow
        title="Plan"
        onClick={vi.fn()}
        trailing={<AnonymousBadge label="Pro" />}
      />,
    );
    expect(container.querySelector('[data-slot="settings-row-action"]')).toBeNull();
    expect(screen.getByRole("button", { name: /Plan/ })).toBeTruthy();
  });
});
