import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { isSettledNativeRouteAuditSurface } from "../../scripts/native/native-route-status.mjs";

export function registerNativeParityReportCases(root: string) {
  it("does not count skipped or incomplete route audits as parity evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "hushh-native-parity-"));
    try {
      const route = { route: "/one", classification: "native-required-functional", expectedMarker: "one", expectedRoute: "/one", expectedAuth: "authenticated", allowedDataStates: ["loaded"] };
      const result = { route: "/one", ok: true, observed: { ready: "1", found: "1", marker: "one", route: "/one", routeok: "1", auth: "authenticated", data: "loaded" } };
      const report = { audited_routes: 1, completed_routes: 1, audit_complete: true, failed_routes: 0, passed_routes: 1, results: [result] };
      writeFileSync(join(directory, "native-route-inventory.json"), JSON.stringify({ routes: [route] }));
      const verify = (value: unknown) => {
        writeFileSync(join(directory, "native-ios-parity-report.json"), JSON.stringify(value));
        return spawnSync(process.execPath, [join(root, "scripts/native/verify-native-parity-reports.mjs"), "--platform=ios"], { cwd: directory, encoding: "utf8" });
      };
      expect(verify(report).status).toBe(0);
      expect(verify({ ...report, results: [{ ...result, observed: { ...result.observed, routeok: "0" } }] }).status).not.toBe(0);
      expect(verify({ ...report, results: [{ ...result, observed: { ...result.observed, route: "/wrong" } }] }).status).not.toBe(0);
      expect(verify({ ...report, results: [{ ...result, skipped: true }] }).status).not.toBe(0);
      expect(verify({ ...report, audit_complete: false }).status).not.toBe(0);
      expect(verify({ ...report, completed_routes: 0 }).status).not.toBe(0);
      expect(verify({ ...report, audited_routes: 2, completed_routes: 2, passed_routes: 2, results: [result, result] }).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects incomplete route authentication or data contracts without crashing", () => {
    const directory = mkdtempSync(join(tmpdir(), "hushh-native-route-contract-"));
    try {
      const route = {
        route: "/one/welcome",
        classification: "native-required-functional",
        expectedMarker: "welcome",
        expectedRoute: "/one/welcome",
        expectedAuth: "authenticated",
        allowedDataStates: ["loaded"],
      };
      const result = {
        route: route.route,
        ok: true,
        observed: { ready: "1", found: "1", marker: "welcome", route: route.route, auth: "authenticated", data: "loaded" },
      };
      writeFileSync(join(directory, "native-ios-parity-report.json"), JSON.stringify({
        audited_routes: 1, completed_routes: 1, audit_complete: true,
        failed_routes: 0, passed_routes: 1, results: [result],
      }));
      for (const invalid of [{ ...route, expectedAuth: undefined }, { ...route, allowedDataStates: undefined }]) {
        writeFileSync(join(directory, "native-route-inventory.json"), JSON.stringify({ routes: [invalid] }));
        const check = spawnSync(process.execPath, [join(root, "scripts/native/verify-native-parity-reports.mjs"), "--platform=ios"], { cwd: directory, encoding: "utf8" });
        expect(check.status).not.toBe(0);
        expect(check.stderr).toContain("incomplete auth/data contract");
        expect(check.stderr).not.toContain("TypeError");
        expect(isSettledNativeRouteAuditSurface({ ...result.observed, doc: "complete", bootstrap: "vault_unlocked" }, invalid)).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

}

export function registerNativeInventoryCases(source: (relativePath: string) => string) {
  it("classifies every standard app route in the native inventory", () => {
    const layout = JSON.parse(source("lib/navigation/app-route-layout.contract.json")) as Array<{ route: string; mode: string }>;
    const inventory = JSON.parse(source("native-route-inventory.json")) as { routes: Array<{ route: string }> };
    const classified = new Set(inventory.routes.map(entry => entry.route));
    expect(layout.filter(entry => entry.mode === "standard" && !classified.has(entry.route)).map(entry => entry.route)).toEqual([]);
  });

  it("keeps canonical Profile inventory redirects and XCTest fixtures off deleted routes", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; initialRoute?: string }>;
    };
    const uiTests = source("ios/App/AppUITests/AppUITests.swift");

    for (const route of inventory.routes.filter((entry) =>
      entry.route.startsWith("/one/profile"),
    )) {
      if (!route.initialRoute?.startsWith("/login?")) continue;
      const redirect = new URL(route.initialRoute, "https://native-test.local").searchParams.get("redirect");
      expect(redirect).toMatch(/^\/one\/profile/);
    }
    expect(uiTests).not.toContain('redirect: "/profile');
    expect(uiTests).not.toContain('redirect=%2Fprofile');
  });

}
