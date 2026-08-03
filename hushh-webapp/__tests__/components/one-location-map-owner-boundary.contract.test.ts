import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("One Location map owner boundary", () => {
  it("remounts every map entrypoint when the authenticated owner changes", () => {
    const dedicatedMapPage = source("app/one/location/map/page.tsx");
    const locationWorkspace = source("app/one/location/page.tsx");
    const ownerKey = 'key={auth.userId ?? "anonymous"}';

    expect(dedicatedMapPage).toContain(ownerKey);
    expect(locationWorkspace).toContain(ownerKey);
    expect(dedicatedMapPage).not.toMatch(/key=\{[^}]*vaultOwnerToken/);
    expect(locationWorkspace).not.toMatch(/key=\{[^}]*vaultOwnerToken/);
  });
});
