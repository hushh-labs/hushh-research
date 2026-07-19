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
      join(process.cwd(), "app/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(source).toContain('data-profile-avatar-frame="true"');
    expect(source).toContain('data-profile-avatar-fallback="true"');
    expect(source).toContain('className="h-full w-full"');
    expect(source).toContain('className="object-cover"');
    expect(source).toContain('bg-primary/18 p-1');
    expect(source).toContain('<Icon icon={User} size={32} className="sm:size-9" />');
    expect(source).not.toContain(
      'h-14 w-14 shrink-0 ring-4 ring-primary/18 sm:h-16 sm:w-16',
    );
    expect(source).not.toContain('<Icon icon={User} size={48} />');
  });
});
