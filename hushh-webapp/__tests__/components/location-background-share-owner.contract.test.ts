import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("native background location sharing has one owner", () => {
  it("is driven only by LocationPublisherBridge", () => {
    // The bridge is mounted once (AgentOwnerGate) and survives navigation.
    const bridge = read("components/location/location-publisher-bridge.tsx");
    expect(bridge).toContain("syncBackgroundShare(");
    expect(bridge).toContain("buildBackgroundShareSession(");
  });

  it("is never started or stopped by the Location page", () => {
    // The page ran a second start/stop effect whose enable flag sits behind a
    // hidden toggle, so it only ever stopped -- killing the bridge's live iOS
    // session on every visit and on leaving the page.
    const page = read("app/one/location/page.tsx");
    expect(page).not.toContain("syncBackgroundShare(");
    expect(page).not.toContain("stopBackgroundShare(");
    expect(page).not.toContain("startBackgroundShare(");
  });
});
