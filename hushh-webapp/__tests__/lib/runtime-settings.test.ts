import { afterEach, describe, expect, it } from "vitest";

import { resolveRuntimeBackendUrl } from "@/lib/runtime/settings";

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

  it("prefers BACKEND_URL over NEXT_PUBLIC_BACKEND_URL", () => {
  process.env.BACKEND_URL = "https://internal.example.com";
  process.env.NEXT_PUBLIC_BACKEND_URL = "https://public.example.com";

  expect(resolveRuntimeBackendUrl()).toBe(
    "https://internal.example.com"
  );
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
