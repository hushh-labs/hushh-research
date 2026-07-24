import { deepMerge, mergeMany } from "@/lib/utils/merge";

describe("merge utils", () => {
  it("deep merges nested plain objects", () => {
    expect(
      deepMerge(
        {
          profile: {
            name: "Ari",
            contact: { email: "ari@example.com", phone: "111" },
          },
        },
        {
          profile: {
            contact: { phone: "222" },
            preferences: { newsletter: true },
          },
        }
      )
    ).toEqual({
      profile: {
        name: "Ari",
        contact: { email: "ari@example.com", phone: "222" },
        preferences: { newsletter: true },
      },
    });
  });

  it("replaces arrays and primitive values", () => {
    expect(
      deepMerge(
        { scopes: ["profile:read"], retries: 1, enabled: true },
        { scopes: ["profile:write"], retries: 2, enabled: false }
      )
    ).toEqual({
      scopes: ["profile:write"],
      retries: 2,
      enabled: false,
    });
  });

  it("preserves explicit null and undefined overrides", () => {
    const merged = deepMerge(
      { profile: { name: "Ari" }, expiresAt: "2026-05-16" },
      { profile: null, expiresAt: undefined }
    );

    expect(merged).toEqual({ profile: null, expiresAt: undefined });
    expect(Object.prototype.hasOwnProperty.call(merged, "expiresAt")).toBe(true);
  });

  it("merges many objects from left to right", () => {
    expect(
      mergeMany(
        { profile: { name: "Ari", status: "pending" } },
        { profile: { status: "active" } },
        { audit: { source: "pkm" } }
      )
    ).toEqual({
      profile: { name: "Ari", status: "active" },
      audit: { source: "pkm" },
    });
  });
});
