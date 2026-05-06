import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    getClientConnector: vi.fn(),
    registerClientConnector: vi.fn(),
  },
}));

import {
  KYC_CONNECTOR_WRAPPING_ALG,
  OneKycClientZkService,
  type KycClientConnectorPrivateRecord,
} from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

const baseWorkflow: OneKycWorkflow = {
  workflow_id: "kyc_wf_1",
  user_id: "user_1",
  status: "waiting_on_user",
  sender_email: "broker@example.com",
  participant_emails: ["broker@example.com"],
  subject: "KYC request",
  counterparty_label: "Acme Brokerage",
  required_fields: ["full_name", "date_of_birth", "address"],
  draft_status: "ready",
};

const connector: KycClientConnectorPrivateRecord = {
  connector_key_id: "one-kyc-test",
  connector_public_key: "public-key",
  connector_private_key: "private-key",
  connector_private_key_format: "pkcs8",
  connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
  public_key_fingerprint: "fingerprint",
  created_at: "2026-05-04T00:00:00.000Z",
};

describe("OneKycClientZkService", () => {
  it("builds a deterministic local draft from decrypted scoped export values", async () => {
    const first = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
          date_of_birth: "1815-12-10",
          address: {
            line1: "1 St James Square",
            city: "London",
          },
        },
      },
    });
    const second = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
          date_of_birth: "1815-12-10",
          address: {
            line1: "1 St James Square",
            city: "London",
          },
        },
      },
    });

    expect(first).toEqual(second);
    expect(first.subject).toBe("Re: KYC request");
    expect(first.body).toContain("full name: Ada Lovelace");
    expect(first.body).toContain("date of birth: 1815-12-10");
    expect(first.missingFields).toEqual([]);
    expect(first.draftHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tracks missing fields without inventing values", async () => {
    const draft = await OneKycClientZkService.buildDraft({
      workflow: baseWorkflow,
      exportPayload: {
        identity: {
          full_name: "Ada Lovelace",
        },
      },
    });

    expect(draft.approvedValues).toEqual({ full_name: "Ada Lovelace" });
    expect(draft.missingFields).toEqual(["date_of_birth", "address"]);
    expect(draft.body).not.toContain("date of birth:");
    expect(draft.body).not.toContain("address:");
  });

  it("rejects consent exports wrapped to a different connector before decrypting", async () => {
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
            connector_key_id: "one-kyc-other",
          },
        },
      })
    ).rejects.toThrow("different client connector");
  });

  it("rejects unsupported export wrapping algorithms before decrypting", async () => {
    await expect(
      OneKycClientZkService.decryptScopedExport({
        connector,
        exportPackage: {
          encrypted_data: "",
          iv: "",
          tag: "",
          wrapped_key_bundle: {
            wrapped_export_key: "",
            wrapped_key_iv: "",
            wrapped_key_tag: "",
            sender_public_key: "",
            wrapping_alg: "RSA-OAEP",
            connector_key_id: connector.connector_key_id,
          },
        },
      })
    ).rejects.toThrow("Unsupported KYC export wrapping algorithm");
  });
});
