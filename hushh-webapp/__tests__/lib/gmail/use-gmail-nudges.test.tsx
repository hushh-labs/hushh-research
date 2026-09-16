import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useGmailNudges } from "@/lib/gmail/use-gmail-nudges";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    listNudges: vi.fn(),
  },
}));

const mockedListNudges = vi.mocked(GmailReceiptsService.listNudges);

describe("useGmailNudges", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch when disconnected", () => {
    renderHook(() =>
      useGmailNudges({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: false,
        idTokenProvider: async () => "id-token",
      }),
    );
    expect(mockedListNudges).not.toHaveBeenCalled();
  });

  it("fetches and returns nudges when connected", async () => {
    mockedListNudges.mockResolvedValueOnce({
      user_id: "user-1",
      account_email: "user@example.com",
      nudges: [
        {
          type: "needs_reply",
          thread_id: "t1",
          message_id: "m1",
          title: "Re: Contract",
          sender: "Jordan",
          sender_email: "jordan@example.com",
          received_at: new Date().toISOString(),
        },
      ],
    });

    const { result } = renderHook(() =>
      useGmailNudges({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.nudges).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(mockedListNudges).toHaveBeenCalledWith({
      idToken: "id-token",
      vaultOwnerToken: "vault-token",
      userId: "user-1",
      limit: 10,
    });
  });

  it("sets an error and still marks loaded when the fetch rejects", async () => {
    mockedListNudges.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() =>
      useGmailNudges({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.nudges).toHaveLength(0);
    expect(result.current.error).toBeTruthy();
  });

  it("returns an empty list once disconnected, even if nudges were previously fetched", async () => {
    mockedListNudges.mockResolvedValueOnce({
      user_id: "user-1",
      account_email: "user@example.com",
      nudges: [
        {
          type: "needs_reply",
          thread_id: "t1",
          message_id: "m1",
          title: "Re: Contract",
          sender: "Jordan",
          sender_email: "jordan@example.com",
          received_at: new Date().toISOString(),
        },
      ],
    });

    const { result, rerender } = renderHook(
      (props: { isConnected: boolean }) =>
        useGmailNudges({
          userId: "user-1",
          vaultOwnerToken: "vault-token",
          isConnected: props.isConnected,
          idTokenProvider: async () => "id-token",
        }),
      { initialProps: { isConnected: true } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.nudges).toHaveLength(1);

    rerender({ isConnected: false });
    expect(result.current.nudges).toHaveLength(0);
  });
});
