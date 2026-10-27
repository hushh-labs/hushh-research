import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { requestGoogleInvitationPhotoGrant } from "@/lib/services/google-invitation-photo-token";

const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
const DIRECTORY = "https://www.googleapis.com/auth/directory.readonly";
const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const SUBJECT_HASH = createHash("sha256").update("google-subject").digest("hex");
type TokenResponse = { access_token?: string; error?: string; scope?: string; expires_in?: number };
type Config = { client_id: string; scope: string; include_granted_scopes: boolean; callback: (value: TokenResponse) => void; error_callback: (value: { type?: string }) => void };
const originalFetch = globalThis.fetch;

describe("selected Calendar account binding for Google guest photos", () => {
  let config: Config;
  let requestAccessToken: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID", "contacts-only.apps.googleusercontent.com");
    requestAccessToken = vi.fn();
    (globalThis as Record<string, unknown>).google = { accounts: { oauth2: { initTokenClient: (value: Config) => { config = value; return { requestAccessToken }; } } } };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ email: "owner@example.com", email_verified: true, sub: "google-subject", hd: "example.com" }) })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "google");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([["contacts", CONTACTS], ["directory", DIRECTORY]] as const)("requests only the chosen %s read scope and verified email", async (mode, scope) => {
    const pending = requestGoogleInvitationPhotoGrant("OWNER@example.com", SUBJECT_HASH, mode === "directory" ? "example.com" : null, mode, new AbortController().signal);
    expect(config.scope).toBe(`${scope} ${EMAIL}`);
    expect(config.include_granted_scopes).toBe(false);
    expect(requestAccessToken).toHaveBeenCalledWith({ prompt: "select_account" });
    config.callback({ access_token: "scoped-token", scope: `${scope} ${EMAIL}`, expires_in: 3600 });
    const result = await pending;
    expect(result).toMatchObject({ token: "scoped-token", accountEmail: "owner@example.com", subject: "google-subject", permission: mode });
    expect(globalThis.fetch).toHaveBeenCalledWith("https://openidconnect.googleapis.com/v1/userinfo", expect.objectContaining({ headers: { Authorization: "Bearer scoped-token" }, cache: "no-store" }));
  });

  it("rejects a valid Google token for another connected account", async () => {
    const pending = requestGoogleInvitationPhotoGrant("other@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.callback({ access_token: "wrong-account", scope: `${CONTACTS} ${EMAIL}` });
    await expect(pending).rejects.toThrow(/Choose other@example.com/i);
  });

  it("rejects the same email from a different Google subject", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ email: "owner@example.com", email_verified: true, sub: "different-subject" }) })) as unknown as typeof fetch;
    const pending = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.callback({ access_token: "wrong-subject", scope: `${CONTACTS} ${EMAIL}` });
    await expect(pending).rejects.toThrow(/Choose owner@example.com/i);
  });

  it("requires a verified hosted domain for Workspace directory access", async () => {
    const pending = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, "other.com", "directory", new AbortController().signal);
    config.callback({ access_token: "consumer", scope: `${DIRECTORY} ${EMAIL}` });
    await expect(pending).rejects.toThrow(/not in the selected Workspace directory/i);
  });

  it("rejects a broader, missing or denied scope without reading People", async () => {
    const pending = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.callback({ access_token: "broad-token", scope: `${CONTACTS} ${EMAIL} ${DIRECTORY}` });
    await expect(pending).rejects.toThrow(/exact read-only/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const denied = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.callback({ error: "access_denied" });
    await expect(denied).rejects.toThrow(/exact read-only/i);
  });

  it("treats a closed chooser as cancellation without reading Google identity", async () => {
    const pending = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.error_callback({ type: "popup_closed" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires Google to verify the email", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ email: "owner@example.com", email_verified: false, sub: "google-subject" }) })) as unknown as typeof fetch;
    const pending = requestGoogleInvitationPhotoGrant("owner@example.com", SUBJECT_HASH, null, "contacts", new AbortController().signal);
    config.callback({ access_token: "unverified", scope: `${CONTACTS} ${EMAIL}` });
    await expect(pending).rejects.toThrow(/did not confirm/i);
  });
});
