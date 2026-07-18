import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the `ROUTES.KAI_ANALYSIS` branch inside
 * `resolveTopShellBreadcrumb`.
 *
 * Truth: the branch reads four search params in order and chooses the first
 * matching sub-branch:
 *
 *   1. debate_id (truthy)           → "<TICKER> run"  / "Saved run"
 *   2. focus === "active" || run_id → "<TICKER> live" / "Active run"
 *   3. ticker (truthy)              → "<TICKER> preview"
 *   4. (none)                       → base ["One", "Kai", "Analysis"]
 *
 * The ticker is always transformed via
 *   `String(searchParams?.get("ticker") || "").trim().toUpperCase()`
 * which guarantees:
 *   - lowercase input is upper-cased
 *   - whitespace-only input collapses to "" (falsy)
 *   - null/missing input collapses to "" (falsy)
 *
 * Priority guarantee: debate_id is checked before focus/run_id, so
 * debate_id wins even when focus=active is also present.
 */
describe("resolveTopShellBreadcrumb — KAI_ANALYSIS debate_id precedence", () => {
  it("debate_id + lowercase ticker → '<TICKER> run' (uppercased)", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("debate_id=d1&ticker=aapl"),
    );
    expect(result).toEqual({
      backHref: ROUTES.KAI_ANALYSIS,
      width: "content",
      align: "center",
      items: [
        { label: "Kai", href: ROUTES.KAI_HOME },
        { label: "Analysis", href: ROUTES.KAI_ANALYSIS },
        { label: "AAPL run" },
      ],
    });
  });

  it("debate_id with no ticker → 'Saved run'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("debate_id=d1"),
    );
    expect(result?.items[2]).toEqual({ label: "Saved run" });
    expect(result?.backHref).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("debate_id wins over focus=active — produces 'run' label, not 'live'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("debate_id=d1&focus=active&ticker=nvda"),
    );
    expect(result?.items[2]).toEqual({ label: "NVDA run" });
  });

  it("debate_id wins over run_id — produces 'run' label, not 'live'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("debate_id=d1&run_id=r1&ticker=tsla"),
    );
    expect(result?.items[2]).toEqual({ label: "TSLA run" });
  });

  it("run_id + ticker → '<TICKER> live'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("run_id=r1&ticker=tsla"),
    );
    expect(result?.items[2]).toEqual({ label: "TSLA live" });
    expect(result?.backHref).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("focus=active + ticker → '<TICKER> live'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("focus=active&ticker=msft"),
    );
    expect(result?.items[2]).toEqual({ label: "MSFT live" });
  });

  it("focus=active with no ticker → 'Active run'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("focus=active"),
    );
    expect(result?.items[2]).toEqual({ label: "Active run" });
  });

  it("run_id with no ticker → 'Active run'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("run_id=r42"),
    );
    expect(result?.items[2]).toEqual({ label: "Active run" });
  });

  it("ticker only (no debate_id / run_id / focus) → '<TICKER> preview'", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("ticker=nvda"),
    );
    expect(result?.items[2]).toEqual({ label: "NVDA preview" });
    expect(result?.backHref).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("ticker is uppercased via String().trim().toUpperCase()", () => {
    const result = resolveTopShellBreadcrumb(
      ROUTES.KAI_ANALYSIS,
      new URLSearchParams("ticker=nvda"),
    );
    expect(result?.items[2]).toEqual({ label: "NVDA preview" });
  });

  it("no params → base breadcrumb with backHref pointing to KAI_HOME", () => {
    const result = resolveTopShellBreadcrumb(ROUTES.KAI_ANALYSIS);
    expect(result).toEqual({
      backHref: ROUTES.KAI_HOME,
      width: "content",
      align: "center",
      items: [
        { label: "One", href: ROUTES.ONE_HOME },
        { label: "Kai", href: ROUTES.KAI_HOME },
        { label: "Analysis" },
      ],
    });
  });
});