import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APP_ROUTE_LAYOUT_CONTRACT,
  resolveAppRouteLayoutMode,
} from "@/lib/navigation/app-route-layout";

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function toRoutePattern(pageFile: string): string {
  const normalized = pageFile.replace(/\\/g, "/");
  const appRelative = normalized.split("/app/")[1];
  if (!appRelative) {
    throw new Error(`Unable to normalize page file: ${pageFile}`);
  }

  const withoutPageFile = appRelative.replace(/(^|\/)page\.tsx$/, "");
  if (!withoutPageFile) return "/";
  return `/${withoutPageFile}`;
}

function listPageRoutePatterns(rootDir: string): string[] {
  const appDir = path.join(rootDir, "app");
  const pageFiles: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api") continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "page.tsx") {
        pageFiles.push(fullPath);
      }
    }
  }

  walk(appDir);
  return pageFiles.map(toRoutePattern).sort();
}

describe("app route layout contract", () => {
  it("declares every app page route exactly once", () => {
    const root = projectRoot();
    const declaredRoutes = APP_ROUTE_LAYOUT_CONTRACT.map((entry) => entry.route).sort();
    const discoveredRoutes = listPageRoutePatterns(root);

    expect(declaredRoutes).toEqual(discoveredRoutes);
  });

  it("documents either the shared shell contract or an explicit exemption for every route", () => {
    for (const entry of APP_ROUTE_LAYOUT_CONTRACT) {
      if (entry.mode === "standard") {
        expect(entry.shellVerification, `${entry.route} should declare its shared shell verification source`).toBeDefined();
        continue;
      }

      expect(
        entry.exemptionReason,
        `${entry.route} should explain why it is exempt from the standard shared shell contract`
      ).toBeTruthy();
    }
  });

  it("resolves the expected layout modes for representative paths", () => {
    expect(resolveAppRouteLayoutMode("/")).toBe("hidden");
    expect(resolveAppRouteLayoutMode("/developers")).toBe("standard");
    expect(resolveAppRouteLayoutMode("/login")).toBe("hidden");
    expect(resolveAppRouteLayoutMode("/consents")).toBe("standard");
    expect(resolveAppRouteLayoutMode("/kai")).toBe("standard");
    expect(resolveAppRouteLayoutMode("/kai/onboarding")).toBe("flow");
    expect(resolveAppRouteLayoutMode("/kai/dashboard/analysis")).toBe("redirect");
    expect(resolveAppRouteLayoutMode("/kai/plaid/oauth/return")).toBe("standard");
    expect(resolveAppRouteLayoutMode("/marketplace/ria?riaId=ria_123")).toBe("standard");
    expect(resolveAppRouteLayoutMode("/ria/workspace?clientId=user_123")).toBe("standard");
  });

  it("keeps shell verification sources aligned with the shared page shell contract", () => {
    const root = projectRoot();

    for (const entry of APP_ROUTE_LAYOUT_CONTRACT) {
      if (!entry.shellVerification) continue;

      const sourcePath = path.join(root, entry.shellVerification.file);
      const source = fs.readFileSync(sourcePath, "utf8");

      for (const needle of entry.shellVerification.includes) {
        expect(
          source,
          `${entry.route} should keep ${entry.shellVerification.file} aligned with ${needle}`
        ).toContain(needle);
      }

      if (entry.mode === "standard") {
        expect(
          entry.shellVerification.includes.some((needle) =>
            ["AppPageHeaderRegion", "AppPageContentRegion", "SurfaceStack"].includes(needle)
          ),
          `${entry.route} should verify the shared market-led page regions or surface stack contract`
        ).toBe(true);
      }
    }
  });
});
