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
    expect(prepared.body).toContain("My **Postal code** is **10001**.");
    expect(prepared.body).not.toContain("identity");
    expect(prepared.body).not.toContain("address · postal");
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

  it("loads one PKM segment once for every exact field it contains", async () => {
    pkmMocks.getStaleFirst.mockResolvedValue({
      data: {
        identity_profile: {
          full_name: "Akshat Kumar",
          education: {
            institution: "IIT Bombay",
            department: "Mechanical Engineering",
            programme: "Dual Degree",
          },
        },
      },
    });

    const prepared = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["name", "education information"],
        candidate_scopes: [
          {
            scope: "attr.identity.identity_profile.full_name",
            domain: "identity",
            label: "Full name",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.full_name"],
          },
          {
            scope: "attr.identity.identity_profile.education.institution",
            domain: "identity",
            label: "Educational institution",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.institution"],
          },
          {
            scope: "attr.identity.identity_profile.education.department",
            domain: "identity",
            label: "Education department",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.department"],
          },
          {
            scope: "attr.identity.identity_profile.education.programme",
            domain: "identity",
            label: "Education programme",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.programme"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(pkmMocks.getStaleFirst).toHaveBeenCalledTimes(1);
    expect(prepared.body).toContain("My name is **Akshat Kumar**.");
    expect(prepared.body).toContain(
      "I am pursuing **Dual Degree** in **Mechanical Engineering** at **IIT Bombay**.",
    );
    expect(prepared.body).not.toContain("identity_profile");
  });

  it("creates a recipient-safe, rich KYC paragraph from approved facts", async () => {
    pkmMocks.getStaleFirst.mockImplementation(({ domain }: { domain: string }) =>
      Promise.resolve(
        domain === "location"
          ? { data: { profile: { school_location: "Delhi" } } }
          : {
              data: {
                identity_profile: {
                  full_name: "Akshat Kumar",
                  education: {
                    academic_status: "5th-year Dual Degree student",
                    department: "Mechanical Engineering",
                    institution: "IIT Bombay",
                    programme: "Dual Degree",
                  },
                },
              },
            },
      ),
    );

    const prepared = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["name", "education details", "school location"],
        candidate_scopes: [
          {
            scope: "attr.identity.identity_profile.full_name",
            domain: "identity",
            label: "Full name",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.full_name"],
          },
          {
            scope: "attr.identity.identity_profile.education.academic_status",
            domain: "identity",
            label: "Academic status",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.academic_status"],
          },
          {
            scope: "attr.identity.identity_profile.education.department",
            domain: "identity",
            label: "Department",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.department"],
          },
          {
            scope: "attr.identity.identity_profile.education.institution",
            domain: "identity",
            label: "Institution",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.institution"],
          },
          {
            scope: "attr.identity.identity_profile.education.programme",
            domain: "identity",
            label: "Programme",
            segment_ids: ["identity_profile"],
            canonical_field_ids: ["identity.identity_profile.education.programme"],
          },
          {
            scope: "attr.location.profile.school_location",
            domain: "location",
            label: "School location",
            segment_ids: ["profile"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(pkmMocks.getStaleFirst).toHaveBeenCalledTimes(2);
    expect(prepared.body).toContain(
      "My name is **Akshat Kumar**. I am currently a **5th-year Dual Degree student**.",
    );
    expect(prepared.body).toContain(
      "I am pursuing **Dual Degree** in **Mechanical Engineering** at **IIT Bombay**.",
    );
    expect(prepared.body).toContain("I completed my schooling in **Delhi**.");
    expect(prepared.body).not.toContain("identity profile");
    expect(prepared.body).not.toContain("attr.");
  });

  it("uses only the approved nested address leaf and rejects a parent object", async () => {
    pkmMocks.getStaleFirst.mockResolvedValue({
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
        requested_field_labels: ["Street"],
        candidate_scopes: [
          {
            scope: "attr.identity.identity_profile.address.street",
            domain: "identity",
            label: "Street",
            segment_ids: ["identity_profile"],
          },
        ],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(prepared.body).toContain("123 Main St");
    expect(prepared.body).not.toContain("10001");
    expect(prepared.unavailableLabels).toEqual([]);

    const parent = await prepareScopedGmailInformationRequestDraft({
      workflow: {
        requested_field_labels: ["Address"],
        candidate_scopes: [{
          scope: "attr.identity.identity_profile.address",
          domain: "identity",
          label: "Address",
          segment_ids: ["identity_profile"],
        }],
      },
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });
    expect(parent.body).toBeNull();
    expect(parent.unavailableLabels).toEqual(["Address"]);
  });
});
