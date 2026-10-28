import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  review: vi.fn(),
  resolvePhone: vi.fn(),
  reauthenticate: vi.fn(),
  validatePhone: vi.fn(),
  startPhoneProof: vi.fn(),
  getPhoneClaim: vi.fn(),
  cancelPhoneProof: vi.fn(),
  deleteAccount: vi.fn(),
  prepareRecaptcha: vi.fn(),
  resetRecaptcha: vi.fn(),
  native: false,
}));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => (mocks.native ? "ios" : "web"),
    isPluginAvailable: () => false,
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ resolveVerifiedPhoneNumber: mocks.resolvePhone }),
}));
vi.mock("@/lib/services/account-service", () => ({
  AccountService: {
    getLostVaultDeleteOptions: mocks.options,
    reviewLostVaultDeletion: mocks.review,
    validateLostVaultDeletionPhone: mocks.validatePhone,
  },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    reauthenticateAccountDeletionIdentity: mocks.reauthenticate,
    startPhoneDeletionVerification: mocks.startPhoneProof,
    confirmPhoneDeletionVerification: mocks.getPhoneClaim,
    cancelPhoneDeletionVerification: mocks.cancelPhoneProof,
  },
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/auth/google-signup-token", () => ({
  preloadGoogleSignupAuth: async () => {},
}));
vi.mock("@/lib/firebase/config", () => ({
  prepareRecaptchaVerifier: mocks.prepareRecaptcha,
  resetRecaptcha: mocks.resetRecaptcha,
}));
vi.mock("@/lib/flows/delete-account", () => ({
  executeLostVaultAccountDeletion: mocks.deleteAccount,
  lostVaultDeletionErrorMessage: () => "Verify your account again.",
}));

import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";
import { ApiError } from "@/lib/services/api-client";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const PHONE = "+16505550100";
const user = {
  uid: "owner-1",
  getIdToken: vi.fn(async () => "current-session-token"),
} as unknown as Parameters<typeof LostVaultDeletePanel>[0]["user"];
const phoneOptions = {
  phone_available: true,
  phone_hint: "••00",
  providers: ["google.com"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function openPhone() {
  const view = render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue with Google" }),
  );
  await screen.findByLabelText("Mobile number");
  return view;
}
function enterPhone(phone = PHONE) {
  fireEvent.change(screen.getByLabelText("Mobile number"), {
    target: { value: phone },
  });
}
async function sendPhone() {
  enterPhone();
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await screen.findByLabelText("Verification code");
}
async function verifyPhone() {
  await sendPhone();
  fireEvent.change(screen.getByLabelText("Verification code"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
  await screen.findByRole("button", { name: "Permanently delete account" });
}
function confirmDeletion() {
  fireEvent.click(screen.getByRole("checkbox"));
  const button = screen.getByRole("button", {
    name: "Permanently delete account",
  });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
}

describe("lost vault deletion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "focus").mockImplementation(() => {});
    mocks.native = false;
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionPrincipal({ firebaseUid: user.uid, ownerId: user.uid, accountGeneration: 0 });
    mocks.options.mockResolvedValue(phoneOptions);
    mocks.review.mockResolvedValue({ inventory_sha256: "a".repeat(64), credential_count: 1, local_erasure_required: true });
    mocks.resolvePhone.mockResolvedValue(null);
    mocks.reauthenticate.mockResolvedValue("fresh-provider-token");
    mocks.validatePhone.mockResolvedValue({ valid: true });
    mocks.startPhoneProof.mockResolvedValue({ verificationId: "verification-id" });
    mocks.getPhoneClaim.mockResolvedValue("phone-proof-token");
    mocks.cancelPhoneProof.mockResolvedValue(undefined);
    mocks.prepareRecaptcha.mockResolvedValue({});
    mocks.deleteAccount.mockResolvedValue({
      success: true,
      account_deleted: true,
      ready_to_start_fresh: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    publishValidatedAuthSessionOwner(null);
  });

  it("preserves provider-only deletion only for a backend-confirmed no-phone account", async () => {
    mocks.options.mockResolvedValue({
      phone_available: false,
      phone_hint: null,
      providers: ["google.com"],
    });
    render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("button", { name: "Permanently delete account" })).toBeDisabled();
    confirmDeletion();
    await screen.findByRole("link", { name: "Create a new account" });
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAccount).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.uid,
      sessionUser: user,
      firebaseIdToken: "fresh-provider-token",
      reviewedInventorySha256: "a".repeat(64),
      acceptLocalErasure: true,
      phoneIdToken: undefined,
      owner: expect.objectContaining({ firebaseUid: user.uid, ownerId: user.uid, accountGeneration: 0 }),
      isCurrent: expect.any(Function),
    }));
    expect(mocks.validatePhone).not.toHaveBeenCalled();
    expect(mocks.getPhoneClaim).not.toHaveBeenCalled();
  });
  it.each(["null", "throws", "mismatched"])(
    "keeps entry reachable when the optional phone lookup %s",
    async (failure) => {
      if (failure === "throws")
        mocks.resolvePhone.mockRejectedValue(new Error("offline"));
      if (failure === "mismatched")
        mocks.resolvePhone.mockResolvedValue("+16505550101");
      if (failure === "throws")
        vi.mocked(window.focus).mockImplementationOnce(() => { throw new Error("focus denied"); });
      await openPhone();
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Mobile number")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: /Country code/ }),
      ).toBeVisible();
      expect(screen.queryByText(/Use One on the web/)).toBeNull();
      await verifyPhone();
      expect(mocks.validatePhone).toHaveBeenCalledWith(
        "fresh-provider-token",
        PHONE,
      );
      expect(mocks.startPhoneProof).toHaveBeenCalledWith(PHONE, {}, { expectedUserId: user.uid, attemptId: expect.any(String), signal: expect.any(AbortSignal) });
      expect(mocks.deleteAccount).not.toHaveBeenCalled();
      confirmDeletion();
      await screen.findByRole("link", { name: "Create a new account" });
      expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
      expect(mocks.deleteAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.uid,
          phoneIdToken: "phone-proof-token",
        }),
      );
    },
  );

  it("rejects a wrong full number with the right suffix before preparing or sending SMS", async () => {
    mocks.validatePhone.mockRejectedValue(
      new ApiError("mismatch", 403, {
        detail: { code: "ACCOUNT_DELETE_PHONE_MISMATCH" },
      }),
    );
    await openPhone();
    enterPhone("+12125550100");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match",
    );
    expect(mocks.prepareRecaptcha).not.toHaveBeenCalled();
    expect(mocks.startPhoneProof).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    mocks.validatePhone.mockResolvedValue({ valid: true });
    await sendPhone();
    expect(mocks.startPhoneProof).toHaveBeenCalledTimes(1);
  });

  it("retries unavailable authoritative validation without reloading the app", async () => {
    mocks.validatePhone.mockRejectedValueOnce(
      new ApiError("unavailable", 503, {
        detail: { code: "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE" },
      }),
    );
    await openPhone();
    enterPhone();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not check",
    );
    expect(mocks.startPhoneProof).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Verification code");
    expect(mocks.validatePhone).toHaveBeenCalledTimes(2);
  });

  it("requires real provider reverification when the preflight reports expired proof", async () => {
    mocks.validatePhone.mockRejectedValueOnce(
      new ApiError("expired", 401, {
        detail: { code: "ACCOUNT_DELETE_REAUTH_REQUIRED" },
      }),
    );
    await openPhone();
    enterPhone();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sign-in check expired",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await screen.findByLabelText("Mobile number");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Verification code");
    expect(mocks.reauthenticate).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid-verification-code", "code-expired"])(
    "recovers from %s with an explicit retry or resend",
    async (code) => {
      mocks.getPhoneClaim.mockRejectedValueOnce(
        Object.assign(new Error("bad code"), { code }),
      );
      await openPhone();
      await sendPhone();
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: "111111" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
      await screen.findByRole("alert");
      expect(mocks.deleteAccount).not.toHaveBeenCalled();
      if (code === "code-expired") {
        // Advance the clock used by the existing live countdown without sleeping.
        const future = Date.now() + 31_000;
        vi.spyOn(Date, "now").mockReturnValue(future);
        await waitFor(
          () =>
            expect(
              screen.getByRole("button", { name: "Send another code" }),
            ).toBeEnabled(),
          { timeout: 1600 },
        );
        mocks.startPhoneProof.mockResolvedValue({ verificationId: "new-verification-id" });
        fireEvent.click(
          screen.getByRole("button", { name: "Send another code" }),
        );
        await waitFor(() =>
          expect(mocks.startPhoneProof).toHaveBeenCalledTimes(2),
        );
        expect(screen.getByLabelText("Verification code")).toHaveValue("");
      }
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
      await screen.findByRole("button", { name: "Permanently delete account" });
      expect(mocks.getPhoneClaim).toHaveBeenLastCalledWith({
        expectedUserId: user.uid,
        attemptId: expect.any(String),
        verificationCode: "123456",
        verificationId:
          code === "code-expired" ? "new-verification-id" : "verification-id",
      });
    },
  );

  it("ignores late hydration once the person has edited the number", async () => {
    const late = deferred<string | null>();
    mocks.resolvePhone.mockReturnValue(late.promise);
    await openPhone();
    enterPhone("+12125550100");
    await act(async () => late.resolve(PHONE));
    expect(screen.getByLabelText("Mobile number")).toHaveValue("2125550100");
  });

  it("number edits invalidate an in-flight comparison before SMS and cannot reuse its result", async () => {
    const late = deferred<{ valid: true }>();
    mocks.validatePhone.mockReturnValueOnce(late.promise);
    await openPhone();
    enterPhone();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    enterPhone("+12125550100");
    await act(async () => late.resolve({ valid: true }));
    expect(mocks.startPhoneProof).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Verification code");
    expect(mocks.validatePhone).toHaveBeenLastCalledWith(
      "fresh-provider-token",
      "+12125550100",
    );
  });

  it.each(["cancel", "unmount", "switch", "same_uid_new_generation"])(
    "discards late phone proof after %s",
    async (action) => {
      const late = deferred<string>();
      mocks.getPhoneClaim.mockReturnValue(late.promise);
      const view = await openPhone();
      await sendPhone();
      fireEvent.change(screen.getByLabelText("Verification code"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
      if (action === "cancel")
        fireEvent.click(screen.getByRole("button", { name: "Back to unlock" }));
      else if (action === "unmount") view.unmount();
      else {
        publishValidatedAuthSessionOwner(null);
        const next = action === "switch" ? { ...user, uid: "owner-2" } : user;
        publishValidatedAuthSessionPrincipal({ firebaseUid: next.uid, ownerId: action === "same_uid_new_generation" ? "acct_" + "1".repeat(32) : next.uid, accountGeneration: action === "same_uid_new_generation" ? 1 : 0 });
        view.rerender(<LostVaultDeletePanel user={next} onBack={vi.fn()} />);
      }
      await act(async () => late.resolve("stale-phone-proof"));
      expect(
        screen.queryByRole("button", { name: "Permanently delete account" }),
      ).toBeNull();
      expect(mocks.deleteAccount).not.toHaveBeenCalled();
    },
  );

  it("fences late provider and SMS results on cancellation", async () => {
    const late = deferred<string>();
    mocks.reauthenticate.mockReturnValue(late.promise);
    const onBack = vi.fn();
    render(<LostVaultDeletePanel user={user} onBack={onBack} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to unlock" }));
    await act(async () => late.resolve("late-provider-proof"));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Mobile number")).toBeNull();
    expect(mocks.validatePhone).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
  it("invalidates an outstanding SMS session on edit and prevents duplicate sends", async () => {
    const late = deferred<{ verificationId: string }>();
    mocks.startPhoneProof.mockReturnValue(late.promise);
    await openPhone();
    enterPhone();
    const send = screen.getByRole("button", { name: "Send code" });
    act(() => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    await waitFor(() => expect(mocks.startPhoneProof).toHaveBeenCalledTimes(1));
    enterPhone("+12125550100");
    await act(async () => late.resolve({ verificationId: "stale-verification-id" }));
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it.each([
    [{ ready_to_start_fresh: false }, "Account removal still needs attention"],
    [
      {
        ready_to_start_fresh: false,
        details: { firebase_auth_user: "identity_retained" },
      },
      "will not be removed automatically",
    ],
    [{}, "Account removal still needs attention"],
  ])(
    "withholds fresh signup for incomplete removal %j",
    async (outcome, message) => {
      mocks.deleteAccount.mockResolvedValue({
        success: true,
        account_deleted: true,
        ...outcome,
      });
      await openPhone();
      await verifyPhone();
      confirmDeletion();
      expect(await screen.findByRole("status")).toHaveTextContent(message);
      expect(
        screen.queryByRole("link", { name: "Create a new account" }),
      ).toBeNull();
    },
  );

  it("does not retry an uncertain deletion", async () => {
    mocks.deleteAccount.mockRejectedValue(
      Object.assign(new Error("uncertain"), {
        code: "ACCOUNT_DELETION_OUTCOME_UNCERTAIN",
      }),
    );
    await openPhone();
    await verifyPhone();
    confirmDeletion();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "won't retry it automatically",
    );
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("link", { name: "Create a new account" }),
    ).toBeNull();
  });

  it("keeps browser help accurate when no supported provider is enrolled", async () => {
    mocks.options.mockResolvedValue({ ...phoneOptions, providers: [] });
    render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
    expect(await screen.findByText("Contact support to verify your deletion request.")).toBeVisible();
    expect(screen.queryByText(/Use One on the web/)).toBeNull();
    expect(mocks.reauthenticate).not.toHaveBeenCalled();
  });

  it("supports native manual codes without web reCAPTCHA", async () => {
    mocks.native = true;
    await openPhone();
    await verifyPhone();
    expect(mocks.validatePhone).toHaveBeenCalledWith("fresh-provider-token", PHONE);
    expect(mocks.prepareRecaptcha).not.toHaveBeenCalled();
    expect(mocks.startPhoneProof).toHaveBeenCalledWith(PHONE, undefined, {
      expectedUserId: user.uid, attemptId: expect.any(String), signal: expect.any(AbortSignal),
    });
    expect(await screen.findByRole("button", { name: "Permanently delete account" })).toBeDisabled();
    expect(screen.queryByText(/phone check is unavailable/)).toBeNull();
  });

  it("accepts native instant proof but still requires deletion acknowledgement", async () => {
    mocks.native = true;
    mocks.startPhoneProof.mockResolvedValue({ phoneIdToken: "instant-phone-proof" });
    await openPhone();
    enterPhone();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("button", { name: "Permanently delete account" })).toBeDisabled();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
    expect(mocks.getPhoneClaim).not.toHaveBeenCalled();
    confirmDeletion();
    await screen.findByRole("link", { name: "Create a new account" });
    expect(mocks.deleteAccount.mock.calls[0][0].phoneIdToken).toBe("instant-phone-proof");
  });

  it("cancels native pending proof on unmount and ignores a late instant result", async () => {
    mocks.native = true;
    const late = deferred<{ phoneIdToken: string }>();
    mocks.startPhoneProof.mockReturnValue(late.promise);
    const view = await openPhone();
    enterPhone();
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(mocks.startPhoneProof).toHaveBeenCalledTimes(1));
    const attemptId = mocks.startPhoneProof.mock.calls[0][2].attemptId;
    view.unmount();
    expect(mocks.cancelPhoneProof).toHaveBeenCalledWith(attemptId);
    await act(async () => late.resolve({ phoneIdToken: "stale-proof" }));
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});
