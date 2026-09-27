import { describe, expect, it } from "vitest";

import { isPrivatePkmExportScope } from "@/lib/consent/pkm-scope-policy";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { applyConnectionLink, applySnapshot, recomputeDerived } from "@/lib/kai/plaid-vault/projection";
import type { FinancialDomain, PlaidVaultSnapshot } from "@/lib/kai/plaid-vault/types";

import {
  FIRST_PLATYPUS,
  GINGHAM,
  GINGHAM_ACCOUNTS,
  HOUNDSTOOTH,
  HOUNDSTOOTH_ACCOUNTS,
  NOW,
  PLATYPUS_OAUTH,
  TARTAN,
  TARTAN_ACCOUNTS,
  firstPlatypusSnapshot,
  platypusOauthSnapshot,
  smallInstitutionSnapshot,
} from "./fixtures";

// The server's DomainManifestPayload caps (pkm routes): a manifest past either
// is a 422 and the sealed write is rolled back at Plaid.
const SERVER_EXTERNALIZABLE_CAP = 1000;
const SERVER_PATH_CAP = 10000;

const PRIVATE_TIERS = [
  "connections_v1",
  "accounts_v1",
  "holdings_v1",
  "securities_v1",
  "transactions_v1",
  "derived_v1",
  "linked_accounts",
];

function connect(
  financial: FinancialDomain | null,
  itemId: string,
  institution: { id: string; name: string },
  snapshot: PlaidVaultSnapshot,
): FinancialDomain {
  const linked = applyConnectionLink(
    financial,
    { item_id: itemId, access_token: `access-sandbox-${itemId}-secret`, institution, products: ["transactions"] },
    NOW,
  );
  return applySnapshot(linked, itemId, snapshot, NOW);
}

function manifestFor(financial: FinancialDomain) {
  return buildPersonalKnowledgeModelStructureArtifacts({ domain: "financial", domainData: financial }).manifest;
}

function sixBanks(): FinancialDomain {
  let financial = connect(null, "item_fp_a", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_a", "fpa"));
  financial = connect(financial, "item_fp_b", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_b", "fpb"));
  financial = connect(financial, "item_oauth", PLATYPUS_OAUTH, platypusOauthSnapshot("item_oauth"));
  financial = connect(financial, "item_tartan", TARTAN, smallInstitutionSnapshot("item_tartan", TARTAN.id, "tt", TARTAN_ACCOUNTS));
  financial = connect(financial, "item_hound", HOUNDSTOOTH, smallInstitutionSnapshot("item_hound", HOUNDSTOOTH.id, "hs", HOUNDSTOOTH_ACCOUNTS));
  return connect(financial, "item_ging", GINGHAM, smallInstitutionSnapshot("item_ging", GINGHAM.id, "gg", GINGHAM_ACCOUNTS));
}

describe("the sealed Plaid memory's manifest", () => {
  it("stays within the server caps with six banks linked", () => {
    const manifest = manifestFor(sixBanks());
    expect(manifest.externalizable_paths.length).toBeLessThan(SERVER_EXTERNALIZABLE_CAP);
    expect(manifest.paths.length).toBeLessThan(SERVER_PATH_CAP);
    expect(manifest.paths.every((path) => path.json_path.length <= 1024)).toBe(true);
  });

  it("declares each sealed tier as one opaque path, however many banks are linked", () => {
    const one = manifestFor(
      connect(null, "item_fp_a", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_a", "fpa")),
    );
    const six = manifestFor(sixBanks());
    for (const manifest of [one, six]) {
      const sealed = manifest.paths.filter((path) => PRIVATE_TIERS.includes(path.json_path.split(".")[0]!));
      // A real account already spends ~821 of the 1000 json_paths on statements
      // and the older Plaid copy; the sealed tiers must cost six, not hundreds.
      expect(sealed.map((path) => path.json_path).sort()).toEqual([...PRIVATE_TIERS].sort());
      expect(sealed.every((path) => path.exposure_eligibility === false)).toBe(true);
    }
    expect(six.paths.length).toBe(one.paths.length);
  });

  it("never offers a private tier, a record id or a token for sharing", () => {
    const manifest = manifestFor(sixBanks());
    for (const path of manifest.externalizable_paths) {
      expect(PRIVATE_TIERS).not.toContain(path.split(".")[0]);
    }
    const declared = manifest.paths.map((path) => path.json_path).join(" ");
    expect(declared).not.toContain("item_fp_a");
    expect(declared).not.toContain("secret");
  });
});

describe("adding the readable linked-accounts view", () => {
  it("adds one private path and changes no shareable path or top-level scope", () => {
    const current = sixBanks();
    const before = { ...current };
    delete before.linked_accounts;
    const beforeManifest = manifestFor(before);
    const afterManifest = manifestFor(recomputeDerived(before, NOW));

    // Existing grants and exports name these; they must not move.
    expect(afterManifest.externalizable_paths).toEqual(beforeManifest.externalizable_paths);
    // The server keeps a top-level scope only when the sharing policy allows it
    // and an exposure-eligible path sits under it (pkm service
    // `_build_scope_registry_entries`); `linked_accounts` has neither, so no new
    // scope handle can be minted and every existing one is unchanged.
    expect(afterManifest.top_level_scope_paths.filter((path) => path !== "linked_accounts")).toEqual(
      beforeManifest.top_level_scope_paths,
    );
    expect(afterManifest.paths.filter((path) => path.exposure_eligibility && path.json_path.startsWith("linked_accounts"))).toEqual([]);
    expect(isPrivatePkmExportScope("attr.financial.linked_accounts.*")).toBe(true);

    const added = afterManifest.paths
      .map((path) => path.json_path)
      .filter((path) => !beforeManifest.paths.some((prior) => prior.json_path === path));
    expect(added).toEqual(["linked_accounts"]);
    const view = afterManifest.paths.find((path) => path.json_path === "linked_accounts")!;
    expect(view.exposure_eligibility).toBe(false);
    // Manifest paths are plaintext on the server: no institution or account name in them.
    const declared = afterManifest.paths.map((path) => path.json_path).join(" ");
    expect(declared).not.toMatch(/tartan|platypus|checking|\u2022/i);
  });
});
