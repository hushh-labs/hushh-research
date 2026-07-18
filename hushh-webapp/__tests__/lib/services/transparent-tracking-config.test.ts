import { describe, expect, it } from "vitest";

/**
 * Characterization: transparent tracking config object isolation.
 *
 * Verified repo truth (truth-first)
 * ---------------------------------
 * The public tracking setup path normalizes every analytics payload through
 * `validateAndSanitizeEvent(eventName, payload)` in
 * `hushh-webapp/lib/observability/schema.ts` before any adapter is invoked
 * (see `trackEvent` in `lib/observability/client.ts`). That function is the
 * "transparent data tracking" config coercion gate. Given an event name and a
 * config-like options object, it returns:
 *   - `sanitized`: only the allow-listed primitive fields for that event
 *     (the valid tracks),
 *   - `droppedKeys`: every key that is unknown for the event, denylisted as
 *     sensitive (PII/secret patterns), non-primitive, or an opaque/email-like
 *     value (the missing/rejected entities),
 *   - `ok`: true only when nothing was dropped.
 *
 * The normalization rules pinned here, read directly from source:
 *   1. Keys not in `EVENT_ALLOWED_KEYS[eventName]` → dropped.
 *   2. Keys matching `DENYLIST_KEY_REGEX` (user/uid/email/token/symbol/amount…)
 *      → dropped, except the explicitly preserved `route_id`.
 *   3. Non-primitive values (objects, arrays, undefined) → dropped, so an
 *      array passed as an option value is treated as a missing entity.
 *   4. Primitive-but-sensitive string values (email-shaped, or opaque
 *      high-entropy IDs of length >= 24 matching `[A-Za-z0-9_-]`) → dropped.
 *   5. `null`, finite numbers, booleans, and short plain strings on allowed
 *      keys → retained verbatim.
 *
 * No source is modified; this only documents existing behavior. The file lives
 * at the requested `__tests__/lib/services/` path even though the unit under
 * test is `lib/observability/schema.ts`.
 */

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("validateAndSanitizeEvent · transparent tracking config isolation", () => {
  it("retains the allow-listed valid tracks for a known event and reports ok", () => {
    const result = validateAndSanitizeEvent("page_view", {
      env: "production",
      platform: "web",
      event_category: "navigation",
      app_version: "1.2.3",
      route_id: "dashboard",
      nav_type: "route_change",
    } as never);

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized).toMatchObject({
      env: "production",
      platform: "web",
      route_id: "dashboard",
      nav_type: "route_change",
    });
  });

  it("separates unknown config keys into droppedKeys while keeping valid ones", () => {
    const result = validateAndSanitizeEvent("page_view", {
      env: "production",
      platform: "web",
      nav_type: "initial_load",
      // Unexpected configuration entries — not part of page_view's contract.
      totally_unknown_option: "x",
      another_bogus_field: 42,
    } as never);

    expect(result.ok).toBe(false);
    expect(result.sanitized).toHaveProperty("nav_type", "initial_load");
    expect(result.sanitized).not.toHaveProperty("totally_unknown_option");
    expect(result.droppedKeys).toEqual(
      expect.arrayContaining(["totally_unknown_option", "another_bogus_field"])
    );
  });

  it("drops array-valued options as missing entities (non-primitive coercion)", () => {
    const result = validateAndSanitizeEvent("page_view", {
      env: "production",
      platform: "web",
      // An array fed into an otherwise-allowed slot is not a primitive track.
      nav_type: ["route_change", "redirect"],
    } as never);

    expect(result.sanitized).not.toHaveProperty("nav_type");
    expect(result.droppedKeys).toContain("nav_type");
  });

  it("drops nested-object options as missing entities", () => {
    const result = validateAndSanitizeEvent("page_view", {
      env: "production",
      platform: { nested: "web" },
      nav_type: "route_change",
    } as never);

    expect(result.sanitized).not.toHaveProperty("platform");
    expect(result.droppedKeys).toContain("platform");
    // The sibling valid track is still isolated and preserved.
    expect(result.sanitized).toHaveProperty("nav_type", "route_change");
  });

  it("drops denylisted sensitive keys but preserves the whitelisted route_id", () => {
    const result = validateAndSanitizeEvent("page_view", {
      env: "production",
      route_id: "settings",
      // Denylisted key families per DENYLIST_KEY_REGEX.
      user_id: "should-drop",
      email: "person@example.com",
      auth_token: "should-drop",
    } as never);

    expect(result.sanitized).toHaveProperty("route_id", "settings");
    expect(result.sanitized).not.toHaveProperty("user_id");
    expect(result.sanitized).not.toHaveProperty("email");
    expect(result.sanitized).not.toHaveProperty("auth_token");
    expect(result.droppedKeys).toEqual(
      expect.arrayContaining(["user_id", "email", "auth_token"])
    );
  });

  it("drops email-shaped and opaque high-entropy string values on allowed keys", () => {
    const result = validateAndSanitizeEvent("auth_failed", {
      env: "production",
      platform: "web",
      action: "person@example.com", // email-shaped value
      error_class: "abcdefghijklmnopqrstuvwxyz0123", // >=24 opaque token
      result: "error", // clean short string survives
    } as never);

    expect(result.sanitized).toHaveProperty("result", "error");
    expect(result.sanitized).not.toHaveProperty("action");
    expect(result.sanitized).not.toHaveProperty("error_class");
    expect(result.droppedKeys).toEqual(
      expect.arrayContaining(["action", "error_class"])
    );
  });

  it("retains null, numeric, and boolean primitives on allowed keys", () => {
    const result = validateAndSanitizeEvent("route_readiness_completed", {
      env: "production",
      platform: "web",
      result: "success",
      render_path: "ssr",
      cache_tier: "warm",
      resource_class: "dashboard",
      duration_ms_bucket: "lt_100ms",
      blocking_loader_shown: false,
      stale_rendered: true,
      route_id: null,
    } as never);

    expect(result.sanitized).toHaveProperty("blocking_loader_shown", false);
    expect(result.sanitized).toHaveProperty("stale_rendered", true);
    expect(result.sanitized).toHaveProperty("route_id", null);
  });

  it("returns an empty sanitized set with no throw for a fully empty config object", () => {
    let result: ReturnType<typeof validateAndSanitizeEvent> | undefined;
    expect(() => {
      result = validateAndSanitizeEvent("page_view", {} as never);
    }).not.toThrow();
    expect(result?.sanitized).toEqual({});
    expect(result?.droppedKeys).toEqual([]);
    expect(result?.ok).toBe(true);
  });

  it("isolates each config block independently without field leakage across calls", () => {
    const first = validateAndSanitizeEvent("page_view", {
      env: "production",
      nav_type: "route_change",
      leak_probe: "first",
    } as never);
    const second = validateAndSanitizeEvent("page_view", {
      env: "staging",
      nav_type: "redirect",
    } as never);

    // The unknown key from the first call must not bleed into the second.
    expect(first.droppedKeys).toContain("leak_probe");
    expect(second.droppedKeys).not.toContain("leak_probe");
    expect(second.sanitized).toMatchObject({
      env: "staging",
      nav_type: "redirect",
    });
  });
});
