import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockFirebaseAuthentication, mockHushhAuth } = vi.hoisted(() => ({
  mockAuth: {
    currentUser: null as any,
    onAuthStateChanged: vi.fn(),
  },
  mockFirebaseAuthentication: {
    getCurrentUser: vi.fn(),
    getIdToken: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
  },
  mockHushhAuth: {
    getCurrentUser: vi.fn(),
    getIdToken: vi.fn(),
    signOut: vi.fn(),
    signInWithApple: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
  },
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
  signInWithCredential: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
}));

vi.mock("@capacitor-firebase/authentication", () => ({
  FirebaseAuthentication: mockFirebaseAuthentication,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhAuth: mockHushhAuth,
}));

import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
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
    mockAuth.currentUser = null;
    mockAuth.onAuthStateChanged.mockReset();
    vi.mocked(FirebaseAuthentication.getCurrentUser).mockResolvedValue({
      user: null,
    } as any);
    vi.mocked(FirebaseAuthentication.getIdToken).mockResolvedValue({
      token: null,
    } as any);
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
      },
    } as any);
    vi.mocked(FirebaseAuthentication.getIdToken)
      .mockResolvedValueOnce({ token: launchToken } as any)
      .mockResolvedValueOnce({ token: freshToken } as any);

    const restoredUser = await AuthService.restoreNativeSession();

    expect(restoredUser?.uid).toBe("ios-google-user");
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
});
