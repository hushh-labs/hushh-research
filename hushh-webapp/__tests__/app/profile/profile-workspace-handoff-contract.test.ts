import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("profile workspace duplication contract", () => {
  it("keeps One dashboard workspaces out of the Profile landing screen", () => {
    expect(profilePageSource).not.toContain(
      '<SettingsGroup title="Workspaces">',
    );
    expect(profilePageSource).not.toContain(
      "const openMyDataPanel = () => router.push(ROUTES.PKM);",
    );
    expect(profilePageSource).not.toMatch(
      /const\s+openAccessPanel\s*=\s*\(\)\s*=>\s*router\.push\(\s*ROUTES\.CONSENTS\s*\);/,
    );
    expect(profilePageSource).not.toMatch(
      /const\s+openGmailPanel\s*=\s*\(\)\s*=>\s*router\.push\(\s*ROUTES\.GMAIL\s*\);/,
    );
    expect(profilePageSource).toContain(
      '<SettingsGroup title="Your settings" separatorInset>',
    );
    expect(profilePageSource).not.toContain("myDataRootBadge");
    expect(profilePageSource).not.toContain("accessRootBadge");
    expect(profilePageSource).not.toContain("Data loaded partially");
    expect(profilePageSource).not.toContain("Access loaded partially");
    expect(profilePageSource).not.toContain(
      "Unlock to review sync and receipts.",
    );
    expect(profilePageSource).not.toContain("Unlock to review email requests.");
  });

  it("loads legacy workspace data only for legacy workspace panels", () => {
    expect(profilePageSource).toContain(
      "function profileRouteNeedsWorkspaceData",
    );
    expect(profilePageSource).toContain('return panel === "my-data";');
    expect(profilePageSource).toContain(
      'enabled: Boolean(user?.uid) && !authLoading && activePanel === "gmail"',
    );
  });

  it("keeps Security as the sole Profile entry for vault controls", () => {
    expect(profilePageSource).not.toContain('className="min-w-[148px]"');
    expect(profilePageSource).not.toContain('voiceControlId="profile_vault"');
    expect(profilePageSource).not.toContain("const openVaultSettingsRow");
    expect(profilePageSource).toContain('voiceControlId="profile_security"');
    expect(profilePageSource).toContain(
      'voiceActionId="route.profile_security_panel"',
    );
    expect(profilePageSource).not.toContain(
      'voiceActionId="route.profile_security"',
    );
  });
});
