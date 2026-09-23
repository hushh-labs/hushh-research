import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";
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

  it("grows with the shape of the records, not with their number", () => {
    const one = manifestFor(
      connect(null, "item_fp_a", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_a", "fpa")),
    );
    const six = manifestFor(sixBanks());
    // One bank already carries every record shape; five more add rows, not paths.
    expect(six.paths.length).toBeLessThanOrEqual(one.paths.length + 40);
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
