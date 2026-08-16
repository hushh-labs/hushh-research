import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getDirectoryPersonDescription } from "@/app/connect/directory-person-label";

describe("Connect canonical surface contract", () => {
  it("uses the shared Profile/One header and settings-row geometry", () => {
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain("<AppPageShell");
    expect(source).toContain('width="reading"');
    expect(source).toContain("<PageHeader");
    expect(source).not.toContain('eyebrow="One"');
    expect(source).not.toContain("icon={Users}\n          accent");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).not.toContain("Private configuration");
    expect(source).not.toContain("icon={Sparkles}");
    // A person is still UserRound; a verified adviser earns the verified mark
    // and the tone this design system already spends on a verified state. The
    // mark rides on the row rather than on the tab, so it still means something
    // in a search that spans both halves of the directory.
    expect(source).toContain("person.isRia ? BadgeCheck : UserRound");
    expect(source).toContain('person.isRia ? "green" : "blue"');
    expect(source).toContain("separatorInset");
  });

  it("requires an explicit capability review whenever there is anything to review", () => {
    // This test was red on main from 2026-08-15 to 2026-08-16 and nobody saw
    // it, because vitest never ran on a pull request. Two intentional changes
    // moved past it: the dialog copy was polished (0b12f55d6), and the
    // empty-catalog auto-send was added on purpose (a8091214b, "ask each
    // advisor for their own scope") so a person with nothing to offer is not
    // shown an empty consent sheet.
    //
    // The invariant those changes did NOT alter is the one worth pinning:
    // a request opens the review sheet with NOTHING pre-granted, and the
    // auto-send path is reachable ONLY when the catalog is empty on both
    // sides. Asserting the copy was what made this test stale; asserting the
    // consent shape is what makes it durable.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    // The review sheet always opens pre-granting nothing, in both directions.
    expect(source).toContain("requestedHandles: []");
    expect(source).toContain("offeredHandles: []");

    // No path may send a request without opening the sheet. The empty-catalog
    // auto-send existed briefly and was removed on purpose: it made a request
    // that carried access and a request that carried none look identical from
    // the outside. Any re-introduction -- on both lists, on one, or on a
    // truthiness test -- is a silent consent regression.
    expect(source).not.toMatch(
      /if\s*\(\s*catalog\.(items|offerableItems)[\s\S]{0,120}?\)\s*\{\s*[\s\S]{0,80}?sendConnectionRequest\(/,
    );

    // Nothing may pre-select a capability for the person being asked.
    expect(source).not.toContain("requestedHandles: catalog.items");
    expect(source).not.toContain("offeredHandles: catalog.offerableItems");
  });

  it("keeps the three-tab strip narrow enough that no tab title truncates", () => {
    // Measured, not assumed. With the strip's stock 16px option padding, three
    // tabs on a 375px screen left "Around you" 77px of the 80px it needs, and
    // it rendered as "Around yo…". Tab titles are ours, not user content, so an
    // ellipsis in one is a defect rather than graceful degradation.
    //
    // Chromium against the built stylesheet, after this override: 320/360/375/
    // 390/430/768/1280px all clean, no horizontal overflow, strip height
    // unchanged. jsdom cannot catch a regression here -- it does no layout --
    // and Playwright is not in the blocking lane, so the override itself is
    // what gets pinned. Removing it puts the ellipsis straight back.
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain(
      '"[&>button]:px-1 min-[360px]:[&>button]:px-3 sm:[&>button]:px-4.5"',
    );
    // Three tabs is the reason the padding has to give; a fourth would need the
    // measurement redone rather than this override stretched further.
    expect(source).toContain('["people", "advisors", "nearby"] as const');
  });

  it("renders a privacy-safe masked identity when duplicate names need disambiguation", () => {
    const serviceSource = readFileSync(
      join(process.cwd(), "lib/services/connections-service.ts"),
      "utf8",
    );

    expect(serviceSource).toContain("maskedPhone?: string | null");
    expect(serviceSource).toContain("maskedEmail?: string | null");
    expect(
      getDirectoryPersonDescription({
        displayName: "Abdul Zalil",
        email: null,
        maskedEmail: "a***l@example.com",
        maskedPhone: "******4455",
      }),
    ).toBe("a***l@example.com");
  });

  it("keeps email as the preferred secondary identity", () => {
    expect(
      getDirectoryPersonDescription({
        displayName: "Abdul Zalil",
        email: "abdul@example.test",
        maskedEmail: "a***l@example.test",
        maskedPhone: "******4455",
      }),
    ).toBe("abdul@example.test");
  });
});
