import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

    expect(source).toContain("Review connection capabilities");
    expect(source).toContain("No capabilities available yet");
    expect(source).toContain("requestedHandles: []");
    expect(source).not.toContain(
      "if (catalog.items.length === 0 && catalog.offerableItems.length === 0)",
    );
  });
});
