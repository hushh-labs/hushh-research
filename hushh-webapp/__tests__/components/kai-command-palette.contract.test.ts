import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/kai/kai-command-palette.tsx"),
  "utf8",
);
const keyboardInsetSource = readFileSync(
  join(process.cwd(), "components/keyboard-inset-manager.tsx"),
  "utf8",
);

describe("Kai command palette contract", () => {
  it("prioritizes an explicit natural-language handoff above generated actions", () => {
    expect(source).toContain('heading="Ask One"');
    expect(source).toContain("onSelect={submitPromptSuggestion}");
    expect(source.indexOf('heading="Ask One"')).toBeLessThan(
      source.indexOf('heading="Commands"'),
    );
  });

  it("keeps command rows to one clean label without helper descriptions", () => {
    expect(source).not.toContain("const helperText");
    expect(source).not.toContain("description=\"Type a command");
  });

  it("anchors the mobile palette above the keyboard without the centered-dialog shift", () => {
    expect(source).toContain('data-keyboard-anchor="bottom"');
    expect(source).toContain(
      "bottom-[calc(var(--kb-height,0px)+var(--bottom-chrome-stack-height,0px)+0.5rem)]",
    );
    expect(source).toContain(
      "max-h-[min(calc(100dvh-var(--kb-height,0px)-var(--bottom-chrome-stack-height,0px)-1rem),34rem)]",
    );
    expect(source).toContain("max-sm:!translate-y-0");
  });

  it("does not feed fixed keyboard-anchored dialogs back into viewport scrolling", () => {
    expect(keyboardInsetSource).toContain(
      "el.closest('[data-keyboard-anchor=\"bottom\"]')",
    );
    expect(keyboardInsetSource).toContain("if (el.closest");
  });
});
