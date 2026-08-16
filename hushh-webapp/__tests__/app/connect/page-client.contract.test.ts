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

  it("requires an explicit capability review for every connection request", () => {
    const source = readFileSync(
      join(process.cwd(), "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain("Connection access");
    expect(source).toContain("No access yet");
    expect(source).toContain("requestedHandles: []");
    expect(source).not.toContain(
      "if (catalog.items.length === 0 && catalog.offerableItems.length === 0)",
    );
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
