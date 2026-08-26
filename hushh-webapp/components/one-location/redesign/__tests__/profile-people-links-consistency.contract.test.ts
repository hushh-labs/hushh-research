import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("Profile, Location People, and Location Links consistency contract", () => {
  it("keeps Profile destination out of the compact top breadcrumb", () => {
    const source = readSource("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("if (pathname === ROUTES.PROFILE)");
    expect(source).toContain("items: [{ label: parentLabel, href: backHref }]");
    expect(source).not.toContain(
      'items: [{ label: parentLabel, href: backHref }, { label: "Profile" }]',
    );

    const resolved = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams({ from: ROUTES.ONE_LOCATION }),
    );

    expect(resolved?.backHref).toBe(ROUTES.ONE_LOCATION);
    expect(resolved?.items).toEqual([
      { label: "Location", href: ROUTES.ONE_LOCATION },
    ]);
  });

  it("keeps Location header status copy to the approved shared states", () => {
    const source = readSource(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );

    expect(source).toContain('return "Finding location\\u2026";');
    expect(source).toContain('return "Location blocked";');
    expect(source).toContain('vm.locationEnabled ? "Location on" : "Location off"');
    expect(source).not.toContain('return "Finding you\\u2026";');
    expect(source).not.toContain("locationStatusLabel");
  });

  it("uses shared SectionLabel for People and Links section headings", () => {
    const hubSource = readSource(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );
    const circleSource = readSource(
      "components/one-location/redesign/circles/named-circle-flows.tsx",
    );

    expect(circleSource).toContain(
      '<SectionLabel as="div" role="heading" aria-level={2}>',
    );
    expect(hubSource).toContain(
      'id="one-location-connections-heading"',
    );
    expect(hubSource).toContain("Connections");
    expect(hubSource).toContain("Temporary link");
    expect(hubSource).not.toContain("Connections ·");
    expect(hubSource).not.toContain("<SectionTitle as=\"h2\">Temporary link");
  });

  it("keeps Location Links concise without duplicate active-card title or live pill copy", () => {
    const source = readSource(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );
    const cardSource = readSource(
      "components/one-location/redesign/cards.tsx",
    );

    expect(source).toContain("Active \\u00b7 ${expiresLine}");
    expect(source).toContain(
      "Anyone with this link can see your location until it expires.",
    );
    expect(source).toContain(
      "Anyone with this link can see your location.",
    );
    expect(cardSource).toContain("Revoke link");
    expect(source).not.toContain('title="Temporary link"');
    expect(source).not.toContain("Live location link");
    expect(source).not.toContain("Stops in 1h");
  });

  it("normalizes Profile utility icons to neutral rows while preserving semantic exceptions", () => {
    const source = readSource("app/profile/profile-workspace-page.tsx");

    expect(source).toContain('title={PROFILE_LABELS.referrals}');
    expect(source).toContain('iconTone="gray"');
    expect(source).toContain('title={PROFILE_LABELS.developerTools}');
    expect(source).not.toContain(
      'icon={Users}\n                iconTone="blue"',
    );
    expect(source).not.toContain(
      'icon={CodeXml}\n                  iconTone="purple"',
    );
  });

  it("keeps Profile and Location grouped surfaces on the same compact radius token", () => {
    const css = readSource("app/globals.css");
    const settingsSource = readSource("components/app-ui/settings-ui.tsx");

    expect(css).toContain("--ios-account-card-radius: 17px;");
    expect(css).toContain(
      "--settings-group-radius: var(--ios-account-card-radius);",
    );
    expect(settingsSource).toContain(
      'data-ui-role="grouped-card"',
    );
    expect(settingsSource).toContain(
      "[--settings-group-radius:var(--app-card-radius-standard,24px)]",
    );
  });
});
