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
    expect(source).toContain("icon={UserRound}");
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
