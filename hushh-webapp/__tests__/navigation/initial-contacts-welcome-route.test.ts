import { describe, expect, it } from "vitest";
import { buildInitialContactsWelcomeRoute, initialContactsWelcomeDestination } from "@/lib/navigation/routes";

describe("initial welcome destination", () => {
  it.each(["/finance?tab=portfolio", "/one/setup/finance/import?return_to=%2Ffinance", "/one/setup/finance", "/one/setup/finance/import/?return_to=%2Ffinance", "/one/setup/finance/index.html", "/one/setup/finance/import/index.html?return_to=%2Ffinance", "/circle/join?code=ABCD2345"])("preserves %s", (route) => {
    expect(initialContactsWelcomeDestination(route)).toBe(route);
    expect(new URL(buildInitialContactsWelcomeRoute(route), "https://one.example.test").searchParams.get("return_to")).toBe(route);
  });
  it.each(["/one/welcome", "/one/welcome/", "/one/welcome/index.html?return_to=%2Ffinance", "/one/setup", "/one/setup/index.html", "//external.example", "/\\external.example", "https://external.example"])("rejects unsafe or looping destination %s", (route) => {
    expect(initialContactsWelcomeDestination(route)).toBe("/");
  });
});
