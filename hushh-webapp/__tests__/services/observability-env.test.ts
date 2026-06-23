import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-env", () => ({
  resolveAppEnvironment: vi.fn(),
}));

import { resolveAppEnvironment } from "@/lib/app-env";
import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
  resolveObservabilityEnvironment,
  resolveObservabilitySampleRate,
  isObservabilityEnabled,
} from "@/lib/observability/env";

const ENV_KEYS = [
  "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
  "NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE",
  "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
  "NEXT_PUBLIC_GTM_ID",
] as const;

let originalEnv: Record<string, string | undefined>;

describe("observability env resolution", () => {
  beforeEach(() => {
    originalEnv = {};

    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }

    vi.mocked(resolveAppEnvironment).mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe("resolveObservabilityEnvironment", () => {
    it("returns production when app environment is production", () => {
      vi.mocked(resolveAppEnvironment).mockReturnValue("production");

      expect(resolveObservabilityEnvironment()).toBe("production");
    });

    it("falls back to uat outside production", () => {
      vi.mocked(resolveAppEnvironment).mockReturnValue("development");

      expect(resolveObservabilityEnvironment()).toBe("uat");
    });
  });

  describe("isObservabilityEnabled", () => {
    it("defaults to enabled", () => {
      expect(isObservabilityEnabled()).toBe(true);
    });

    it.each(["0", "false", "no", "off"])(
      "disables observability for %s",
      (value) => {
        process.env.NEXT_PUBLIC_OBSERVABILITY_ENABLED = value;

        expect(isObservabilityEnabled()).toBe(false);
      },
    );
  });

  describe("resolveObservabilitySampleRate", () => {
    it("defaults to 1 when unset", () => {
      expect(resolveObservabilitySampleRate()).toBe(1);
    });

    it("clamps values above 1", () => {
      process.env.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE = "5";

      expect(resolveObservabilitySampleRate()).toBe(1);
    });

    it("clamps values below 0", () => {
      process.env.NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE = "-2";

      expect(resolveObservabilitySampleRate()).toBe(0);
    });
  });

  describe("resolveAnalyticsMeasurementId", () => {
    it("returns empty string when unset", () => {
      expect(resolveAnalyticsMeasurementId()).toBe("");
    });

    it("returns valid measurement ids unchanged", () => {
      process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID = "G-ABC123XYZ";

      expect(resolveAnalyticsMeasurementId()).toBe("G-ABC123XYZ");
    });

    it("rejects placeholder values", () => {
      process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID =
        "REPLACE_WITH_MEASUREMENT_ID";

      expect(resolveAnalyticsMeasurementId()).toBe("");
    });
  });

  describe("resolveGtmContainerId", () => {
    it("returns empty string when unset", () => {
      expect(resolveGtmContainerId()).toBe("");
    });

    it("returns valid container ids unchanged", () => {
      process.env.NEXT_PUBLIC_GTM_ID = "GTM-ABC1234";

      expect(resolveGtmContainerId()).toBe("GTM-ABC1234");
    });

    it("rejects placeholder values", () => {
      process.env.NEXT_PUBLIC_GTM_ID = "REPLACE_WITH_GTM_ID";

      expect(resolveGtmContainerId()).toBe("");
    });
  });
});