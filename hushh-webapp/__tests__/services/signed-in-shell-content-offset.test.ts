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
    expect(result.style["--page-top-start"]).toBe("32px");
    expect(result.style["--app-top-mask-tail-clearance"]).toBe(
      "calc(var(--page-top-start) + var(--page-top-local-offset, 0px))"
    );
    expect(result.style["--app-top-content-offset"]).toBe(
      "calc(var(--top-shell-reserved-height) + var(--app-top-mask-tail-clearance))"
    );
  });

  it("clears the header's fade band on a fullscreen flow, not just its reserved height", () => {
    // The mask is solid to --top-shell-reserved-height and then dissolves over
    // --top-fade-active. A flow that started at the reserved height put its
    // first line inside that dissolve, which is what "the header is sitting on
    // the page" looked like on every setup, claim and onboarding flow.
    const result = resolveSignedInShellContentOffset({
      shellVisible: true,
      routeLayoutMode: "flow",
      localOffset: "0px",
    });

    expect(result.mode).toBe("fullscreen-flow");
    expect(result.style["--page-top-start"]).toBe("var(--top-fade-active)");
    expect(result.style["--app-fullscreen-flow-content-offset"]).toBe(
      "calc(var(--top-shell-reserved-height) + var(--app-top-mask-tail-clearance))"
    );
    // Which resolves to exactly --top-shell-mask-visible-height. A flow must
    // never fall back to the bare reserved height again.
    expect(result.style["--page-top-start"]).not.toBe("0px");
  });

  it("keeps a per-route local offset additive on a fullscreen flow", () => {
    const result = resolveSignedInShellContentOffset({
      shellVisible: true,
      routeLayoutMode: "flow",
      localOffset: "12px",
    });

    expect(result.style["--page-top-local-offset"]).toBe("12px");
    expect(result.style["--app-top-mask-tail-clearance"]).toBe(
      "calc(var(--page-top-start) + var(--page-top-local-offset, 0px))"
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
