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
    expect(source).toContain("icon={Sparkles}");
    expect(source).toContain("icon={UserRound}");
    expect(source).toContain("separatorInset");
  });
});
