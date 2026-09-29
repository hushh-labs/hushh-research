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

  describe("chat history drawer on iOS (WKWebView)", () => {
    it("spans the full viewport above the chat header and the bottom bar", () => {
      // REVERSAL (founder direction, 2026-09-28): "Extend the chat sidebar end to
      // end, and the bottom bar is behind the chat sidebar (z-index), so that it
      // looks like a proper UX." The earlier contract pinned the opposite: the
      // panel and its dim layer started under the chat header and stopped at the
      // top of the fixed bottom bar, because the drawer lived inside the chat
      // workspace's stacking context and no z-index there could rise above the
      // bar's. The drawer is now portalled to <body>, where the ladder alone
      // decides, so it is a real modal side drawer: full height, over both.
      const drawer = read("components/agent/agent-connections-drawer.tsx");
      const portal = drawer.slice(drawer.indexOf("data-agent-history-scrim") - 200);
      expect(portal).toMatch(/createPortal\(\s*<>/);
      expect(portal).toMatch(/<\/>,\s*document\.body,?\s*\)/);
      const scrim = portal.slice(0, portal.indexOf("onClick"));
      const panel = portal.slice(portal.indexOf("data-agent-history-drawer"));
      expect(scrim).toContain('"fixed inset-0"');
      expect(panel).toContain("fixed inset-y-0 left-0 z-(--z-sheet)");
      // The old geometry fails here: no edge is tied to the header or the bar.
      expect(drawer).not.toMatch(/--agent-chat-header-height/);
      expect(drawer).not.toMatch(/--app-bottom-shell-height/);
      expect(drawer).not.toMatch(/\babsolute\b/);

      // At the body, the sheet tier outranks the chrome it now covers.
      const header = read("components/agent/agent-chat-workspace.tsx").match(
        /"agent-chat-header relative z-\[(\d+)\]/,
      );
      const bar = read("components/app-ui/app-bottom-shell.tsx").match(
        /fixed inset-x-0 bottom-0 z-\[(\d+)\]/,
      );
      expect(header, "chat header z-index").not.toBeNull();
      expect(bar, "bottom bar z-index").not.toBeNull();
      expect(Number(header![1])).toBeLessThan(ladder["sheet-overlay"]);
      expect(Number(bar![1])).toBeLessThan(ladder["sheet-overlay"]);

      // Full height means the surface, not a gap, runs under the status bar and
      // home indicator: the panel pads both safe areas inside itself.
      const aside = read("components/agent/agent-history-sidebar.tsx");
      const surface = aside.slice(aside.indexOf("<aside")).match(/isMobileMode\s*\?\s*"([^"]+)"/)?.[1] ?? "";
      expect(surface).toContain("pt-[var(--app-safe-area-top-effective,0px)]");
      expect(surface).toContain("pb-[var(--app-safe-area-bottom-effective,0px)]");
    });

    it("dims and blurs the chat behind the drawer with the canonical sheet scrim", () => {
      // Founder ask (2026-09-27): the history sidebar recedes the chat exactly as a
      // sheet, dialog or modal popover does. The scrim tokens are read from
      // SheetOverlay itself, so a change to the canonical scrim moves both together
      // and a surface-specific blur or tint here fails.
      const sheet = read("components/ui/sheet.tsx");
      const overlay = sheet.slice(sheet.indexOf('data-slot="sheet-overlay"'));
      const canonical =
        overlay
          .slice(0, overlay.indexOf("/>"))
          .match(/bg-\[color:var\(--app-scrim-color\)\]|\[(?:-webkit-)?backdrop-filter:var\(--app-scrim-filter\)\]/g) ??
        [];
      expect(canonical).toHaveLength(3);

      const drawer = read("components/agent/agent-connections-drawer.tsx");
      const scrim = drawer.slice(drawer.indexOf("data-agent-history-scrim"));
      const scrimClasses = scrim.slice(0, scrim.indexOf("onClick"));
      for (const token of canonical) expect(scrimClasses).toContain(token);
      expect(scrimClasses).toContain("z-(--z-sheet-overlay)");
      expect(scrimClasses).not.toMatch(/bg-transparent|bg-black\/|backdrop-blur-|blur\(\d/);
      // Charter: fade opacity only (never the blur radius or `all`), honour reduced
      // motion, and hide the layer when closed so no backdrop filter stays live.
      expect(scrimClasses).toContain("transition-[opacity,visibility]");
      expect(scrimClasses).not.toMatch(/transition-(all|\[[^\]]*filter)/);
      expect(scrimClasses).toContain("motion-reduce:transition-none");
      expect(scrimClasses).toMatch(/pointer-events-none invisible opacity-0/);
    });

    it("keeps the drawer surface opaque inside its transformed sheet layer", () => {
      // WebKit takes the transformed drawer panel as the backdrop root, so a
      // translucent glass surface blurs nothing there: the chat showed through
      // the drawer on iOS while Chromium's blur hid it on web.
      const source = read("components/agent/agent-history-sidebar.tsx");
      const aside = source.slice(source.indexOf("<aside"));
      const mobileSurface = aside.match(/isMobileMode\s*\?\s*"([^"]+)"/)?.[1] ?? "";
      // The chat-scoped sidebar token (2026-09-29) replaced bg-background; it
      // must stay a solid colour in both themes for the same WebKit reason.
      expect(mobileSurface).toMatch(/(^|\s)bg-\[color:var\(--one-chat-sidebar\)\](\s|$)/);
      expect(mobileSurface).not.toMatch(/bg-background\/\d+|backdrop-blur|chrome-glass-surface/);
      const sidebarTokens = [
        ...read("app/globals.css").matchAll(/--one-chat-sidebar:\s*([^;]+);/g),
      ].map((match) => match[1].trim());
      expect(sidebarTokens.length).toBeGreaterThanOrEqual(2);
      for (const value of sidebarTokens) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    });
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
