import { expect, it } from "vitest";
import { validNativeAgentSettingsPath, validNativePayoutPath } from "@/lib/capacitor/native-profile-paths";
import { NativePaymentsFence, validNativePaymentsProjection, validNativePaymentsFinalEdit, type NativePaymentsProjection } from "@/lib/capacitor/native-profile-payments-scene";

  it("keeps payment editors free of operation authority and binds final input to its scene and visit", async () => {
    const state: NativePaymentsProjection = { documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, family: "profile",
      updateSequence: 1, privacyGeneration: 0, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111",
      draftRevision: 0, acknowledgedEditRevision: 0, canSave: true, busy: false, error: null, scene: "payment-funding", destinationId: "funding-visit", draft: { value: "10.00" } };
    expect(validNativePaymentsProjection(state)).toBe(true);
    expect(validNativePaymentsProjection({ ...state, draft: { value: "10.00", preview_token: "forbidden" } } as never)).toBe(false);
    expect(validNativePaymentsProjection({ ...state, scene: "payment-country", draft: { value: "USA" } })).toBe(false);
    const { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId } = state;
    const edit = { documentId, ownerEpoch, ownerGeneration, revision, family, scene, destinationId, draft: state.draft,
      updateSequence: 1, privacyGeneration: 0, editRevision: 1, composing: false };
    const final = { ...edit, baseDraftRevision: 0, acknowledgedEditRevision: 0 };
    expect(validNativePaymentsFinalEdit(final, state)).toBe(true);
    expect(validNativePaymentsFinalEdit({ ...final, scene: "payment-country" }, state)).toBe(false);
    expect(validNativePaymentsFinalEdit({ ...final, destinationId: "reopened-visit" }, state)).toBe(false);
    const fence = new NativePaymentsFence(state);
    expect(fence.update(state)).toBe(true);
    expect(fence.consumeEdit(edit)).toBe(true);
    const save = { ...edit, action: "save" as const, sequence: 1 };
    expect(fence.allows(save)).toBe(false);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    const confirmed = { ...save, updateSequence: 2 }; delete (confirmed as Partial<typeof edit>).draft; delete (confirmed as Partial<typeof edit>).composing;
    expect(await fence.consumeAction(confirmed, async () => ({ valid: true }), () => true)).toBe(true);
    expect(await fence.consumeAction(confirmed, async () => ({ valid: true }), () => true)).toBe(false);
    const pages = (ids: string[]) => ids.map(id => ({ id, title: "Public page", sections: [] })) as never;
    expect(validNativePayoutPath(pages(["payouts", "commerce-history", "commerce-receipt"]))).toBe(true);
    expect(validNativePayoutPath(pages(["payouts", "commerce-history/commerce-receipt"]))).toBe(false);
    expect(validNativePayoutPath(pages(["payouts", "commerce-funding", "account-delete"]))).toBe(false);
    expect(validNativePayoutPath([{ id: "payouts" }, { id: 7 }] as never)).toBe(false);
    expect(validNativeAgentSettingsPath(pages(["software-updates", "browser-review", "browser-policy"]))).toBe(true);
    expect(validNativeAgentSettingsPath(pages(["software-updates", "browser-review/browser-policy"]))).toBe(false);
  });
