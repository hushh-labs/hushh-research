import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/kai/kai-command-palette.tsx"),
  "utf8",
);
const globalsSource = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const keyboardInsetSource = readFileSync(
  join(process.cwd(), "components/keyboard-inset-manager.tsx"),
  "utf8",
);

describe("Kai command palette contract", () => {
  it("prioritizes an explicit natural-language handoff above generated actions", () => {
    expect(source).toContain('heading: "Ask One"');
    expect(source).toContain("run: askOne");
    expect(source.indexOf('heading: "Ask One"')).toBeLessThan(
      source.indexOf('heading: "Commands"'),
    );
  });

  it("keeps command rows to one clean label without helper descriptions", () => {
    expect(source).not.toContain("const helperText");
    expect(source).not.toContain("description=\"Type a command");
  });

  it("anchors the mobile palette above the keyboard without the centered-dialog shift", () => {
    // Phones get their own bottom-anchored dialog; the desktop command dialog
    // never renders below the mobile breakpoint, so it carries no phone styles.
    expect(source).toContain('data-keyboard-anchor="bottom"');
    expect(source).toContain(
      "!bottom-[calc(var(--kb-height,0px)+var(--palette-chrome-clearance,var(--bottom-chrome-stack-height,0px))+0.5rem)]",
    );
    expect(source).toContain("!top-auto");
    expect(source).toContain("!translate-y-0");
    expect(source).not.toContain("max-sm:");
  });

  it("stops reserving the tab bar's height while a keyboard covers or hides it", () => {
    // The palette floated ~160 dp above the keyboard with its top under the
    // status bar (Galaxy S24 Ultra, 2026-09-22).
    expect(globalsSource).toMatch(
      /html\.kb-open \[data-keyboard-anchor="bottom"\]\[data-search-surface\] \{\s*--palette-chrome-clearance: 0px;/,
    );
  });

  it("does not feed fixed keyboard-anchored dialogs back into viewport scrolling", () => {
    expect(keyboardInsetSource).toContain(
      "element.closest('[data-keyboard-anchor=\"bottom\"]')",
    );
    expect(keyboardInsetSource).toContain("if (element.closest");
  });
});
