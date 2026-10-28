import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, resetCommerceAccountFixture } from "./scope-commerce-mocks.fixture";
import { useNativePayments } from "@/components/profile/use-native-payments";
import { validNativeDrawerProjection } from "@/lib/capacitor/native-drawers";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

beforeEach(resetCommerceAccountFixture);
afterEach(cleanup);

describe("native payment editor authority", () => {
  it("stages native funding edits without retiring an unchanged uncertain checkout and survives revalidation", async () => {
    mocks.checkout.mockRejectedValue(new Error("Outcome unconfirmed"));
    mocks.openWindow.mockReturnValue({ close: vi.fn() });
    const { result, rerender } = renderHook(() => useNativePayments(true, true, "payments-owner"));
    await waitFor(() => expect(result.current.commerce.account).not.toBeNull());
    await act(async () => { await result.current.commerce.checkout(); });
    const firstKey = mocks.checkout.mock.calls[0][2];
    const command = (label: string) => {
      const row = result.current.pages.at(-1)!.sections.flatMap(section => section.rows).find(row => row.label === label)!;
      return result.current.rows.get(row.id)!;
    };
    const retiredOpen = command("Add funds");
    await act(async () => { await retiredOpen(); });
    await act(async () => { await command("Add to balance (USD)")(); });
    let editor = result.current.editor("funding-visit", vi.fn())!;
    act(() => { editor.props.model.changeDraft({ value: "" }); });
    expect(result.current.commerce.amount).toBe("10.00");
    expect(validNativeDrawerProjection({ documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, family: "profile",
      updateSequence: 1, privacyGeneration: 0, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", title: "Profile", sections: [],
      open: true, enabled: true, backEnabled: true, profileStack: result.current.pages, profileDestinationId: "funding-visit" })).toBe(true);
    editor = result.current.editor("funding-visit", vi.fn())!;
    expect(editor.props.model.canSave).toBe(false);
    act(() => editor.props.onClose());
    await act(async () => { await result.current.commerce.checkout(); });
    expect(mocks.checkout.mock.calls[1][2]).toBe(firstKey);
    await act(async () => { await command("Add to balance (USD)")(); });
    const retiredEditor = result.current.editor("funding-visit", vi.fn())!;
    act(() => retiredEditor.props.onClose());
    await act(async () => { await command("Add to balance (USD)")(); });
    editor = result.current.editor("funding-visit", vi.fn())!;
    act(() => { editor.props.model.changeDraft({ value: "22.00" }); });
    expect(retiredEditor.props.model.current()).toBe(false);
    act(() => { retiredEditor.props.onSaved(); retiredEditor.props.onClose(); });
    expect(result.current.formScene).toBe("payment-funding");
    expect(result.current.commerce.amount).toBe("10.00");
    editor = result.current.editor("funding-visit", vi.fn())!;
    expect(editor.props.model.draft.value).toBe("22.00");
    act(() => editor.props.onClose());
    act(() => { publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("owner"); rerender(); });
    await act(async () => retiredOpen());
    expect(result.current.pages).toHaveLength(1);
    await act(async () => { await command("Add funds")(); });
    expect(result.current.pages.at(-1)?.id).toBe("commerce-funding");
  });
});
