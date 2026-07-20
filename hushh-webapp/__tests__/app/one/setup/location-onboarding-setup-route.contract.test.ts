import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Location setup route contract", () => {
  it("runs the authored Location journey in explicit setup mode", () => {
    const adapter = read(
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    );

    // Setup owns settlement while the shared Location surface owns permission
    // adapters and the canonical introduction. It must not fall through to the
    // normal workspace or reuse that workspace's persisted first-run flag.
    expect(adapter).toContain("<OneLocationAgentPage");
    expect(adapter).toContain('mode="setup"');
    expect(adapter).toContain("await coordinator.finish()");
    expect(adapter).toContain("await coordinator.skip()");
    expect(adapter).not.toContain("vaultPrerequisiteRouteKey");
    expect(adapter).not.toContain("<SetupCapabilityTerminalFooter");
  });
});
