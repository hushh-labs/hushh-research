import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockFirebaseAuthentication,
  mockHushhAuth,
  mockCapacitor,
  mockPhoneAuthProvider,
  mockUpdatePhoneNumber,
  mockLinkWithCredential,
  mockSignInWithCredential,
  mockFirebaseSignOut,
  mockSetPersistence,
  mockGetAuth,
  mockGetApps,
  mockInitializeApp,
  mockFirebaseApp,
  mockPhoneClaimAuth,
} = vi.hoisted(() => ({
  mockFirebaseApp: {
    name: "[DEFAULT]",
    options: {
      projectId: "demo-project",
      apiKey: "demo-key",
    },
  },
  mockPhoneClaimAuth: {
    app: {
      name: "hushh-phone-claim",
    },
  },
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
  mockSignInWithCredential: vi.fn(),
  mockFirebaseSignOut: vi.fn(),
  mockSetPersistence: vi.fn(),
  mockGetAuth: vi.fn(),
  mockGetApps: vi.fn(),
  mockInitializeApp: vi.fn(),
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
  app: mockFirebaseApp,
  auth: mockAuth,
}));

vi.mock("firebase/app", () => ({
  getApps: mockGetApps,
  initializeApp: mockInitializeApp,
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: {
    credential: vi.fn(),
    credentialFromResult: vi.fn(),
  },
  getAuth: mockGetAuth,
  inMemoryPersistence: "in-memory-persistence",
  OAuthProvider: vi.fn(),
  PhoneAuthProvider: Object.assign(mockPhoneAuthProvider, {
    credential: vi.fn(),
  }),
  linkWithCredential: mockLinkWithCredential,
  setPersistence: mockSetPersistence,
  signInWithCredential: mockSignInWithCredential,
  signInWithCustomToken: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: mockFirebaseSignOut,
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
import {
  linkWithCredential,
  onAuthStateChanged,
  PhoneAuthProvider,
  setPersistence,
  signInWithCredential,
  signOut as firebaseSignOut,
  updatePhoneNumber,
} from "firebase/auth";
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

function enableLocalDevPhoneTest() {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION", "true");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_LOCAL_TEST_PHONE", "+918080469407");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_LOCAL_TEST_CODE", "000000");
  vi.stubGlobal("window", {
    location: {
      hostname: "localhost",
      host: "localhost:3001",
    },
  });
}

describe("AuthService.restoreNativeSession", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    mockCapacitor.getPlatform.mockReturnValue("ios");
    mockAuth.currentUser = null;
    mockAuth.onAuthStateChanged.mockReset();
    mockGetApps.mockReturnValue([mockFirebaseApp] as any);
    mockInitializeApp.mockReturnValue(mockFirebaseApp as any);
    mockGetAuth.mockReturnValue(mockPhoneClaimAuth as any);
    vi.mocked(setPersistence).mockResolvedValue(undefined);
    vi.mocked(signInWithCredential).mockReset();
    vi.mocked(firebaseSignOut).mockResolvedValue(undefined);
    vi.mocked(onAuthStateChanged).mockImplementation(((_auth, next) => {
      next(null);
      return vi.fn();
    }) as any);
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

  it("cleans up a synchronously restored Firebase JS listener", async () => {
    const unsubscribe = vi.fn();
    const firebaseUser = {
      uid: "firebase-js-user",
      getIdToken: vi.fn(),
    } as any;
    vi.mocked(onAuthStateChanged).mockImplementation(((_auth, next) => {
      next(firebaseUser);
      return unsubscribe;
    }) as any);

    const restoredUser = await AuthService.restoreNativeSession();

    expect(restoredUser).toBe(firebaseUser);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(FirebaseAuthentication.getCurrentUser).not.toHaveBeenCalled();
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

  it("starts local dev phone verification without calling Firebase for the configured test phone", async () => {
    enableLocalDevPhoneTest();
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const verifyPhoneNumber = vi.fn().mockResolvedValue("firebase-verification-id");
    mockPhoneAuthProvider.mockImplementation(function () {
      return {
        verifyPhoneNumber,
      };
    });
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: null,
    } as any;

    const result = await AuthService.startPhoneLinkVerification("+918080469407", {
      recaptchaVerifier: {} as any,
    });

    expect(verifyPhoneNumber).not.toHaveBeenCalled();
    expect(result).toEqual({
      autoVerified: false,
      verificationId: "local-dev-phone:%2B918080469407",
    });
  });

  it("confirms local dev phone verification with the configured OTP", async () => {
    enableLocalDevPhoneTest();
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    mockAuth.currentUser = {
      uid: "web-user",
      phoneNumber: null,
    } as any;

    const verifiedUser = await AuthService.confirmLocalDevPhoneVerification({
      verificationCode: "000000",
      verificationId: "local-dev-phone:%2B918080469407",
    });

    expect(verifiedUser).toBe(mockAuth.currentUser);
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

  it("mints a web phone claim token without linking the primary Firebase user", async () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    const getIdToken = vi.fn().mockResolvedValue("phone-claim-id-token");
    vi.mocked(PhoneAuthProvider.credential).mockReturnValue("phone-credential" as any);
    vi.mocked(signInWithCredential).mockResolvedValue({
      user: {
        getIdToken,
      },
    } as any);

    const claimToken = await AuthService.getPhoneClaimIdToken({
      verificationCode: "123456",
      verificationId: "claim-verification-id",
    });

    expect(PhoneAuthProvider.credential).toHaveBeenCalledWith(
      "claim-verification-id",
      "123456"
    );
    expect(setPersistence).toHaveBeenCalledWith(
      mockPhoneClaimAuth,
      "in-memory-persistence"
    );
    expect(signInWithCredential).toHaveBeenCalledWith(
      mockPhoneClaimAuth,
      "phone-credential"
    );
    expect(linkWithCredential).not.toHaveBeenCalled();
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(firebaseSignOut).toHaveBeenCalledWith(mockPhoneClaimAuth);
    expect(claimToken).toBe("phone-claim-id-token");
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

  it("recognizes UAT phone test verification ids without treating them as local dev ids", () => {
    expect(AuthService.isUatPhoneTestVerificationId("uat-test-phone:abc123")).toBe(true);
    expect(AuthService.isUatPhoneTestVerificationId("local-dev-phone:%2B16505550101")).toBe(false);
    expect(AuthService.isLocalDevPhoneVerificationId("uat-test-phone:abc123")).toBe(false);
  });
});
