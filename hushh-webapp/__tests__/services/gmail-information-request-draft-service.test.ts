import { beforeEach, describe, expect, it, vi } from "vitest";

const pkmMocks = vi.hoisted(() => ({ getStaleFirst: vi.fn() }));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: pkmMocks,
}));

import {
  prepareScopedGmailInformationRequestDraft,
} from "@/lib/services/gmail-information-request-draft-service";

describe("prepareScopedGmailInformationRequestDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses only the approved leaf projection when building a KYC reply", async () => {
    pkmMocks.getStaleFirst.mockResolvedValue({
      data: {
        address: {
          postal_code: "10001",
          street: "1 Private Street",
        },
        passport_number: "private-passport-number",
      },
    });

    const prepared = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["Postal code"],
        candidate_scopes: [
          {
            scope: "attr.identity.address.postal_code",
            domain: "identity",
            label: "Postal code",
            segment_ids: ["address"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(pkmMocks.getStaleFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "identity",
        segmentIds: ["address"],
        forceRefresh: true,
      }),
    );
    expect(prepared.body).toContain("Postal code · address · postal code: 10001");
    expect(prepared.body).not.toContain("1 Private Street");
    expect(prepared.body).not.toContain("private-passport-number");
  });

  it("does not access PKM for a broad or malformed KYC scope", async () => {
    await expect(
      prepareScopedGmailInformationRequestDraft({
        workflow: {
          requested_field_labels: ["Identity"],
          candidate_scopes: [
            {
              scope: "attr.identity.*",
              domain: "identity",
              label: "Identity",
              segment_ids: ["identity"],
            },
          ],
        },
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toEqual({ body: null, unavailableLabels: ["Identity"] });

    expect(pkmMocks.getStaleFirst).not.toHaveBeenCalled();
  });

  it("recognizes specific manifest labels for a human-readable KYC request", async () => {
    pkmMocks.getStaleFirst
      .mockResolvedValueOnce({ data: { profile: { full_name: "Akshat Kumar" } } })
      .mockResolvedValueOnce({
        data: { education: { institution: "IIT Bombay" } },
      });

    const prepared = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["name", "education information"],
        candidate_scopes: [
          {
            scope: "attr.identity.profile.full_name",
            domain: "identity",
            label: "Full name",
            segment_ids: ["profile"],
          },
          {
            scope: "attr.education.education.institution",
            domain: "education",
            label: "Educational institution",
            segment_ids: ["education"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(prepared.body).toContain("Akshat Kumar");
    expect(prepared.body).toContain("IIT Bombay");
    expect(prepared.unavailableLabels).toEqual([]);
  });

  it("handles deep nesting correctly", async () => {
    pkmMocks.getStaleFirst.mockResolvedValueOnce({
      data: {
        identity_profile: {
          address: {
            street: "123 Main St",
            postal_code: "10001",
          },
        },
      },
    });

    const prepared = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["Address"],
        candidate_scopes: [
          {
            scope: "attr.identity.identity_profile.address",
            domain: "identity",
            label: "Address",
            segment_ids: ["identity_profile"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(prepared.body).toContain("123 Main St");
    expect(prepared.unavailableLabels).toEqual([]);
  });
});
