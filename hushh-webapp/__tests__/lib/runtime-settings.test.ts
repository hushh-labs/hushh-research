import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRuntimeBackendUrl, resolveRuntimeFrontendUrl,
resolveVoiceDirectBackendPreference,
resolveVoiceForceProxyPreference,
resolveLegacyLocalTtsCompatEnabled} from "@/lib/runtime/settings";

describe("runtime settings", () => {
  const originalBackendUrl = process.env.BACKEND_URL;
  const originalPublicBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;

  afterEach(() => {
    process.env.BACKEND_URL = originalBackendUrl;
    process.env.NEXT_PUBLIC_BACKEND_URL = originalPublicBackendUrl;
  });

  it("normalizes carriage return line endings around runtime backend urls", () => {
    process.env.BACKEND_URL = "\r\nhttps://runtime.example.com///\r\n";
    process.env.NEXT_PUBLIC_BACKEND_URL = "";

    expect(resolveRuntimeBackendUrl()).toBe("https://runtime.example.com");
  });

  it("returns an empty string when runtime backend urls are empty", async () => {
    process.env.BACKEND_URL = "";
    process.env.NEXT_PUBLIC_BACKEND_URL = "   ";

    const { resolveRuntimeBackendUrl: resolveFreshRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    expect(resolveFreshRuntimeBackendUrl()).toBe("");
  });
});

describe("resolveRuntimeFrontendUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty string when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(resolveRuntimeFrontendUrl()).toBe("");
  });

  it("trims whitespace and trailing slashes", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_APP_URL",
      "  https://app.hushh.ai///  ",
    );

    expect(resolveRuntimeFrontendUrl()).toBe(
      "https://app.hushh.ai",
    );
  });
});

describe("resolveVoiceDirectBackendPreference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true for a truthy value", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_VOICE_DIRECT_BACKEND",
      "true",
    );

    expect(
      resolveVoiceDirectBackendPreference(),
    ).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_VOICE_DIRECT_BACKEND",
      "",
    );

    expect(
      resolveVoiceDirectBackendPreference(),
    ).toBe(false);
  });
});

describe("resolveVoiceForceProxyPreference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true for a truthy value", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_VOICE_FORCE_PROXY",
      "true",
    );

    expect(
      resolveVoiceForceProxyPreference(),
    ).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_VOICE_FORCE_PROXY",
      "",
    );

    expect(
      resolveVoiceForceProxyPreference(),
    ).toBe(false);
  });
});

describe("resolveLegacyLocalTtsCompatEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true for a truthy value", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_ENABLE_LEGACY_LOCAL_TTS_COMPAT",
      "true",
    );

    expect(
      resolveLegacyLocalTtsCompatEnabled(),
    ).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_ENABLE_LEGACY_LOCAL_TTS_COMPAT",
      "",
    );

    expect(
      resolveLegacyLocalTtsCompatEnabled(),
    ).toBe(false);
  });
});
