import { describe, expect, it } from "vitest";

import {
  resolveTopShellBreadcrumb,
  visibleTopShellBreadcrumbItems,
} from "@/lib/navigation/top-shell-breadcrumbs";

describe("Memory top shell breadcrumb", () => {
  it("titles the root beside shared Back and preserves nested parents", () => {
    const root = resolveTopShellBreadcrumb("/one/pkm");
    expect(root).toMatchObject({
      backHref: "/one",
      width: "profile",
      align: "center",
      suppressFallbackTitle: true,
      items: [{ label: "One", href: "/one" }, { label: "Memory" }],
    });
    expect(visibleTopShellBreadcrumbItems(root?.items ?? []).map(item => item.label)).toEqual(["Memory"]);
    expect(resolveTopShellBreadcrumb("/one/pkm/location")?.items?.at(-1)?.label).toBe("Location");
  });
});
