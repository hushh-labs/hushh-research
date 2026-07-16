import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Connect page layout contract", () => {
  it("uses one page title and Profile-style grouped rows", () => {
    const source = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain('data-slot="connect-page-header"');
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).not.toContain("<PageHeader");
    expect(source).not.toContain("<SectionHeader");
    expect(source).not.toContain('eyebrow="One / Connect"');
  });
});
