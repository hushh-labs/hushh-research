import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("recursive Profile pane contracts", () => {
  it("keeps the pane separate from route ownership and preserves shared overlay geometry", () => {
    const pane = read("components/app-ui/profile-pane.tsx");
    const route = read("app/profile/profile-workspace-page.tsx");
    const workspace = read("components/profile/profile-workspace-page.tsx");

    expect(pane).toContain(
      'import { ProfilePage } from "@/components/profile/profile-workspace-page"',
    );
    expect(pane).toContain("w-full max-w-none");
    expect(pane).toContain("sm:max-w-[560px]");
    expect(pane).toContain("env(safe-area-inset-top)");
    expect(pane).toContain("env(safe-area-inset-bottom)");
    expect(pane).toContain('data-profile-pane-scroll-root="true"');
    expect(pane).toContain("popProfilePaneLocation");
    expect(route).toContain("components/profile/profile-workspace-page");
    expect(route).not.toContain("PageSectionSwitcher");
    expect(workspace).toContain(
      'type ProfilePagePresentation = "route" | "pane"',
    );
    for (const label of [
      "Memory",
      "Connected Systems",
      "Gmail receipts",
      "Trusted devices",
      "Invite friends",
      "Help & feedback",
    ]) {
      expect(workspace).toContain(label);
    }
  });

  it("keeps recursive motion mounted, reduced-motion safe, and scroll-position aware", () => {
    const stack = read("components/profile/profile-stack-navigator.tsx");
    const gesture = read("components/app-ui/app-profile-edge-gesture.tsx");
    const providers = read("app/providers.tsx");

    expect(stack).toContain("scrollPositionsRef");
    expect(stack).toContain("motion-reduce:transition-none");
    expect(stack).toContain('data-profile-stack-screen={entry.key}');
    expect(gesture).toContain("BACK_GESTURE_RESERVED_WIDTH_PX = 28");
    expect(gesture).toContain('event.pointerType !== "touch"');
    expect(gesture).toContain("[data-slot=\"sheet-content\"]");
    expect(gesture).toContain('pathname === ROUTES.ONE_HOME');
    expect(providers).toContain("touch-pan-y");
    expect(providers).toContain("clearProfilePaneQuery");
  });
});
