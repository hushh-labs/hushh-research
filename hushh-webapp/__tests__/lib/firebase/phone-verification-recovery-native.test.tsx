// Register the shared provider mocks before importing the provider itself.
import {
  mocks, deferred, makeUser, NativePhoneProbe,
  SessionProbe, activeSessionResponse, resetNativeAuthMocks, cleanupNativeAuthMocks,
} from "./fixtures/auth-context-native-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

describe("@feature_auth_reliability @trace_loop native phone verification recovery", () => {
  beforeEach(resetNativeAuthMocks);
  afterEach(cleanupNativeAuthMocks);

  it.each([false, true])("@feature_auth_reliability @trace_loop cancels the old owner's native start without cancelling a newer attempt: replacement=%s", async replacement => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    const oldStart = deferred<{ autoVerified: boolean; verificationId: string }>();
    mocks.phoneStart.mockReturnValueOnce(oldStart.promise);
    const view = render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    const startLabel = replacement ? "Start native replacement" : "Start native phone";
    fireEvent.click(screen.getByRole("button", { name: startLabel }));
    await waitFor(() => expect(mocks.phoneStart).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.phoneStart.mock.calls[0][1].signal as AbortSignal;
    expect(oldSignal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start account B settlement" }));
    expect(oldSignal.aborted).toBe(true);
    mocks.restoreNativeSession.mockResolvedValue(makeUser("interactive-account-b"));
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse("interactive-account-b"));
    fireEvent.click(screen.getByRole("button", { name: "Complete account B settlement" }));
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("interactive-account-b"));
    fireEvent.click(screen.getByRole("button", { name: startLabel }));
    await waitFor(() => expect(mocks.phoneStart).toHaveBeenCalledTimes(2));
    const currentSignal = mocks.phoneStart.mock.calls[1][1].signal as AbortSignal;
    expect(currentSignal.aborted).toBe(false);
    await act(async () => { oldStart.resolve({ autoVerified: false, verificationId: "old-owner-verification" }); });
    expect(currentSignal.aborted).toBe(false);
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("interactive-account-b");
    view.unmount();
    expect(currentSignal.aborted).toBe(true);
  });

});
