import { describe, expect, it } from "vitest";

import {
  resolveGrowthEntrySurface,
  resolveGrowthJourneyForPath,
  resolveGrowthWorkspaceSource,
} from "@/lib/observability/growth";

describe("resolveGrowthJourneyForPath", () => {
  it("returns null for empty paths", () => {
    expect(resolveGrowthJourneyForPath("")).toBeNull();
  });

  it("resolves ria paths", () => {
    expect(resolveGrowthJourneyForPath("/ria")).toBe("ria");
  });

  it("resolves investor paths", () => {
    expect(resolveGrowthJourneyForPath("/one/kai")).toBe("investor");
  });

  it("returns null for unrelated paths", () => {
    expect(resolveGrowthJourneyForPath("/marketplace")).toBeNull();
  });
});

describe("resolveGrowthEntrySurface", () => {
  it("resolves login", () => {
    expect(resolveGrowthEntrySurface("/login")).toBe("login");
  });

  it("resolves kai onboarding", () => {
    expect(resolveGrowthEntrySurface("/one/onboarding")).toBe(
      "kai_onboarding",
    );
  });

  it("resolves kai import", () => {
    expect(resolveGrowthEntrySurface("/one/kai/import")).toBe(
      "kai_import",
    );
  });

  it("resolves kai home", () => {
    expect(resolveGrowthEntrySurface("/one/kai")).toBe(
      "kai_home",
    );
  });

  it("resolves marketplace", () => {
    expect(resolveGrowthEntrySurface("/marketplace")).toBe(
      "marketplace",
    );
  });

  it("resolves ria onboarding", () => {
    expect(resolveGrowthEntrySurface("/ria/onboarding")).toBe(
      "ria_onboarding",
    );
  });

  it("resolves ria home", () => {
    expect(resolveGrowthEntrySurface("/ria")).toBe(
      "ria_home",
    );
  });

  it("returns unknown for unmatched paths", () => {
    expect(resolveGrowthEntrySurface("/developers")).toBe(
      "unknown",
    );
  });
});

describe("resolveGrowthWorkspaceSource", () => {
  it("resolves ria workspace paths", () => {
    expect(resolveGrowthWorkspaceSource("/ria")).toBe(
      "ria_home",
    );
  });

  it("returns unknown for unrelated paths", () => {
    expect(resolveGrowthWorkspaceSource("/login")).toBe(
      "unknown",
    );
  });
});