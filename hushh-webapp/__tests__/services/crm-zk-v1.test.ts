import { describe, expect, it } from "vitest";

import { canonicalCrmZkJson } from "@/lib/connected-systems/crm-zk-v1";

describe("crm-zk.v1 canonical JSON", () => {
  it("matches the backend's sorted compact ASCII form", () => {
    expect(canonicalCrmZkJson({ z: "é", a: [2, 1] })).toBe(
      '{"a":[2,1],"z":"\\u00e9"}'
    );
  });

  it("rejects non-portable numeric metadata", () => {
    expect(() => canonicalCrmZkJson({ expiresAtMs: 1.5 })).toThrow(
      "safe integer"
    );
  });
});
