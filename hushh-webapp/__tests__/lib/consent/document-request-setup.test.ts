import { describe, expect, it } from "vitest";

import {
  documentRequestSetupHref,
  documentRequestSetupLabel,
  documentRequestSetupState,
  type DocumentRequestSetupState,
} from "@/lib/consent/document-request-setup";

/**
 * A blocked document request names one next step and one screen that clears
 * it. The Feed row, its history row and the review sheet all read this.
 */
describe("document request setup", () => {
  it("asks for the owner's Drive first, then payouts, price and payments", () => {
    const blocked = {
      ownerDriveReady: false,
      ownerPayoutAccountReady: false,
      ownerPriceRequired: true,
      paymentsReady: false,
    };
    expect(documentRequestSetupState(blocked)).toBe("drive");
    expect(documentRequestSetupState({ ...blocked, ownerDriveReady: true })).toBe("payouts");
    expect(documentRequestSetupState({ ...blocked, ownerDriveReady: true, ownerPayoutAccountReady: true }))
      .toBe("price");
    expect(documentRequestSetupState({ paymentsReady: false })).toBe("unavailable");
    // A legacy request carries none of these and needs no setup.
    expect(documentRequestSetupState({})).toBeNull();
  });

  it("opens Google Drive over the screen it came from and keeps the way back to payouts and price", () => {
    expect(documentRequestSetupHref("drive")).toBe(
      "/one/feed?profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agoogle_drive",
    );
    expect(documentRequestSetupHref("drive", "/one/consent?tab=pending")).toBe(
      "/one/consent?tab=pending&profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agoogle_drive",
    );
    expect(documentRequestSetupHref("payouts")).toBe("/one/profile/payouts?from=%2Fone%2Ffeed");
    expect(documentRequestSetupHref("price", "/one/consent?tab=pending")).toBe(
      "/one/profile/request-pricing?from=%2Fone%2Fconsent%3Ftab%3Dpending",
    );
  });

  it("tells the owner what to do and never names the owner's Drive to the requester", () => {
    const states: DocumentRequestSetupState[] = ["drive", "payouts", "price", "unavailable"];
    expect(states.map((state) => documentRequestSetupLabel(state, true))).toEqual([
      "Connect Google Drive",
      "Link payouts",
      "Set price",
      "Payments unavailable",
    ]);
    expect(states.map((state) => documentRequestSetupLabel(state, false))).toEqual([
      "Waiting for owner setup",
      "Waiting for owner setup",
      "Waiting for price",
      "Payments unavailable",
    ]);
  });
});
