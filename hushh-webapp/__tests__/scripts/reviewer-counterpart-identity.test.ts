import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveReviewerCounterpartIdentity,
  resolveReviewerTestIdentity,
} from "../../scripts/testing/reviewer-test-identity.mjs";

const COUNTERPART_KEYS = [
  "REVIEWER_COUNTERPART_UID",
  "REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
] as const;

describe("reviewer counterpart identity resolver", () => {
  let fixtureRoot = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "hushh-reviewer-counterpart-"));
    for (const key of COUNTERPART_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    for (const key of COUNTERPART_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("resolves the counterpart pair from an env file", () => {
    const envFile = path.join(fixtureRoot, ".env.local");
    writeFileSync(
      envFile,
      [
        "REVIEWER_UID=primary_uid_123",
        "REVIEWER_VAULT_PASSPHRASE=primary-passphrase",
        'REVIEWER_COUNTERPART_UID="counterpart_uid_456"',
        "REVIEWER_COUNTERPART_VAULT_PASSPHRASE='counterpart-passphrase'",
        "",
      ].join("\n"),
    );

    const identity = resolveReviewerCounterpartIdentity({ envFiles: [envFile] });

    expect(identity).toEqual({
      reviewerUid: "counterpart_uid_456",
      reviewerVaultPassphrase: "counterpart-passphrase",
      uidSourceKey: "REVIEWER_COUNTERPART_UID",
      passphraseSourceKey: "REVIEWER_COUNTERPART_VAULT_PASSPHRASE",
    });

    const primary = resolveReviewerTestIdentity({ envFiles: [envFile] });
    expect(primary.reviewerUid).toBe("primary_uid_123");
    expect(primary.reviewerUid).not.toBe(identity?.reviewerUid);
  });

  it("returns null when the counterpart pair is absent", () => {
    const envFile = path.join(fixtureRoot, ".env.local");
    writeFileSync(
      envFile,
      ["REVIEWER_UID=primary_uid_123", "REVIEWER_VAULT_PASSPHRASE=primary-passphrase", ""].join(
        "\n",
      ),
    );

    expect(resolveReviewerCounterpartIdentity({ envFiles: [envFile] })).toBeNull();
    expect(
      resolveReviewerCounterpartIdentity({
        envFiles: [path.join(fixtureRoot, "missing.env")],
      }),
    ).toBeNull();
  });

  it("returns null when only one half is configured and ignores placeholders", () => {
    const envFile = path.join(fixtureRoot, ".env.local");
    writeFileSync(
      envFile,
      [
        "REVIEWER_COUNTERPART_UID=counterpart_uid_456",
        "REVIEWER_COUNTERPART_VAULT_PASSPHRASE=replace_with_counterpart_passphrase",
        "",
      ].join("\n"),
    );

    expect(resolveReviewerCounterpartIdentity({ envFiles: [envFile] })).toBeNull();
  });

  it("does not honour the primary aliases for the counterpart", () => {
    const envFile = path.join(fixtureRoot, ".env.local");
    writeFileSync(
      envFile,
      ["UAT_SMOKE_USER_ID=legacy_uid", "UAT_SMOKE_PASSPHRASE=legacy-passphrase", ""].join("\n"),
    );

    expect(resolveReviewerCounterpartIdentity({ envFiles: [envFile] })).toBeNull();
  });

  it("throws only when required is set", () => {
    expect(() =>
      resolveReviewerCounterpartIdentity({ envFiles: [], required: true }),
    ).toThrow(/REVIEWER_COUNTERPART_UID/);
  });

  it("prefers process.env over the env file, like the primary resolver", () => {
    const envFile = path.join(fixtureRoot, ".env.local");
    writeFileSync(
      envFile,
      [
        "REVIEWER_COUNTERPART_UID=file_uid",
        "REVIEWER_COUNTERPART_VAULT_PASSPHRASE=file-passphrase",
        "",
      ].join("\n"),
    );
    process.env.REVIEWER_COUNTERPART_UID = "env_uid";
    process.env.REVIEWER_COUNTERPART_VAULT_PASSPHRASE = "env-passphrase";

    const identity = resolveReviewerCounterpartIdentity({ envFiles: [envFile] });
    expect(identity?.reviewerUid).toBe("env_uid");
    expect(identity?.reviewerVaultPassphrase).toBe("env-passphrase");
  });
});
