import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  native: true,
  auth: { currentUser: null },
  nativeSignIn: vi.fn(), nativeIdToken: vi.fn(), webSignIn: vi.fn(), persistence: vi.fn(),
}));
vi.mock("@capacitor/core", async importOriginal => ({
  ...await importOriginal<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: () => sdk.native, getPlatform: () => sdk.native ? "ios" : "web" },
}));
vi.mock("@/lib/firebase/config", () => ({ auth: sdk.auth, app: {} }));
vi.mock("@capacitor-firebase/authentication", () => ({
  FirebaseAuthentication: { signInWithCustomToken: sdk.nativeSignIn, getIdToken: sdk.nativeIdToken }, ProviderId: {},
}));
vi.mock("firebase/auth", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/auth")>(),
  signInWithCustomToken: sdk.webSignIn, setPersistence: sdk.persistence,
}));
import { inMemoryPersistence } from "firebase/auth";
import { AuthService } from "@/lib/services/auth-service";
import { signInOperatorReviewer } from "@/lib/testing/reviewer-operator-auth";

describe("custom-token authentication compatibility and custody", () => {
  beforeEach(() => { vi.clearAllMocks(); sdk.native = true; });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("preserves native Firebase sign-in through the existing AuthService facade", async () => {
    sdk.nativeSignIn.mockResolvedValue({ user: { uid: "reviewer-user", email: "reviewer@example.com", displayName: "Reviewer", emailVerified: true } });
    sdk.nativeIdToken.mockResolvedValue({ token: "native-id-token" });
    const result = await AuthService.signInWithCustomToken("synthetic-token");
    expect(sdk.nativeSignIn).toHaveBeenCalledWith({ token: "synthetic-token" });
    expect(result.user.uid).toBe("reviewer-user"); expect(result.idToken).toBe("native-id-token");
  });

  it("establishes memory persistence before Firebase exchange and refuses native use of that option", async () => {
    sdk.native = false;
    sdk.webSignIn.mockResolvedValue({ user: { uid: "reviewer", getIdToken: async () => "synthetic-identity" } });
    await AuthService.signInWithCustomToken("synthetic-proof", { memoryOnly: true });
    expect(sdk.persistence).toHaveBeenCalledWith(sdk.auth, inMemoryPersistence);
    expect(sdk.persistence.mock.invocationCallOrder[0]).toBeLessThan(sdk.webSignIn.mock.invocationCallOrder[0]);
    sdk.native = true;
    await expect(AuthService.signInWithCustomToken("synthetic-proof", { memoryOnly: true })).rejects.toThrow("requires web");
    expect(sdk.nativeSignIn).not.toHaveBeenCalled();
  });

  it("uses real Firebase only for the explicit owner-bound nonproduction web context", async () => {
    sdk.native = false;
    const issue = vi.fn(async () => "synthetic-proof");
    const windowState = { location: { origin: "https://synthetic.example" }, __HUSHH_NATIVE_TEST__: { requestOperatorReviewerToken: issue } };
    vi.stubGlobal("window", windowState);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://synthetic.example"); vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    sdk.webSignIn.mockResolvedValue({ user: { uid: "reviewer", getIdToken: async () => "synthetic-identity" } });
    const config = { enabled: true, autoReviewerLogin: true, reviewerAuthMode: "operator_issued_token" as const,
      expectedUserId: "reviewer", vaultPassphrase: null, expectedMarker: null, initialRoute: null, expectedRoute: null };
    await expect(signInOperatorReviewer(config)).resolves.toMatchObject({ user: { uid: "reviewer" } });
    expect(issue).toHaveBeenCalledWith("reviewer");
    expect(sdk.persistence).toHaveBeenCalledWith(sdk.auth, inMemoryPersistence);
    for (const [environment, origin, native] of [["production", "https://synthetic.example", false], ["uat", "https://foreign.example", false], ["uat", "https://synthetic.example", true]] as const) {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment); windowState.location.origin = origin; sdk.native = native;
      await expect(signInOperatorReviewer(config)).rejects.toThrow("context refused");
    }
    expect(issue).toHaveBeenCalledOnce();
  });
});
