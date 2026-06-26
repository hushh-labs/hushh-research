import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("NativeTestBootstrap", () => {
  it("keeps bootstrap state updates monotonic", () => {
    const source = read("components/app-ui/native-test-bootstrap.tsx");

    expect(source).toContain("const stageRank: Record<string, number> = {");
    expect(source).toContain("waiting_auth: 10");
    expect(source).toContain("authenticating: 20");
    expect(source).toContain("authenticated: 30");
    expect(source).toContain("loading_vault_state: 40");
    expect(source).toContain("unlocking_vault: 50");
    expect(source).toContain("vault_unlocked: 60");
    expect(source).toContain("auth_error: 70");
    expect(source).toContain("uid_mismatch: 70");
    expect(source).toContain("vault_error: 70");
    expect(source).toContain(
      'const currentRank = stageRank[bridge.bootstrapState || ""] ?? 0;',
    );
    expect(source).toContain("const nextRank = stageRank[stage] ?? 0;");
    expect(source).toContain("if (nextRank < currentRank)");
  });
});
