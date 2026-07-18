import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Location setup route contract", () => {
  it("keeps the authored Location onboarding experience available during setup", () => {
    const adapter = read(
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    );

    // The setup adapter owns the terminal Finish/Skip action, but must not
    // suppress the feature's first-run Location journey before permission can
    // be granted and readiness can settle.
    expect(adapter).toContain("<OneLocationAgentPage");
    expect(adapter).not.toContain("vaultPrerequisiteRouteKey");
    expect(adapter).not.toContain("suppressFirstRunOnboarding");
  });
});
