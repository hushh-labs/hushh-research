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
    const riaClients = read("app/ria/clients/page.tsx");
    const riaPicks = read("app/ria/picks/page.tsx");

    expect(riaHome).toContain("RiaPageShell");
    expect(riaClients).toContain("PageHeader");
    expect(riaPicks).toContain("PageHeader");
    expect(riaPicks).toContain("SettingsSegmentedTabs");
    expect(riaPicks).toContain("showMyListActionRail");
  });

  it("keeps the consent workspace on the shared page header", () => {
    const consentCenterView = read("components/consent/consent-center-view.tsx");

    expect(consentCenterView).toContain("PageHeader");
    expect(consentCenterView).toContain("AppPageHeaderRegion");
  });

  it("keeps ria picks on shared surfaces with responsive table sizing", () => {
    const riaPicks = read("app/ria/picks/page.tsx");

    expect(riaPicks).toContain("SurfaceCard");
    expect(riaPicks).toContain('tableClassName="w-full min-w-[640px]"');
    expect(riaPicks).toContain('tableClassName="w-full min-w-[700px]"');
    expect(riaPicks).toContain("density=\"compact\"");
    expect(riaPicks).toContain("stickyHeader");
  });
});
