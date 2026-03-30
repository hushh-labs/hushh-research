import { describe, expect, it } from "vitest";

import { resolveSignedInShellContentOffset } from "@/components/app-ui/signed-in-shell-content-offset";

describe("resolveSignedInShellContentOffset", () => {
  it("keeps page-top-start as the direct body gap token for standard routes", () => {
    const result = resolveSignedInShellContentOffset({
      shellVisible: true,
      routeLayoutMode: "standard",
      localOffset: "0px",
    });

    expect(result.mode).toBe("standard");
    expect(result.style["--page-top-start"]).toBe("75px");
    expect(result.style["--app-top-mask-tail-clearance"]).toBe(
      "calc(var(--page-top-start) + var(--page-top-local-offset, 0px))"
    );
    expect(result.style["--app-top-content-offset"]).toBe(
      "calc(var(--top-shell-reserved-height) + var(--app-top-mask-tail-clearance))"
    );
  });

  it("zeroes the standard spacer when the shell is hidden", () => {
    const result = resolveSignedInShellContentOffset({
      shellVisible: false,
      routeLayoutMode: "standard",
      localOffset: "0px",
    });

    expect(result.mode).toBe("hidden-shell");
    expect(result.style["--page-top-start"]).toBe("0px");
    expect(result.style["--app-top-content-offset"]).toBe("0px");
  });
});
