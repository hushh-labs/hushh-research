import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("RIA shared header regression contract", () => {
  it("keeps the main RIA routes on shared header primitives", () => {
    const riaHome = read("app/ria/page.tsx");
    const riaProfile = read("app/ria/profile/page.tsx");
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");

    // `/ria` deliberately remains a thin compatibility redirect. The canonical
    // Profile tab owns the shared RIA shell and header contract.
    expect(riaHome).toContain("ClientRedirect");
    expect(riaHome).toContain("ROUTES.RIA_PROFILE");
    expect(riaProfile).toContain("RiaPageShell");
    expect(riaClients).toContain("PageHeader");
    expect(riaPicks).toContain("PageHeader");
    expect(riaPicks).toContain("SegmentedTabs");
    expect(riaPicks).toContain("showMyListActionRail");
  });

  it("keeps the consent workspace on the shared page header", () => {
    const consentCenterPage = read(
      "components/consent/consent-center-page.tsx",
    );

    expect(consentCenterPage).toContain("AppPageShell");
    expect(consentCenterPage).toContain("SettingsDetailPanel");
    expect(consentCenterPage).toContain("isConnectionRequestEntry");
  });

  it("keeps the RIA shell on the shared Foundation header and accent tokens", () => {
    const riaShell = read("components/ria/ria-page-shell.tsx");
    const globals = read("app/globals.css");

    expect(riaShell).toContain("<PageHeader");
    expect(riaShell).toContain('accent="ria"');
    expect(globals).toContain("--ria-gold: var(--app-accent)");
    expect(globals).toContain("--ria-selected-tint: var(--app-accent-surface)");
  });

  it('gives RiaPageShell an "agent"-width default, not the wider "standard"', () => {
    // The one place this now needs to be right: every caller that does not
    // pass its own `width` -- Profile, the client account/request detail
    // pages, RiaClientWorkspace, and the Marketplace RIA public profile --
    // inherits this. A future edit widening the default silently widens all
    // of them at once, which is exactly how this shipped too wide the first
    // time.
    const riaShell = read("components/ria/ria-page-shell.tsx");

    expect(riaShell).toMatch(/\bwidth\s*=\s*["']agent["']/);
    expect(riaShell).not.toMatch(/\bwidth\s*=\s*["']standard["']/);
  });

  it("keeps ria picks on shared surfaces with responsive table sizing", () => {
    const riaPicks = read("app/ria/picks/page.tsx");

    expect(riaPicks).toContain("SurfaceCard");
    expect(riaPicks).toContain('tableClassName="w-full min-w-[640px]"');
    expect(riaPicks).toContain('tableClassName="w-full min-w-[700px]"');
    expect(riaPicks).toContain('density="compact"');
    expect(riaPicks).toContain("stickyHeader");
  });

  it("keeps RIA profile, clients, and picks on one shell measure and spacing rhythm", () => {
    const riaProfile = read("app/ria/profile/page.tsx");
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");

    // "agent" (880px), not "standard" (1440px) -- Connect and Marketplace are
    // directory-browsing surfaces at that wider measure; RIA is a workspace,
    // closer in shape to Location's primary surface. See ria-page-shell.tsx.
    expect(riaProfile).toContain("RiaPageShell");
    expect(riaClients).toContain('width="agent"');
    expect(riaPicks).toContain('width="agent"');
    expect(riaClients).not.toContain('width="standard"');
    expect(riaPicks).not.toContain('width="standard"');
    expect(riaClients).not.toContain('width="expanded"');
    expect(riaPicks).not.toContain('width="expanded"');
    expect(riaClients).toContain(
      '<AppPageHeaderRegion className="pt-2 sm:pt-3">',
    );
    expect(riaPicks).toContain(
      '<AppPageHeaderRegion className="pt-2 sm:pt-3">',
    );
    expect(riaClients).toContain("<SurfaceStack");
    expect(riaClients).toContain('className="gap-8"');
    expect(riaPicks).toContain("<SurfaceStack");
    expect(riaPicks).toContain('className="gap-6"');
  });

  it("renders the shared RIA route selector after each primary page header", () => {
    const riaProfile = read("app/ria/profile/page.tsx");
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");
    const riaShell = read("components/ria/ria-page-shell.tsx");
    const topShellTabs = read("lib/navigation/top-shell-tabs.ts");
    const providers = read("app/providers.tsx");

    for (const source of [riaProfile, riaClients, riaPicks]) {
      expect(source).toContain("RiaRouteSelector");
    }
    expect(
      riaShell.indexOf("<AppPageHeaderRegion") <
        riaShell.indexOf("<AppPageContentRegion"),
    ).toBe(true);
    expect(
      riaClients.indexOf("<PageHeader") <
        riaClients.indexOf("<RiaRouteSelector"),
    ).toBe(true);
    expect(
      riaPicks.indexOf("<PageHeader") < riaPicks.indexOf("<RiaRouteSelector"),
    ).toBe(true);

    expect(topShellTabs).toContain("export function resolveRiaRouteTabSet");
    expect(providers).toContain("resolveRiaRouteTabSet(");
  });

  it("keeps the primary RIA headers clean across Profile, Clients, and Picks", () => {
    const riaProfile = read("app/ria/profile/page.tsx");
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");
    const riaShell = read("components/ria/ria-page-shell.tsx");

    expect(riaShell).toContain("icon?: LucideIcon | null");

    expect(riaProfile).toContain('title="Profile"');
    expect(riaProfile).toContain(
      'description="Manage your advisor profile and verification details."',
    );
    expect(riaProfile).toContain("icon={null}");
    expect(riaProfile).not.toContain('eyebrow="RIA"');

    expect(riaClients).toContain("title={RIA_COPY.clients.title}");
    expect(riaClients).toContain("description={RIA_COPY.clients.description}");
    expect(riaClients).not.toContain("eyebrow={RIA_COPY.clients.eyebrow}");
    expect(riaClients).not.toContain("icon={UserRound}");
    expect(riaClients).not.toContain(
      '<Badge variant="secondary" className="text-[10px]">',
    );

    expect(riaPicks).toContain("title={RIA_COPY.picks.title}");
    expect(riaPicks).toContain("description={RIA_COPY.picks.description}");
    expect(riaPicks).not.toContain("eyebrow={RIA_COPY.picks.eyebrow}");
    expect(riaPicks).not.toContain("icon={FileSpreadsheet}");
  });
});
