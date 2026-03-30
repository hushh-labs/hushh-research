import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const webappRoot = path.resolve(__dirname, "../..");

function readJson(relPath: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(webappRoot, relPath), "utf8")
  );
}

interface RouteContractEntry {
  route: string;
  mode: string;
  exemptionReason?: string;
  shellVerification?: {
    file: string;
    includes: string[];
  };
}

interface ParityRegistry {
  version: number;
  nativeSupportedPageContractIds: string[];
  webOnlyExemptPageContractIds: string[];
  acceptedParityExceptions: string[];
  browserCompat: Record<string, unknown>;
}

describe("Capacitor static export contract", () => {
  const registry = readJson("mobile-parity-registry.json") as ParityRegistry;
  const routeContract = readJson(
    "lib/navigation/app-route-layout.contract.json"
  ) as RouteContractEntry[];

  const nativeIds = registry.nativeSupportedPageContractIds;
  const webOnlyIds = registry.webOnlyExemptPageContractIds;
  const contractRoutes = routeContract.map((e) => e.route);

  // Helper: convert camelCase page ID to a route hint
  // e.g. "kaiDashboardPage" -> "kai/dashboard"
  function idToRouteHint(id: string): string {
    const stripped = id.replace(/Page$/, "");
    return stripped
      .replace(/([A-Z])/g, "/$1")
      .toLowerCase()
      .replace(/^\//, "");
  }

  it("every nativeSupportedPageContractId maps to a route in the layout contract", () => {
    const unmapped: string[] = [];

    for (const id of nativeIds) {
      const hint = idToRouteHint(id);
      const firstSeg = hint.split("/")[0];

      // Check if any contract route relates to this page ID
      const match = contractRoutes.some((route) => {
        const normalized = route.replace(/^\//, "").toLowerCase();
        return (
          normalized.includes(hint) ||
          hint.includes(normalized.replace(/\//g, "")) ||
          route.toLowerCase().startsWith("/" + firstSeg) ||
          route === "/"
        );
      });

      if (!match) {
        unmapped.push(id);
      }
    }

    expect(
      unmapped,
      `Unmapped native IDs: ${unmapped.join(", ")}`
    ).toHaveLength(0);
  });

  it("no webOnlyExemptPageContractIds appear in native-supported list", () => {
    const overlap = webOnlyIds.filter((id) => nativeIds.includes(id));
    expect(
      overlap,
      `IDs present in both web-only and native lists: ${overlap.join(", ")}`
    ).toHaveLength(0);
  });

  it("native-supported pages do not import next/headers", () => {
    const violations: string[] = [];

    // Build possible page.tsx paths from the route contract
    for (const entry of routeContract) {
      const routePath =
        entry.route === "/" ? "" : entry.route;
      const pagePath = path.join(webappRoot, "app", routePath, "page.tsx");

      if (!fs.existsSync(pagePath)) continue;

      // Check if this route corresponds to any native-supported page ID
      const routeLower = entry.route.replace(/\//g, "").toLowerCase();
      const isNativeRoute = nativeIds.some((id) => {
        const hint = idToRouteHint(id);
        const firstSeg = hint.split("/")[0];
        return (
          routeLower.includes(hint.replace(/\//g, "")) ||
          hint.replace(/\//g, "").includes(routeLower) ||
          entry.route.toLowerCase().startsWith("/" + firstSeg) ||
          (id === "homePage" && entry.route === "/")
        );
      });

      if (!isNativeRoute) continue;

      const content = fs.readFileSync(pagePath, "utf8");
      if (
        content.includes('from "next/headers"') ||
        content.includes("from 'next/headers'")
      ) {
        violations.push(pagePath);
      }
    }

    expect(
      violations,
      `Pages importing next/headers (server-only, breaks native): ${violations.join(", ")}`
    ).toHaveLength(0);
  });
});
