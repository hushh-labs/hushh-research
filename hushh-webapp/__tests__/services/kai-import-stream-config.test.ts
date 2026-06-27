import { describe, it, expect } from "vitest";
import {
  KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS,
  KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS,
} from "@/lib/services/kai-import-stream-config";

describe("kai-import-stream-config", () => {
  it("KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS has the exact value 360", () => {
    expect(KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS).toBe(360);
  });

  it("KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS equals (timeout + 60) * 1000", () => {
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBe(
      (KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS + 60) * 1000
    );
  });

  it("KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS has the exact value 420000", () => {
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBe(420000);
  });

  it("idle timeout in ms is strictly greater than the timeout expressed in ms", () => {
    expect(KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBeGreaterThan(
      KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS * 1000
    );
  });

  it("both exported constants are numbers", () => {
    expect(typeof KAI_PORTFOLIO_IMPORT_TIMEOUT_SECONDS).toBe("number");
    expect(typeof KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS).toBe("number");
  });
});