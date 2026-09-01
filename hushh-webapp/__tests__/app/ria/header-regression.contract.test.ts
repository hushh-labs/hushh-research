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
    const consentCenterPage = read("components/consent/consent-center-page.tsx");

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

  it("keeps ria picks on shared surfaces with responsive table sizing", () => {
    const riaPicks = read("app/ria/picks/page.tsx");

    expect(riaPicks).toContain("SurfaceCard");
    expect(riaPicks).toContain('tableClassName="w-full min-w-[640px]"');
    expect(riaPicks).toContain('tableClassName="w-full min-w-[700px]"');
    expect(riaPicks).toContain("density=\"compact\"");
    expect(riaPicks).toContain("stickyHeader");
  });

  it("keeps RIA profile, clients, and picks on one shell measure and spacing rhythm", () => {
    const riaProfile = read("app/ria/profile/page.tsx");
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");

    expect(riaProfile).toContain("RiaPageShell");
    expect(riaClients).toContain('width="standard"');
    expect(riaPicks).toContain('width="standard"');
    expect(riaClients).not.toContain('width="expanded"');
    expect(riaPicks).not.toContain('width="expanded"');
    expect(riaClients).toContain('<AppPageHeaderRegion className="pt-2 sm:pt-3">');
    expect(riaPicks).toContain('<AppPageHeaderRegion className="pt-2 sm:pt-3">');
    expect(riaClients).toContain("<SurfaceStack");
    expect(riaClients).toContain('className="gap-8"');
    expect(riaPicks).toContain("<SurfaceStack");
    expect(riaPicks).toContain('className="gap-6"');
  });
});
