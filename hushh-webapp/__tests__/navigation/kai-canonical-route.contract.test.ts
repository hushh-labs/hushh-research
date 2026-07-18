import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

describe("One-owned Finance route contract", () => {
  it("keeps the canonical One route reachable and preserves a legacy tab on redirect", () => {
    const canonical = proxy(
      new NextRequest("http://localhost:3000/one/kai?tab=portfolio"),
    );
    expect(canonical.headers.get("location")).toBeNull();

    const legacy = proxy(
      new NextRequest("http://localhost:3000/kai?tab=portfolio"),
    );
    expect(legacy.headers.get("location")).toBe(
      "http://localhost:3000/one/kai?tab=portfolio",
    );
  });
});
