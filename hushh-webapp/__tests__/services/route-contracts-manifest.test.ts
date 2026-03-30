import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type RouteContractsManifest = {
  contracts: Array<{
    id: string;
    backend?: {
      paths?: string[];
    };
  }>;
  pageContracts?: Array<{
    id: string;
    serviceFiles?: string[];
  }>;
};

function readJson(relativePath: string) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as RouteContractsManifest;
}

function extractBackendContractPaths(relativePath: string): string[] {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const source = readFileSync(absolutePath, "utf8");
  const match = source.match(/ROUTE_CONTRACT_PATHS\s*=\s*\[(?<body>[\s\S]*?)\]/m);
  if (!match?.groups?.body) {
    throw new Error(`Unable to find ROUTE_CONTRACT_PATHS in ${relativePath}`);
  }

  return Array.from(match.groups.body.matchAll(/["']([^"']+)["']/g)).map((entry) => entry[1]);
}

describe("route-contracts manifest", () => {
  it("keeps kaiProxy backend inventory aligned with backend-declared contract paths", () => {
    const manifest = readJson("route-contracts.json");
    const kaiProxy = manifest.contracts.find((contract) => contract.id === "kaiProxy");

    expect(kaiProxy?.backend?.paths).toEqual(
      extractBackendContractPaths("../consent-protocol/api/routes/kai/__init__.py")
    );
  });

  it("tracks both Gmail and support services for the profile page contract inventory", () => {
    const manifest = readJson("route-contracts.json");
    const profilePage = manifest.pageContracts?.find((page) => page.id === "profilePage");

    expect(profilePage?.serviceFiles).toEqual(
      expect.arrayContaining([
        "hushh-webapp/lib/services/gmail-receipts-service.ts",
        "hushh-webapp/lib/services/support-service.ts",
      ])
    );
  });
});
