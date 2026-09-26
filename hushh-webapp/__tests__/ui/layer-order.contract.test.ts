import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The layer ladder contract.
 *
 * Floating primitives portal to <body>, so nothing but z-index decides
 * whether a menu opened inside a sheet is visible. When dialogs were lifted
 * above sheets the transient tier (menus, popovers, selects, tooltips) was
 * left at its shadcn defaults, and every dropdown inside the profile pane
 * rendered behind the pane: the theme menu and the Molten Gold picker were
 * still there, just unreachable.
 *
 * This test pins two things: the numeric order of the tokens declared in
 * app/globals.css, and which token each primitive consumes. A shadcn
 * regeneration that reintroduces a literal `z-50` fails here, not on a phone.
 */

const webRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(webRoot, relativePath), "utf8");

function readLadder(): Record<string, number> {
  const css = read("app/globals.css");
  const ladder: Record<string, number> = {};
  for (const match of css.matchAll(/--z-([a-z-]+):\s*(\d+);/g)) {
    ladder[match[1]] = Number(match[2]);
  }
  return ladder;
}

const CONSUMERS: ReadonlyArray<{
  file: string;
  tokens: readonly string[];
  forbidden: readonly RegExp[];
}> = [
  {
    file: "components/ui/sheet.tsx",
    tokens: ["z-(--z-sheet-overlay)", "z-(--z-sheet)"],
    forbidden: [/z-\[71[12]\]/],
  },
  {
    file: "components/ui/drawer.tsx",
    tokens: ["z-(--z-sheet-overlay)", "z-(--z-sheet)"],
    forbidden: [/z-\[71[12]\]/],
  },
  {
    file: "components/agent/agent-connections-drawer.tsx",
    tokens: ["z-(--z-sheet-overlay)", "z-(--z-sheet)"],
    forbidden: [/z-\[52[03]\]/],
  },
  {
    file: "components/ui/dialog.tsx",
    tokens: ["z-(--z-dialog-overlay)", "z-(--z-dialog)"],
    forbidden: [/z-\[80[01]\]/],
  },
  {
    file: "components/ui/alert-dialog.tsx",
    tokens: ["z-(--z-dialog-overlay)", "z-(--z-dialog)"],
    forbidden: [/z-\[80[01]\]/],
  },
  {
    file: "components/ui/dropdown-menu.tsx",
    tokens: ["z-(--z-transient)"],
    forbidden: [/\bz-50\b/, /z-\[\d+\]/],
  },
  {
    file: "components/ui/popover.tsx",
    tokens: ["z-(--z-transient-scrim)", "z-(--z-transient)"],
    forbidden: [/\bz-50\b/, /z-\[\d+\]/],
  },
  {
    file: "components/ui/select.tsx",
    tokens: ["z-(--z-transient)"],
    forbidden: [/\bz-50\b/, /z-\[\d+\]/],
  },
  {
    file: "components/ui/combobox.tsx",
    tokens: ["z-(--z-transient)"],
    forbidden: [/isolate z-50\b/, /z-\[\d+\]/],
  },
  {
    file: "components/ui/tooltip.tsx",
    tokens: ["z-(--z-transient)"],
    forbidden: [/\bz-50 w-fit\b/],
  },
];

describe("layer ladder", () => {
  const ladder = readLadder();

  it("declares every tier once in app/globals.css", () => {
    for (const token of [
      "chrome",
      "sheet-overlay",
      "sheet",
      "dialog-overlay",
      "dialog",
      "takeover",
      "system",
      "transient-scrim",
      "transient",
    ]) {
      expect(ladder[token], `--z-${token}`).toBeTypeOf("number");
    }
  });

  it("orders chrome < sheet < dialog < takeover < system < transient", () => {
    expect(ladder.chrome).toBeLessThan(ladder["sheet-overlay"]);
    expect(ladder["sheet-overlay"]).toBeLessThan(ladder.sheet);
    expect(ladder.sheet).toBeLessThan(ladder["dialog-overlay"]);
    expect(ladder["dialog-overlay"]).toBeLessThan(ladder.dialog);
    expect(ladder.dialog).toBeLessThan(ladder.takeover);
    expect(ladder.takeover).toBeLessThan(ladder.system);
    expect(ladder.system).toBeLessThan(ladder["transient-scrim"]);
    expect(ladder["transient-scrim"]).toBeLessThan(ladder.transient);
  });

  it("keeps the transient tier above every container a menu can open from", () => {
    // The highest literal container tier in the tree today is the Location
    // onboarding interaction surface (10020/10021). A menu opened from any
    // container must still float above it.
    const highestKnownContainer = 10021;
    expect(ladder.transient).toBeGreaterThan(highestKnownContainer);
  });

  it.each(CONSUMERS)("$file consumes its ladder token", ({ file, tokens, forbidden }) => {
    const source = read(file);
    for (const token of tokens) {
      expect(source, `${file} should use ${token}`).toContain(token);
    }
    for (const pattern of forbidden) {
      expect(source, `${file} must not carry a literal z-index (${pattern})`).not.toMatch(
        pattern,
      );
    }
  });
});
