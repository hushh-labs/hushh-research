import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Connect page layout contract", () => {
  it("uses one page title and Profile-style grouped rows", () => {
    const source = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/connect/page-client.tsx"),
      "utf8",
    );

    expect(source).toContain("<PageHeader");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).not.toContain("<SectionHeader");
    expect(source).not.toContain('eyebrow="One"');
  });

  it("keeps a connection's action beside its name, not stacked below it", () => {
    // This assertion used to require the opposite, and shipped the defect QA
    // reported as "remove neeche aa rha". `stackTrailingOnMobile` moves the
    // trailing control onto its own line below `sm:` -- which is 640px, so on
    // every iPhone -- and it was doing that for a single 72px "Remove" that had
    // room to sit inline the whole time. A connection read as two rows, and the
    // People list directly beneath it on the same screen never stacked, so the
    // two halves of Connect disagreed about their own geometry.
    //
    // Measured, not asserted from a class name:
    // `e2e/connect-circle-cta.layout.spec.ts` renders both SettingsRow
    // geometries in a real browser and confirms the stacking one really does
    // push the action below the name at 320-430px.
    const source = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/connect/page-client.tsx"),
      "utf8",
    );

    const connectionsMapStart = source.indexOf(
      "sortedConnections.map((connection) => (",
    );
    const connectionsPagerStart = source.indexOf(
      "{connectionsHasMore ?",
      connectionsMapStart,
    );
    const connectionRows = source.slice(
      connectionsMapStart,
      connectionsPagerStart,
    );
    expect(
      connectionRows,
      "the connections list still renders a SettingsRow",
    ).toContain("<SettingsRow");
    expect(connectionRows).not.toMatch(/^\s*stackTrailingOnMobile\s*$/m);
    expect(connectionRows).toContain("trailing=");
  });

  it("hard-gates Connect and the private agent on live in-memory vault state", () => {
    const connectRoute = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/one/connect/page.tsx"),
      "utf8",
    );
    const oneAuthGate = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/one/one-auth-gate.tsx"),
      "utf8",
    );
    const agentRoute = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/agent/page.tsx"),
      "utf8",
    );
    const vaultGuard = fs.readFileSync(
      path.join(WEBAPP_ROOT, "components/vault/vault-lock-guard.tsx"),
      "utf8",
    );

    expect(connectRoute).not.toContain("<VaultLockGuard>");
    expect(oneAuthGate).toContain("<VaultLockGuard>");
    expect(agentRoute).toContain("<VaultLockGuard>");
    expect(vaultGuard).not.toContain("isSessionUnlockedOnce");
    expect(vaultGuard).toContain("if (isVaultUnlocked)");
  });
});
