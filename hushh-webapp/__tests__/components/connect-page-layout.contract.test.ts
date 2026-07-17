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
    expect(source).toContain('eyebrow="One"');
  });

  it("hard-gates Connect and the private agent on live in-memory vault state", () => {
    const connectRoute = fs.readFileSync(
      path.join(WEBAPP_ROOT, "app/connect/page.tsx"),
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

    expect(connectRoute).toContain("<VaultLockGuard>");
    expect(agentRoute).toContain("<VaultLockGuard>");
    expect(vaultGuard).not.toContain("isSessionUnlockedOnce");
    expect(vaultGuard).toContain("if (isVaultUnlocked)");
  });
});
