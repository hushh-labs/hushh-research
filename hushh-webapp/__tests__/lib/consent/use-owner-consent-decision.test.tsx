import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn() });
  return {
    vaultKey: null as string | null,
    handleApproveBundle: vi.fn(async () => undefined),
    handleDenyBundle: vi.fn(async (..._args: unknown[]) => undefined),
    toast,
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: mocks.vaultKey }),
}));

vi.mock("@/lib/consent/use-consent-actions", () => ({
  useConsentActions: () => ({
    handleApproveBundle: mocks.handleApproveBundle,
    handleDenyBundle: mocks.handleDenyBundle,
    bundleProgress: null,
  }),
}));

import { groupPendingConsentRequests } from "@/lib/consent/owner-consent-request";
import { useOwnerConsentDecision } from "@/lib/consent/use-owner-consent-decision";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/**
 * Allow from the Feed with the vault locked.
 *
 * Allowing builds the encrypted export from the owner's memory ON THIS DEVICE,
 * so it needs the vault key. The old path answered a locked vault with a toast
 * that navigated away and dropped the decision. Now the unlock prompt opens,
 * nothing is sent while it is open, and the same decision runs once the key
 * arrives. Closing the prompt cancels it and nothing is sent at all.
 */

function request() {
  const entry: ConsentCenterEntry = {
    id: "req-1",
    request_id: "req-1",
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    scope: "attr.food.preferences.*",
    counterpart_type: "person",
    counterpart_id: "user-kushal",
    counterpart_label: "Kushal Trivedi",
    reason: "Picking a place for our dinner together",
    issued_at: "1790000000000",
    metadata: { bundle_id: "bundle-dinner", expiry_hours: 168 },
  };
  return groupPendingConsentRequests([entry])[0]!;
}

describe("useOwnerConsentDecision", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.vaultKey = null;
  });

  it("prompts the unlock first, sends nothing meanwhile, then allows through the shared path", async () => {
    const { result, rerender } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    let decided!: Promise<boolean>;
    act(() => {
      decided = result.current.allow(request());
    });

    expect(result.current.unlockPrompt.open).toBe(true);
    expect(result.current.unlockPrompt.title).toBe("Unlock to allow");
    expect(result.current.unlockPrompt.description).toContain("Food preferences");
    expect(mocks.handleApproveBundle).not.toHaveBeenCalled();

    // The vault opens: the waiting decision runs, once.
    mocks.vaultKey = "vault-key";
    rerender();

    await expect(decided).resolves.toBe(true);
    expect(mocks.handleApproveBundle).toHaveBeenCalledTimes(1);
    const [consents, options] = mocks.handleApproveBundle.mock.calls[0] as unknown as [
      Array<{ id: string; durationHours?: number; scope: string }>,
      { successMessage?: string },
    ];
    expect(consents.map((consent) => consent.id)).toEqual(["req-1"]);
    expect(consents[0]!.durationHours).toBe(168);
    expect(options.successMessage).toBe("Kushal can now see your Food preferences.");
    await waitFor(() => expect(result.current.unlockPrompt.open).toBe(false));
  });

  it("drops the decision when the unlock is closed", async () => {
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    let decided!: Promise<boolean>;
    act(() => {
      decided = result.current.deny(request());
    });
    expect(result.current.unlockPrompt.title).toBe("Unlock to decline");

    act(() => {
      result.current.unlockPrompt.cancel();
    });

    await expect(decided).resolves.toBe(false);
    expect(result.current.unlockPrompt.open).toBe(false);
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
    expect(mocks.handleApproveBundle).not.toHaveBeenCalled();
  });

  it("decides at once when the vault is already open", async () => {
    mocks.vaultKey = "vault-key";
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    await act(async () => {
      await expect(result.current.deny(request())).resolves.toBe(true);
    });
    expect(result.current.unlockPrompt.open).toBe(false);
    expect(mocks.handleDenyBundle).toHaveBeenCalledWith(["req-1"], expect.any(Object));
  });

  /** The Undo toast's action, as the person would tap it. */
  function undoAction() {
    const options = mocks.toast.mock.calls.at(-1)?.[1] as {
      duration: number;
      action: { label: string; onClick: () => void };
    };
    return options;
  }

  it("declines with one tap after a five-second Undo window", async () => {
    vi.useFakeTimers();
    mocks.vaultKey = "vault-key";
    const onHide = vi.fn();
    const onRestore = vi.fn();
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    await act(async () => {
      await expect(
        result.current.declineWithUndo(request(), { onHide, onRestore }),
      ).resolves.toBe(true);
    });

    // The row leaves at once; the toast offers Undo; nothing is sent yet.
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Declined Kushal's request.",
      expect.objectContaining({ duration: 5000 }),
    );
    expect(undoAction().action.label).toBe("Undo");
    await act(async () => {
      vi.advanceTimersByTime(4999);
    });
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.handleDenyBundle).toHaveBeenCalledTimes(1);
    expect(mocks.handleDenyBundle).toHaveBeenCalledWith(
      ["req-1"],
      expect.objectContaining({ quiet: true }),
    );
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("Undo puts the row back and sends nothing, even after the window", async () => {
    vi.useFakeTimers();
    mocks.vaultKey = "vault-key";
    const onHide = vi.fn();
    const onRestore = vi.fn();
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );
    await act(async () => {
      await result.current.declineWithUndo(request(), { onHide, onRestore });
    });

    act(() => undoAction().action.onClick());
    expect(onRestore).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
  });

  it("sends a waiting decline at once when the surface unmounts", async () => {
    vi.useFakeTimers();
    mocks.vaultKey = "vault-key";
    const { result, unmount } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );
    await act(async () => {
      await result.current.declineWithUndo(request(), {
        onHide: vi.fn(),
        onRestore: vi.fn(),
      });
    });
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();

    unmount();
    // Never silently lost: leaving early sends it now, not never.
    expect(mocks.handleDenyBundle).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mocks.handleDenyBundle).toHaveBeenCalledTimes(1);
  });

  it("unlocks before the Undo window, and a closed unlock changes nothing", async () => {
    const onHide = vi.fn();
    const { result, rerender } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );
    let scheduled!: Promise<boolean>;
    act(() => {
      scheduled = result.current.declineWithUndo(request(), {
        onHide,
        onRestore: vi.fn(),
      });
    });
    expect(result.current.unlockPrompt.title).toBe("Unlock to decline");
    expect(onHide).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();

    mocks.vaultKey = "vault-key";
    rerender();
    await expect(scheduled).resolves.toBe(true);
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("brings the row back and says so when the deny fails", async () => {
    vi.useFakeTimers();
    mocks.vaultKey = "vault-key";
    mocks.handleDenyBundle.mockRejectedValueOnce(
      new Error("Couldn't decline this. Try again."),
    );
    const onRestore = vi.fn();
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );
    await act(async () => {
      await result.current.declineWithUndo(request(), {
        onHide: vi.fn(),
        onRestore,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith("Couldn't decline this. Try again.");
  });
});
