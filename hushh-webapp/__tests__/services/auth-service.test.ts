import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockFirebaseAuthentication,
  mockHushhAuth,
  mockCapacitor,
  mockPhoneAuthProvider,
  mockUpdatePhoneNumber,
  mockLinkWithCredential,
} = vi.hoisted(() => ({
  mockAuth: {
    currentUser: null as any,
    onAuthStateChanged: vi.fn(),
  },
  mockFirebaseAuthentication: {
    addListener: vi.fn(),
    confirmVerificationCode: vi.fn(),
    getCurrentUser: vi.fn(),
    getIdToken: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    linkWithPhoneNumber: vi.fn(),
    unlink: vi.fn(),
  },
  mockHushhAuth: {
    getCurrentUser: vi.fn(),
    getIdToken: vi.fn(),
    signOut: vi.fn(),
    signInWithApple: vi.fn(),
  },
  mockCapacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => "ios"),
  },
  mockPhoneAuthProvider: vi.fn(),
  mockUpdatePhoneNumber: vi.fn(),
  mockLinkWithCredential: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: mockCapacitor,
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: mockAuth,
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: {
    credential: vi.fn(),
    credentialFromResult: vi.fn(),
  },
  OAuthProvider: vi.fn(),
  PhoneAuthProvider: Object.assign(mockPhoneAuthProvider, {
    credential: vi.fn(),
  }),
  linkWithCredential: mockLinkWithCredential,
  signInWithCredential: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  updatePhoneNumber: mockUpdatePhoneNumber,
}));

vi.mock("@capacitor-firebase/authentication", () => ({
  FirebaseAuthentication: mockFirebaseAuthentication,
  ProviderId: {
    PHONE: "phone",
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhAuth: mockHushhAuth,
}));

import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { linkWithCredential, PhoneAuthProvider, updatePhoneNumber } from "firebase/auth";
import { HushhAuth } from "@/lib/capacitor";
import { AuthService } from "@/lib/services/auth-service";

function createIdToken(expiresInSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: "test-user",
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  );
  return `${header}.${payload}.signature`;
}

describe("AuthService.restoreNativeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    mockCapacitor.getPlatform.mockReturnValue("ios");
    mockAuth.currentUser = null;
    mockAuth.onAuthStateChanged.mockReset();
    mockPhoneAuthProvider.mockImplementation(function () {
      return {
        verifyPhoneNumber: vi.fn(),
      };
    });
    vi.mocked(FirebaseAuthentication.getCurrentUser).mockResolvedValue({
      user: null,
    } as any);
    vi.mocked(FirebaseAuthentication.getIdToken).mockResolvedValue({
      token: null,
    } as any);
    vi.mocked(FirebaseAuthentication.addListener).mockResolvedValue({
      remove: vi.fn(),
    } as any);
    vi.mocked(FirebaseAuthentication.confirmVerificationCode).mockResolvedValue({} as any);
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockResolvedValue(undefined as any);
    vi.mocked(FirebaseAuthentication.unlink).mockResolvedValue({ user: null } as any);
    vi.mocked(HushhAuth.getCurrentUser).mockResolvedValue({ user: null } as any);
    vi.mocked(HushhAuth.getIdToken).mockResolvedValue({ idToken: null } as any);
  });

  it("restores a native session from HushhAuth when FirebaseAuthentication has no current user", async () => {
    const keychainToken = createIdToken(60 * 60);
    vi.mocked(HushhAuth.getCurrentUser).mockResolvedValue({
      user: {
        uid: "ios-apple-user",
        email: "kai@hushh.ai",
        displayName: "Kai",
        photoUrl: "https://example.com/kai.png",
        emailVerified: true,
      },
    } as any);
    vi.mocked(HushhAuth.getIdToken).mockResolvedValue({
      idToken: keychainToken,
    } as any);
    vi.mocked(FirebaseAuthentication.getIdToken).mockRejectedValue(
      new Error("firebase token unavailable")
    );

    const restoredUser = await AuthService.restoreNativeSession();

    expect(restoredUser?.uid).toBe("ios-apple-user");
    await expect(restoredUser?.getIdToken()).resolves.toBe(keychainToken);
  });

  it("uses a live native token provider for restored users instead of a frozen launch token", async () => {
    const launchToken = createIdToken(60 * 60);
    const freshToken = createIdToken(2 * 60 * 60);
    vi.mocked(FirebaseAuthentication.getCurrentUser).mockResolvedValue({
      user: {
        uid: "ios-google-user",
        email: "kai@hushh.ai",
        displayName: "Kai",
        photoUrl: "https://example.com/kai.png",
        emailVerified: true,
        phoneNumber: "+16505550101",
      },
    } as any);
    vi.mocked(FirebaseAuthentication.getIdToken)
      .mockResolvedValueOnce({ token: launchToken } as any)
      .mockResolvedValueOnce({ token: freshToken } as any);

    const restoredUser = await AuthService.restoreNativeSession();

    expect(restoredUser?.uid).toBe("ios-google-user");
    expect(restoredUser?.phoneNumber).toBe("+16505550101");
    await expect(restoredUser?.getIdToken(true)).resolves.toBe(freshToken);
  });

  it("does not restore a cached native user when the fallback token is missing or stale", async () => {
    vi.mocked(HushhAuth.getCurrentUser).mockResolvedValue({
      user: {
        uid: "ios-stale-user",
        email: "kai@hushh.ai",
        displayName: "Kai",
        photoUrl: "https://example.com/kai.png",
        emailVerified: true,
      },
    } as any);
    vi.mocked(HushhAuth.getIdToken).mockResolvedValue({
      idToken:
        "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwLCJzdWIiOiJpb3Mtc3RhbGUtdXNlciJ9.signature",
    } as any);

    const restoredUser = await AuthService.restoreNativeSession();

    expect(restoredUser).toBeNull();
  });

  it("starts web phone replacement verification with PhoneAuthProvider", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const verifyPhoneNumber = vi.fn().mockResolvedValue("verification-id");
    mockPhoneAuthProvider.mockImplementation(function () {
      return {
        verifyPhoneNumber,
      };
    });
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: "+16505550100",
    } as any;

    const result = await AuthService.startPhoneReplacementVerification("+16505550101", {
      recaptchaVerifier: {} as any,
    });

    expect(verifyPhoneNumber).toHaveBeenCalledWith("+16505550101", expect.any(Object));
    expect(result).toEqual({
      autoVerified: false,
      verificationId: "verification-id",
    });
  });

  it("starts web phone link verification with PhoneAuthProvider", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const verifyPhoneNumber = vi.fn().mockResolvedValue("link-verification-id");
    mockPhoneAuthProvider.mockImplementation(function () {
      return {
        verifyPhoneNumber,
      };
    });
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: null,
    } as any;

    const result = await AuthService.startPhoneLinkVerification("+16505550101", {
      recaptchaVerifier: {} as any,
    });

    expect(verifyPhoneNumber).toHaveBeenCalledWith("+16505550101", expect.any(Object));
    expect(result).toEqual({
      autoVerified: false,
      verificationId: "link-verification-id",
    });
  });

  it("normalizes Firebase SMS throttle errors during web phone verification", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const verifyPhoneNumber = vi.fn().mockRejectedValue({
      code: "auth/too-many-requests",
      message: "Firebase: Error (auth/too-many-requests).",
    });
    mockPhoneAuthProvider.mockImplementation(function () {
      return {
        verifyPhoneNumber,
      };
    });
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: null,
    } as any;

    await expect(
      AuthService.startPhoneLinkVerification("+16505550101", {
        recaptchaVerifier: {} as any,
      })
    ).rejects.toMatchObject({
      code: "too-many-requests",
      message:
        "Firebase is temporarily blocking SMS verification for this phone number or device after too many attempts. Wait before trying again, or use a different phone number.",
    });
  });

  it("links the web user phone number during link confirmation", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const reload = vi.fn().mockResolvedValue(undefined);
    const linkedUser = {
      uid: "web-user",
      phoneNumber: "+16505550101",
      reload,
    };
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: null,
    } as any;
    vi.mocked(PhoneAuthProvider.credential).mockReturnValue("phone-credential" as any);
    vi.mocked(linkWithCredential).mockResolvedValue({
      user: linkedUser,
    } as any);

    const verifiedUser = await AuthService.confirmPhoneLinkVerification({
      verificationCode: "123456",
      verificationId: "link-verification-id",
    });

    expect(PhoneAuthProvider.credential).toHaveBeenCalledWith(
      "link-verification-id",
      "123456"
    );
    expect(linkWithCredential).toHaveBeenCalledWith(mockAuth.currentUser, "phone-credential");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(verifiedUser).toBe(linkedUser);
  });

  it("updates the web user phone number during replacement confirmation", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const reload = vi.fn().mockResolvedValue(undefined);
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: "+16505550101",
      reload,
    } as any;
    vi.mocked(PhoneAuthProvider.credential).mockReturnValue("phone-credential" as any);
    vi.mocked(updatePhoneNumber).mockResolvedValue(undefined);

    const verifiedUser = await AuthService.confirmPhoneReplacementVerification({
      verificationCode: "123456",
      verificationId: "verification-id",
    });

    expect(PhoneAuthProvider.credential).toHaveBeenCalledWith("verification-id", "123456");
    expect(updatePhoneNumber).toHaveBeenCalledWith(mockAuth.currentUser, "phone-credential");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(verifiedUser).toBe(mockAuth.currentUser);
  });

  it("blocks replacing with a phone number already linked to the current user", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: "+16505550101",
    } as any;

    await expect(
      AuthService.startPhoneReplacementVerification("+16505550101", {
        recaptchaVerifier: {} as any,
      })
    ).rejects.toMatchObject({
      message: "This phone number is already linked to your account.",
      code: "phone-already-linked-to-current-user",
    });
  });
});
