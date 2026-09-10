import { describe, expect, it } from "vitest";

import { buildIosUatRuntimeEnv } from "../../scripts/native/prepare-ios-uat-archive.mjs";

describe("iOS UAT native runtime env", () => {
  it("falls back from placeholder UAT env to the canonical UAT backend and shared local Firebase config", () => {
    const env = buildIosUatRuntimeEnv({
      processEnv: {},
      uatValues: {
        NEXT_PUBLIC_BACKEND_URL: "https://consent-protocol-<uat-hash>-uc.a.run.app",
        NEXT_PUBLIC_FIREBASE_API_KEY: "replace_with_shared_firebase_api_key",
      },
      localValues: {
        NEXT_PUBLIC_BACKEND_URL: "http://localhost:8000",
        NEXT_PUBLIC_FIREBASE_API_KEY: "local-firebase-api-key",
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "hushh-pda.firebaseapp.com",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "hushh-pda",
        NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "hushh-pda.firebasestorage.app",
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1006304528804",
        NEXT_PUBLIC_FIREBASE_APP_ID: "1:1006304528804:web:test",
      },
    });

    expect(env.APP_RUNTIME_PROFILE).toBe("uat");
    expect(env.NEXT_PUBLIC_APP_ENV).toBe("uat");
    expect(env.NEXT_DIST_DIR).toBe(".next-native-uat");
    expect(env.NEXT_PUBLIC_BACKEND_URL).toBe(
      "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
    );
    expect(env.NEXT_PUBLIC_FIREBASE_API_KEY).toBe("local-firebase-api-key");
    expect(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("hushh-pda");
  });

  it("lets an explicit non-local shell backend override the default UAT backend", () => {
    const env = buildIosUatRuntimeEnv({
      processEnv: {
        NEXT_PUBLIC_BACKEND_URL: "https://consent-protocol-preview.example.run.app/",
      },
      uatValues: {},
      localValues: {},
    });

    expect(env.NEXT_PUBLIC_BACKEND_URL).toBe(
      "https://consent-protocol-preview.example.run.app",
    );
  });
});
