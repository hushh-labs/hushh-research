/**
 * Where the shared position store gets its account.
 *
 * The store can keep a fix across a reload, but only for somebody — a
 * coordinate has to belong to an account before it can be sealed to their key.
 * That attach used to live in two places and effectively neither: the React
 * hook only ran it when a caller passed a userId and no caller did, and key
 * bootstrap needs a vault token, so it landed after the Location page had
 * already taken and failed its first capture. The restored fix was missing at
 * exactly the moment it exists to cover.
 *
 * Source-text assertions because the alternative is mounting the entire app
 * shell to observe one side effect.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("location bus account bridge", () => {
  const source = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");

  it("attaches the account for the whole app, not one screen", () => {
    expect(source).toContain("function LocationBusAccountBridge()");
    expect(source).toContain("void LocationBus.attachUser(userId ?? null);");
    expect(source).toContain("<LocationBusAccountBridge />");
  });

  it("keeps the bridge outside the route Suspense boundary", () => {
    // Inside it, a suspending navigation remounts the tree and re-attaches on
    // every route change — the same reason the onboarding sync bridge and the
    // voice glow sit out here.
    expect(source.indexOf("<LocationBusAccountBridge />")).toBeLessThan(
      source.indexOf("<Suspense"),
    );
  });

  it("attaches from auth, so signing out clears the previous account's fix", () => {
    // attachUser(null) is what wipes a held position at the account boundary.
    // Reading the id from anywhere that outlives sign-out would leave one
    // person's coordinate visible under another person's session.
    const bridge = source.slice(
      source.indexOf("function LocationBusAccountBridge()"),
      source.indexOf("function AppShellFrame("),
    );
    expect(bridge).toContain("const { userId } = useAuth();");
  });
});
