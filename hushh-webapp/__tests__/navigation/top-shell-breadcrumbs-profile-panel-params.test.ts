import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

describe("resolveTopShellBreadcrumb profile panel remapping", () => {
  it("remaps tab=privacy to the access panel", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("tab=privacy"),
    );

    expect(result).not.toBeNull();
    expect(result!.items[1].label).toBe("Access & sharing");
  });

  it("uses profile breadcrumb defaults when no detail is present", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("tab=privacy"),
    );

    expect(result).not.toBeNull();
    expect(result!.backHref).toBe(ROUTES.PROFILE);
    expect(result!.items[1].href).toBeUndefined();
  });

  it("prefers panel over tab when both are present", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("panel=security&tab=privacy"),
    );

    expect(result).not.toBeNull();
    expect(result!.items[1].label).toBe("Security");
  });

  it("passes through non-privacy tab values", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.PROFILE,
      new URLSearchParams("tab=account"),
    );

    expect(result).not.toBeNull();
    expect(result!.items[1].label).toBe("Account");
  });

  it("returns null for unrecognized tab values", () => {
    expect(
      resolveTopShellBreadcrumb(
        ROUTES.PROFILE,
        new URLSearchParams("tab=something"),
      ),
    ).toBeNull();
  });
});