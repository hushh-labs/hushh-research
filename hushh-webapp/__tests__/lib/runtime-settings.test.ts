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
});
