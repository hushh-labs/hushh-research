import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

/**
 * On and Off must never look alike: knob right on a green track when on,
 * knob left on the grey track when off, at every size and in both themes.
 * The geometry itself is measured in a browser by
 * e2e/location-switch.layout.spec.ts; this file pins the state, the ARIA and
 * the classes that carry it.
 */

const require = createRequire(import.meta.url);
const postcss = require("postcss");

const KNOB_TRAVEL = {
  sm: "translate-x-3",
  default: "translate-x-4",
  ios: "translate-x-5",
} as const;

const knob = (control: HTMLElement) =>
  control.querySelector<HTMLElement>('[data-slot="switch-thumb"]');

afterEach(cleanup);

describe("Switch", () => {
  for (const size of ["sm", "default", "ios"] as const) {
    it(`shows On and Off as different states at size ${size}`, () => {
      render(
        <>
          <Switch size={size} aria-label="On" checked onCheckedChange={() => {}} />
          <Switch size={size} aria-label="Off" checked={false} onCheckedChange={() => {}} />
        </>,
      );
      const on = screen.getByRole("switch", { name: "On" });
      const off = screen.getByRole("switch", { name: "Off" });

      expect(on).toHaveAttribute("aria-checked", "true");
      expect(on).toHaveAttribute("data-state", "checked");
      expect(knob(on)).toHaveAttribute("data-state", "checked");
      expect(off).toHaveAttribute("aria-checked", "false");
      expect(off).toHaveAttribute("data-state", "unchecked");
      expect(knob(off)).toHaveAttribute("data-state", "unchecked");

      for (const control of [on, off]) {
        expect(control).toHaveAttribute("data-size", size);
        expect(control).toHaveClass(
          "data-[state=checked]:bg-[var(--switch-on)]",
          "data-[state=unchecked]:bg-[var(--switch-off)]",
        );
        expect(knob(control)).toHaveClass(
          `group-data-[size=${size}]/switch:data-[state=checked]:${KNOB_TRAVEL[size]}`,
          "data-[state=unchecked]:translate-x-0",
        );
      }
    });
  }

  it("moves between On and Off when tapped", () => {
    render(<Switch size="ios" aria-label="Background Drive access" />);
    const control = screen.getByRole("switch", { name: "Background Drive access" });
    expect(control).toHaveAttribute("aria-checked", "false");

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("data-state", "checked");
    expect(knob(control)).toHaveAttribute("data-state", "checked");

    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(knob(control)).toHaveAttribute("data-state", "unchecked");
  });

  it("gives the On and Off tracks different colours in light and dark", () => {
    const css = postcss.parse(
      readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8"),
    );
    const themes: Record<string, Record<string, string>> = {};
    css.walkDecls(/^--switch-(on|off|thumb)$/, (decl: { prop: string; value: string; parent: { selector?: string } }) => {
      const theme = decl.parent.selector ?? "";
      themes[theme] = { ...themes[theme], [decl.prop]: decl.value.trim() };
    });

    expect(Object.keys(themes).sort()).toEqual([".dark", ":root"]);
    for (const [theme, colours] of Object.entries(themes)) {
      expect(colours, theme).toEqual({
        "--switch-on": expect.any(String),
        "--switch-off": expect.any(String),
        "--switch-thumb": expect.any(String),
      });
      expect(colours["--switch-on"], theme).not.toBe(colours["--switch-off"]);
    }
  });
});
