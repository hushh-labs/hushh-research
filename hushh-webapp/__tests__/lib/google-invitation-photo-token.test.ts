import { afterEach, describe, expect, it, vi } from "vitest";
import { requestGoogleInvitationPhotoGrant } from "@/lib/services/google-invitation-photo-token";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.apiFetch } }));

const subject = "a".repeat(64);
const generation = "b".repeat(64);
const input = () => ({
  idToken: "firebase-token", vaultOwnerToken: "vault-owner-token",
  ownerId: "owner", accountId: "second", accountEmail: "Owner@example.com",
  subjectSha256: subject, grantGeneration: generation, signal: new AbortController().signal,
});
const response = (body: object, ok = true) => ({ ok, json: async () => body });
afterEach(() => vi.clearAllMocks());

describe("Calendar-bound guest photo token", () => {
  it("uses both owner credentials and verifies the selected account metadata", async () => {
    mocks.apiFetch.mockResolvedValue(response({
      access_token: "contacts-only", expires_in: 1800, account_email: "owner@example.com",
      subject_sha256: subject, grant_generation: generation,
    }));
    const grant = await requestGoogleInvitationPhotoGrant(input());
    expect(grant).toMatchObject({ token: "contacts-only", accountEmail: "owner@example.com", subject, permission: "contacts" });
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/one/calendar/guest-photo-token", expect.objectContaining({
      method: "POST", cache: "no-store",
      headers: expect.objectContaining({ Authorization: "Bearer firebase-token", "X-Hushh-Consent": "vault-owner-token" }),
      body: JSON.stringify({ user_id: "owner", account_id: "second", grant_generation: generation, provider_subject_sha256: subject }),
    }));
  });

  it.each([
    { account_email: "other@example.com", subject_sha256: subject, grant_generation: generation },
    { account_email: "owner@example.com", subject_sha256: "c".repeat(64), grant_generation: generation },
    { account_email: "owner@example.com", subject_sha256: subject, grant_generation: "c".repeat(64) },
  ])("rejects a token for a different account or grant", async mismatch => {
    mocks.apiFetch.mockResolvedValue(response({ access_token: "token", expires_in: 3600, ...mismatch }));
    await expect(requestGoogleInvitationPhotoGrant(input())).rejects.toThrow(/did not match/i);
  });

  it("rejects a missing or overlong expiry and unavailable broker", async () => {
    mocks.apiFetch.mockResolvedValueOnce(response({ access_token: "token", expires_in: 0, account_email: "owner@example.com", subject_sha256: subject, grant_generation: generation }))
      .mockResolvedValueOnce(response({ access_token: "token", expires_in: 7200, account_email: "owner@example.com", subject_sha256: subject, grant_generation: generation }))
      .mockResolvedValueOnce(response({}, false));
    await expect(requestGoogleInvitationPhotoGrant(input())).rejects.toThrow(/did not match/i);
    await expect(requestGoogleInvitationPhotoGrant(input())).rejects.toThrow(/did not match/i);
    await expect(requestGoogleInvitationPhotoGrant(input())).rejects.toThrow(/unavailable/i);
  });
});
