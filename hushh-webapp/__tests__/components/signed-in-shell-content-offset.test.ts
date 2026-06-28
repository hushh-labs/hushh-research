import { describe, expect, it } from "vitest";

import { resolveSignedInShellContentOffset } from "@/components/app-ui/signed-in-shell-content-offset";

describe("resolveSignedInShellContentOffset", () => {
  it("normalizes absent localOffset to zero and returns 32px page-top-start in standard mode", () => {
    const result = resolveSignedInShellContentOffset({
      shellVisible: true,
      routeLayoutMode: "standard",
    });

    expect(result.mode).toBe("standard");
    expect(result.localOffset).toBe("0px");
    expect(result.style["--page-top-start"]).toBe("32px");
  });
});