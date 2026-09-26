import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Profile canonical page layout", () => {
  it("uses the shared signed-in shell without route-local header spacing", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(source).toContain("<AppPageShell");
    expect(source).toContain('width="reading"');
    expect(source).toContain("<AppPageHeaderRegion>");
    expect(source).not.toContain("profilePageHeaderRegion");
  });

  it("keeps the profile avatar fallback inset from its visible frame", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-avatar-editor.tsx"),
      "utf8",
    );

    expect(source).toContain('data-profile-avatar-frame="true"');
    expect(source).toContain('className="h-full w-full"');
    expect(source).toContain(
      '<AvatarImage src={shownPhoto} alt={displayName || "Profile"} />',
    );
    expect(source).toContain("bg-primary/18 p-1");
    expect(source).toContain('<UserIcon className="h-8 w-8 sm:h-9 sm:w-9" />');
    expect(source).not.toContain(
      "h-14 w-14 shrink-0 ring-4 ring-primary/18 sm:h-16 sm:w-16",
    );
    expect(source).not.toContain('<UserIcon className="h-12 w-12" />');
  });
  it("uses the shared header rhythm after the pane divider", () => {
    const workspace = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(workspace).toContain('"profile-home-screen--pane"');
    expect(css).toContain(".profile-home-screen--pane {");
    expect(css).toContain(
      "padding-top: var(--page-header-section-gap);",
    );
  });

  it("keeps the account screen on the shared canvas without redundant intro copy", () => {
    const workspace = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(workspace).not.toContain(
      'description: "Mail, phone, and sign-in.",',
    );
    expect(css).toMatch(
      /\[data-profile-stack-screen="panel:account"\] \{[\s\S]*?background: transparent;/,
    );
    expect(css).not.toMatch(
      /\[data-profile-stack-screen="panel:account"\] \{[\s\S]*?background: var\(--ios-account-screen-background\);/,
    );
  });

  it("keeps Vault methods aligned with the shared Profile visual system", () => {
    const workspace = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(workspace).toContain(
      'className="profile-account-content profile-vault-methods-content"',
    );
    expect(workspace).not.toContain('description: "Unlock methods.",');
    expect(workspace).toContain('data-testid="vault-default-unlock-actions"');
    expect(workspace).toContain("VAULT_INLINE_ACTIONS_CLASS");
    expect(workspace).toContain('iconTone="blue"');
    expect(workspace).toContain('iconTone="purple"');
    expect(workspace).toContain('iconTone="orange"');
    expect(workspace).toContain('iconTone="indigo"');
    expect(workspace).not.toContain("Use device biometric");
    expect(workspace).not.toContain("Use passphrase");
    expect(workspace).toContain(
      "{readableQuickMethod(quickMethodReadyOnCurrentDevice)}",
    );
  });

  it("keeps the Profile menu on the same colored tile and type system as Account", () => {
    const workspace = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const homeMenu = workspace.slice(
      workspace.indexOf('<SettingsGroup title="Your settings"'),
      workspace.indexOf("</AppPageContentRegion>"),
    );

    for (const tone of ["blue", "purple", "green", "indigo", "orange", "red"]) {
      expect(homeMenu).toContain(`iconTone="${tone}"`);
    }
    expect(homeMenu).not.toContain('iconTone="capability"');
    expect(homeMenu).not.toContain('density="compact"');
    expect(css).toMatch(
      /\.profile-home-content \[data-slot="settings-row-title"\] \{[\s\S]*?font-size: var\(--ios-account-row-title-size\) !important;[\s\S]*?font-weight: var\(--ios-account-regular-weight\) !important;[\s\S]*?letter-spacing: var\(--ios-account-row-title-tracking\) !important;/,
    );
    expect(css).toMatch(
      /\.profile-home-content\s+\[data-slot="settings-row-icon"\]\[data-icon-tone="blue"\][\s\S]*?background: var\(--ios-account-accent\) !important;/,
    );
    expect(css).toMatch(
      /\.profile-home-content\s+\[data-slot="settings-row-icon"\]\[data-icon-tone="indigo"\][\s\S]*?background: var\(--app-indigo\) !important;/,
    );
  });
  it("keeps account identity in a compact leading-aligned header row", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'className="profile-home-hero flex w-full min-w-0 items-center gap-3 px-0 text-left"',
    );
    expect(source).toContain(
      'className="profile-home-copy flex min-w-0 flex-1 flex-col items-start justify-center gap-1"',
    );
    expect(source).not.toContain(
      "flex-col items-center gap-2 px-0 text-center sm:px-6",
    );
    expect(source).toContain(
      'className="profile-home-meta flex w-full min-w-0 items-center justify-start',
    );
    expect(source).not.toContain(
      'className="profile-home-meta inline-flex max-w-full',
    );
  });

  it("uses the Google mark only for personal Gmail and the work icon otherwise", () => {
    const source = readFileSync(
      join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
      "utf8",
    );
    const socialIcons = readFileSync(
      join(process.cwd(), "lib/morphy-ux/social-icons.tsx"),
      "utf8",
    );
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(source).toContain(
      'import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";',
    );
    expect(source).toContain("BriefcaseBusiness,");
    expect(source).toContain("shouldUseGoogleBrandMark(providerId, email)");
    expect(source).toContain(
      'return <GoogleIcon className="shrink-0" size={17} />;',
    );
    expect(source).toContain(
      '<Icon icon={BriefcaseBusiness} size="xs" className="shrink-0" />',
    );
    expect(source).toContain(
      '<ProviderIcon providerId={provider.id} email={user.email} />',
    );
    for (const brandColor of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
      expect(socialIcons).toContain(brandColor);
    }
    expect(source).not.toMatch(/icon=\{Fingerprint\}\s+iconTone="gray"/);
    expect(source).toContain('className="profile-account-inline-action"');
    expect(css).toContain(
      ".profile-home-content [data-icon-tone] {",
    );
    expect(css).toContain(
      "background: var(--app-settings-icon-surface) !important;",
    );
  });

  it("keeps Profile and Account supporting metadata below body row size", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(css).toContain("--ios-account-row-title-size: 16px;");
    expect(css).toContain("--ios-account-row-title-line: 21px;");
    expect(css).toContain("--type-page-subtitle-size: 15px;");
    expect(css).toContain("--type-page-subtitle-line: 20px;");
    expect(css).toContain("--type-row-description-size: 13px;");
    expect(css).toContain("--type-row-description-line: 18px;");
    expect(css).toContain(
      "--ios-account-row-value-size: var(--type-row-description-size);",
    );
    expect(css).toContain(
      "--ios-account-row-value-line: var(--type-row-description-line);",
    );
    expect(css).toContain(".profile-account-hero-email {");
    expect(css).toContain("font-size: var(--type-row-description-size);");
    expect(css).toContain(".profile-home-meta {");
    expect(css).toContain(
      "font-size: var(--type-row-description-size) !important;",
    );
    expect(css).toContain(".app-page-shell .profile-account-inline-action {");
    expect(css).toContain("font-size: 15px !important;");
    expect(css).not.toContain(
      '.app-page-shell .profile-account-content [data-slot="settings-row-title"],\n  .app-page-shell .profile-account-inline-action',
    );
  });
});
