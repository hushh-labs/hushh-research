import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Profile canonical page layout", () => {
  it("uses the shared signed-in shell without route-local header spacing", () => {
    const source = readFileSync(
      join(process.cwd(), "app/profile/profile-workspace-page.tsx"),
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
  it("keeps account identity in a compact leading-aligned header row", () => {
    const source = readFileSync(
      join(process.cwd(), "app/profile/profile-workspace-page.tsx"),
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
