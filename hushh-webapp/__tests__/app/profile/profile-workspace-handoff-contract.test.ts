import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "app/profile/page.tsx"),
  "utf8",
);

describe("profile workspace duplication contract", () => {
  it("keeps One dashboard workspaces out of the Profile landing screen", () => {
    expect(profilePageSource).not.toContain('<SettingsGroup title="Workspaces">');
    expect(profilePageSource).not.toContain(
      "const openMyDataPanel = () => router.push(ROUTES.PKM);",
    );
    expect(profilePageSource).not.toContain(
      "const openAccessPanel = () => router.push(ROUTES.CONSENTS);",
    );
    expect(profilePageSource).not.toContain(
      "const openGmailPanel = () => router.push(ROUTES.GMAIL);",
    );
    expect(profilePageSource).toContain('<SettingsGroup title="Settings">');
    expect(profilePageSource).not.toContain("myDataRootBadge");
    expect(profilePageSource).not.toContain("accessRootBadge");
    expect(profilePageSource).not.toContain("Data loaded partially");
    expect(profilePageSource).not.toContain("Access loaded partially");
    expect(profilePageSource).not.toContain("Unlock to review sync and receipts.");
    expect(profilePageSource).not.toContain("Unlock to review email requests.");
  });

  it("loads legacy workspace data only for legacy workspace panels", () => {
    expect(profilePageSource).toContain("function profileRouteNeedsWorkspaceData");
    expect(profilePageSource).toContain(
      'return panel === "my-data" || panel === "access";',
    );
    expect(profilePageSource).toContain(
      "enabled: Boolean(user?.uid) && !authLoading && activePanel === \"gmail\"",
    );
  });
});
