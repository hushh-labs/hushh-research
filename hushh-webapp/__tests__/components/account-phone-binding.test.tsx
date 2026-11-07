import { act, renderHook, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountPhoneBinding } from "@/components/profile/use-account-phone-binding";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { AuthService } from "@/lib/services/auth-service";

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { reloadPhoneVerificationUser: vi.fn() },
}));

const appPhone = "+16505550101";
const principal = { ownerId: "account-owner", firebaseUid: "firebase-user", accountGeneration: 1 };
const user = (phoneNumber: string | null, uid = principal.firebaseUid) => ({ uid, phoneNumber }) as User;
const options = { active: true, ownerId: principal.ownerId, firebaseUid: principal.firebaseUid, appPhone, appStatus: "verified" as const };

beforeEach(() => publishValidatedAuthSessionPrincipal(principal));
afterEach(() => {
  publishValidatedAuthSessionPrincipal(null);
  vi.resetAllMocks();
});

describe("Profile phone binding", () => {
  it.each([null, "+16505550102"])("requires verification when the Firebase phone is %s", async providerPhone => {
    vi.mocked(AuthService.reloadPhoneVerificationUser).mockResolvedValue(user(providerPhone));
    const { result } = renderHook(() => useAccountPhoneBinding(options));
    await waitFor(() => expect(result.current.status).toBe("needs-verification"));
    expect(result.current.linkedPhone).toBeNull();
    expect(result.current.providerPhone).toBe(providerPhone);

    act(() => result.current.acceptVerifiedUser(user(appPhone)));
    expect(result.current.status).toBe("verified");
    expect(result.current.linkedPhone).toBe(appPhone);
  });

  it("keeps a Firebase-only phone unconfirmed until the app saves it", async () => {
    vi.mocked(AuthService.reloadPhoneVerificationUser).mockResolvedValue(user(appPhone));
    const { result, rerender } = renderHook(useAccountPhoneBinding, {
      initialProps: { ...options, appPhone: null, appStatus: "missing" } as Parameters<typeof useAccountPhoneBinding>[0],
    });
    await waitFor(() => expect(result.current.status).toBe("needs-verification"));
    expect(result.current.linkedPhone).toBeNull();
    rerender(options);
    expect(result.current.linkedPhone).toBe(appPhone);
  });

  it("reports a failed provider read as unavailable and verifies the match on retry", async () => {
    vi.mocked(AuthService.reloadPhoneVerificationUser)
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce(user(appPhone));
    const { result } = renderHook(() => useAccountPhoneBinding(options));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.linkedPhone).toBeNull();
    await act(async () => { await result.current.refreshProviderPhone(); });
    expect(result.current.linkedPhone).toBe(appPhone);
  });

  it("ignores an old provider response after the signed-in owner changes", async () => {
    let finish!: (value: User) => void;
    vi.mocked(AuthService.reloadPhoneVerificationUser)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(user(null, "other-firebase"));
    const { result, rerender } = renderHook(useAccountPhoneBinding, { initialProps: options });
    const other = { ownerId: "other-owner", firebaseUid: "other-firebase", accountGeneration: 1 };
    act(() => publishValidatedAuthSessionPrincipal(other));
    rerender({ ...options, ...other });
    await waitFor(() => expect(result.current.status).toBe("needs-verification"));
    await act(async () => { finish(user(appPhone)); });
    expect(result.current.linkedPhone).toBeNull();
    expect(result.current.providerPhone).toBeNull();
  });
});
