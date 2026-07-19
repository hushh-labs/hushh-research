import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

describe("legacy route redirects", () => {
  it("moves Profile paths into One without dropping query state", () => {
    const response = proxy(
      new NextRequest(
        "https://one.hushh.ai/profile/security?unlock_vault=1&return_to=%2Fone%2Flocation",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://one.hushh.ai/one/profile/security?unlock_vault=1&return_to=%2Fone%2Flocation",
    );
  });

  it("moves Connect paths into One without dropping query state", () => {
    const response = proxy(
      new NextRequest("https://one.hushh.ai/connect/settings?source=profile"),
    );

    expect(response.headers.get("location")).toBe(
      "https://one.hushh.ai/one/connect/settings?source=profile",
    );
  });
});
