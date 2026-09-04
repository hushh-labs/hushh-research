import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE,
  CONTACT_SYNC_SESSION_CHANGED_MESSAGE,
  createContactSyncAccountPhoneResolver,
  resolveContactSyncAccountPhone,
} from "@/lib/contacts/contact-sync-identity";

describe("resolveContactSyncAccountPhone", () => {
  it("forces an authoritative identity refresh when AuthContext has no phone", () => {
    const authContextSource = readFileSync(
      join(process.cwd(), "lib", "firebase", "auth-context.tsx"),
      "utf8",
    );

    expect(authContextSource).toMatch(
      /refreshCurrentUserIdentity\(\s*currentUser,\s*\{ force: true \},\s*\)/,
    );
  });

  it("uses the latest phone while the same account owns the sync", () => {
    expect(
      resolveContactSyncAccountPhone({
        initiatingUserId: "user_a",
        currentUserId: "user_a",
        accountPhoneNumber: " +919876543210 ",
      }),
    ).toBe("+919876543210");
  });

  it("allows a same-account sync with no hydrated phone", () => {
    expect(
      resolveContactSyncAccountPhone({
        initiatingUserId: "user_a",
        currentUserId: "user_a",
        accountPhoneNumber: null,
      }),
    ).toBeNull();
  });

  it("stops the sync when the signed-in account changes", () => {
    expect(() =>
      resolveContactSyncAccountPhone({
        initiatingUserId: "user_a",
        currentUserId: "user_b",
        accountPhoneNumber: "+14155550101",
      }),
    ).toThrow(CONTACT_SYNC_SESSION_CHANGED_MESSAGE);
  });

  it("waits for backend hydration instead of guessing from browser locale", async () => {
    let finishHydration: ((phone: string) => void) | null = null;
    const hydrate = () =>
      new Promise<string>((resolve) => {
        finishHydration = resolve;
      });
    const resolver = createContactSyncAccountPhoneResolver({
      initiatingUserId: "user_a",
      getCurrentIdentity: () => ({
        userId: "user_a",
        accountPhoneNumber: null,
      }),
      hydrateAccountPhoneNumber: hydrate,
    });

    const pending = resolver();
    finishHydration?.("+919876543210");

    await expect(pending).resolves.toBe("+919876543210");
  });

  it("rechecks account ownership after a pending hydration", async () => {
    let currentUserId = "user_a";
    let finishHydration: ((phone: string) => void) | null = null;
    const resolver = createContactSyncAccountPhoneResolver({
      initiatingUserId: "user_a",
      getCurrentIdentity: () => ({
        userId: currentUserId,
        accountPhoneNumber: null,
      }),
      hydrateAccountPhoneNumber: () =>
        new Promise<string>((resolve) => {
          finishHydration = resolve;
        }),
    });

    const pending = resolver();
    currentUserId = "user_b";
    finishHydration?.("+919876543210");

    await expect(pending).rejects.toThrow(CONTACT_SYNC_SESSION_CHANGED_MESSAGE);
  });

  it("fails closed when authoritative phone hydration still has no phone", async () => {
    const resolver = createContactSyncAccountPhoneResolver({
      initiatingUserId: "user_a",
      getCurrentIdentity: () => ({
        userId: "user_a",
        accountPhoneNumber: null,
      }),
      hydrateAccountPhoneNumber: async () => null,
    });

    await expect(resolver()).rejects.toThrow(
      CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE,
    );
  });

  it("fails closed when a phone-less caller omits the hydrator", async () => {
    const resolver = createContactSyncAccountPhoneResolver({
      initiatingUserId: "user_a",
      getCurrentIdentity: () => ({
        userId: "user_a",
        accountPhoneNumber: null,
      }),
    });

    await expect(resolver()).rejects.toThrow(
      CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE,
    );
  });
});
