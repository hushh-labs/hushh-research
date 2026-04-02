const fs = require("node:fs");
const path = require("node:path");

const WEB_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function repoRelative(absolutePath) {
  return normalizePath(path.relative(REPO_ROOT, absolutePath));
}

function readText(repoRelativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, repoRelativePath), "utf8");
}

function readJson(repoRelativePath) {
  return JSON.parse(readText(repoRelativePath));
}

function exists(repoRelativePath) {
  return fs.existsSync(path.join(REPO_ROOT, repoRelativePath));
}

function listFiles(rootDir, predicate) {
  const output = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (predicate(full)) output.push(full);
    }
  }
  return output.sort();
}

function listPageRouteFiles() {
  const appDir = path.join(WEB_ROOT, "app");
  return listFiles(appDir, (full) => {
    const normalized = normalizePath(full);
    return normalized.endsWith("/page.tsx") && !normalized.includes("/app/api/");
  }).map(repoRelative);
}

function listApiRouteFiles() {
  const apiDir = path.join(WEB_ROOT, "app", "api");
  return listFiles(apiDir, (full) => normalizePath(full).endsWith("/route.ts")).map(repoRelative);
}

function routeFromPageFile(pageFile) {
  const prefix = "hushh-webapp/app";
  if (!pageFile.startsWith(prefix)) return null;
  const routePath = pageFile
    .slice(prefix.length)
    .replace(/\/page\.tsx$/, "")
    .replace(/\/index$/, "");
  return routePath || "/";
}

function classifyProductArea(route) {
  if (route === "/") return "home";
  const parts = route.replace(/^\//, "").split("/");
  return parts[0] || "home";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractMethods(source) {
  return unique(
    [...source.matchAll(/\b(?:static\s+)?async\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1])
  ).sort();
}

function extractApiTargets(source) {
  const targets = [];
  for (const match of source.matchAll(
    /\b(?:authFetch|ApiService\.apiFetch|fetch)\(\s*([`'"])(\/api\/[^`'"]+)\1/g
  )) {
    if (match[2].includes("...")) continue;
    const caller = match[0].split("(")[0];
    targets.push({
      caller,
      path: match[2],
      routing: caller === "fetch" ? "raw_fetch" : caller === "authFetch" ? "auth_fetch" : "api_service",
    });
  }
  return targets;
}

function extractPluginCalls(source) {
  return unique(
    [...source.matchAll(/\b(Hushh[A-Za-z]+|Kai|HushhPersonalKnowledgeModel)\.([A-Za-z0-9_]+)\s*\(/g)].map(
      (match) => `${match[1]}.${match[2]}`
    )
  ).sort();
}

function extractServiceCalls(source) {
  return unique(
    [
      ...source.matchAll(/\b(PersonalKnowledgeModelService)\.([A-Za-z0-9_]+)\s*\(/g),
      ...source.matchAll(/\b(ApiService)\.([A-Za-z0-9_]+)\s*\(/g),
    ].map((match) => `${match[1]}.${match[2]}`)
  ).sort();
}

function traceSourceFile(repoRelativePath) {
  const source = readText(repoRelativePath);
  const apiTargets = extractApiTargets(source);
  return {
    file: repoRelativePath,
    publicMethods: extractMethods(source),
    apiTargets,
    pluginCalls: extractPluginCalls(source),
    serviceCalls: extractServiceCalls(source),
    platformBranches: source.includes("Capacitor.isNativePlatform()"),
    rawApiFetch: apiTargets.some((target) => target.routing === "raw_fetch"),
  };
}

function buildApiContractSummaries(routeManifest) {
  return new Map(
    (routeManifest.contracts || []).map((contract) => [
      contract.id,
      {
        id: contract.id,
        webRouteFiles: unique([
          ...(contract.webRouteFile ? [contract.webRouteFile] : []),
          ...(contract.webRouteFiles || []),
        ]).sort(),
        backend: contract.backend || null,
        native: contract.native || null,
      },
    ])
  );
}

function buildPageContractMap(routeManifest) {
  return new Map((routeManifest.pageContracts || []).map((contract) => [contract.pageFile, contract]));
}

function readParityExceptions() {
  const repoPath = "hushh-webapp/tri-flow-parity-exceptions.json";
  if (!exists(repoPath)) {
    return { version: 1, exceptions: [] };
  }
  return readJson(repoPath);
}

function buildCapabilityMatrix() {
  const routeManifest = readJson("hushh-webapp/route-contracts.json");
  const mobileRegistry = readJson("hushh-webapp/mobile-parity-registry.json");
  const layoutContract = readJson("hushh-webapp/lib/navigation/app-route-layout.contract.json");
  const exceptions = readParityExceptions();

  const layoutByRoute = new Map(layoutContract.map((entry) => [entry.route, entry]));
  const apiContractSummaries = buildApiContractSummaries(routeManifest);
  const pageContractByFile = buildPageContractMap(routeManifest);
  const nativeSupported = new Set(mobileRegistry.nativeSupportedPageContractIds || []);
  const pageFiles = listPageRouteFiles();

  const capabilities = pageFiles.map((pageFile) => {
    const pageContract = pageContractByFile.get(pageFile) || null;
    const route = routeFromPageFile(pageFile);
    const layout = layoutByRoute.get(route) || null;
    const componentFiles = pageContract?.componentFiles || [];
    const serviceFiles = pageContract?.serviceFiles || [];
    const serviceTraces = serviceFiles.map(traceSourceFile);
    const apiContracts = (pageContract?.apiContractIds || [])
      .map((id) => apiContractSummaries.get(id))
      .filter(Boolean);
    const nativeContracts = (pageContract?.nativeContractIds || [])
      .map((id) => apiContractSummaries.get(id))
      .filter(Boolean);

    const transportModes = unique([
      nativeContracts.length > 0 ? "native_plugin" : null,
      apiContracts.length > 0 ? "backend_contract" : null,
      serviceTraces.some((trace) => trace.apiTargets.length > 0) ? "direct_backend_or_proxy" : null,
      serviceTraces.some(
        (trace) =>
          trace.pluginCalls.length > 0 ||
          trace.serviceCalls.some((call) => call.startsWith("PersonalKnowledgeModelService."))
      )
        ? "native_sdk_or_pkm_service"
        : null,
    ]);

    let parityStatus = "intentional_web_only";
    let parityClass = "web_only";
    const nativeSupportedRoute = pageContract ? nativeSupported.has(pageContract.id) : false;

    if (nativeSupportedRoute) {
      const isRouteOnly = layout?.mode === "hidden" || layout?.mode === "redirect";
      if (isRouteOnly) {
        parityStatus = "full_parity";
        parityClass = "route_only";
      } else if (transportModes.includes("native_plugin")) {
        parityStatus = "full_parity";
        parityClass = "plugin_transport";
      } else if (
        transportModes.includes("backend_contract") &&
        (transportModes.includes("direct_backend_or_proxy") ||
          transportModes.includes("native_sdk_or_pkm_service"))
      ) {
        parityStatus = "full_parity";
        parityClass = "same_capability_different_transport";
      } else if (transportModes.includes("backend_contract")) {
        parityStatus = "partial_parity";
        parityClass = "contract_without_trace";
      } else {
        parityStatus = "unsupported_gap";
        parityClass = "missing_native_or_backend_transport";
      }
    }

    return {
      capabilityId: pageContract?.id || pageFile,
      route,
      productArea: classifyProductArea(route),
      pageFile,
      layoutMode: layout?.mode || "unknown",
      layoutExemptionReason: layout?.exemptionReason || null,
      nativeSupported: nativeSupportedRoute,
      parityStatus,
      parityClass,
      componentFiles,
      serviceFiles,
      serviceTraces,
      apiContractIds: pageContract?.apiContractIds || [],
      nativeContractIds: pageContract?.nativeContractIds || [],
      apiContracts,
      nativeContracts,
      transportModes,
    };
  });

  const declaredApiRoutes = new Map();
  for (const contract of routeManifest.contracts || []) {
    for (const routeFile of unique([
      ...(contract.webRouteFile ? [contract.webRouteFile] : []),
      ...(contract.webRouteFiles || []),
    ])) {
      declaredApiRoutes.set(routeFile, contract.id);
    }
  }

  const allowlisted = new Set(routeManifest.allowlistedWebRouteFiles || []);
  const apiRouteCoverage = listApiRouteFiles().map((routeFile) => ({
    routeFile,
    contractId: declaredApiRoutes.get(routeFile) || null,
    status: declaredApiRoutes.has(routeFile)
      ? "contracted"
      : allowlisted.has(routeFile)
      ? "allowlisted"
      : "missing",
  }));

  const gaps = [];
  for (const capability of capabilities) {
    if (capability.nativeSupported && capability.parityStatus === "unsupported_gap") {
      gaps.push({
        severity: "blocking",
        category: "missing_native_transport",
        capabilityId: capability.capabilityId,
        route: capability.route,
        detail: "Native-supported route has no plugin-backed or direct-backend parity trace.",
      });
    }
    if (
      capability.nativeSupported &&
      capability.serviceTraces.some((trace) => trace.rawApiFetch)
    ) {
      gaps.push({
        severity: "blocking",
        category: "raw_fetch_on_native_route",
        capabilityId: capability.capabilityId,
        route: capability.route,
        detail: "Native-supported route uses raw fetch('/api/...') instead of ApiService/authFetch.",
      });
    }
    if (
      capability.serviceTraces.some((trace) => trace.apiTargets.length > 0) &&
      capability.apiContractIds.length === 0 &&
      capability.layoutMode !== "hidden" &&
      capability.layoutMode !== "redirect"
    ) {
      gaps.push({
        severity: "blocking",
        category: "stale_page_contract",
        capabilityId: capability.capabilityId,
        route: capability.route,
        detail: "Page service trace reaches API routes, but page contract does not declare apiContractIds.",
      });
    }
  }

  for (const entry of apiRouteCoverage) {
    if (entry.status === "missing") {
      gaps.push({
        severity: "blocking",
        category: "missing_api_contract",
        capabilityId: entry.routeFile,
        route: entry.routeFile,
        detail: "API route file exists on disk without a route contract or allowlist entry.",
      });
    }
  }

  const acceptedExceptions = exceptions.exceptions || [];
  const acceptedKeys = new Set(acceptedExceptions.map((item) => `${item.capabilityId}:${item.category}`));
  const blockingGaps = gaps.filter((gap) => !acceptedKeys.has(`${gap.capabilityId}:${gap.category}`));

  return {
    version: 1,
    summary: {
      pageRouteCount: capabilities.length,
      nativeSupportedPageCount: capabilities.filter((item) => item.nativeSupported).length,
      apiRouteCount: apiRouteCoverage.length,
      contractedApiRouteCount: apiRouteCoverage.filter((item) => item.status === "contracted").length,
      allowlistedApiRouteCount: apiRouteCoverage.filter((item) => item.status === "allowlisted").length,
      missingApiRouteCount: apiRouteCoverage.filter((item) => item.status === "missing").length,
      acceptedExceptionCount: acceptedExceptions.length,
      blockingGapCount: blockingGaps.length,
    },
    capabilities,
    apiRouteCoverage,
    acceptedExceptions,
    gaps,
    blockingGaps,
  };
}

function renderGapReport(matrix) {
  const lines = [];
  lines.push("# Tri-Flow Gap Report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Page routes audited: ${matrix.summary.pageRouteCount}`);
  lines.push(`- Native-supported routes: ${matrix.summary.nativeSupportedPageCount}`);
  lines.push(`- API routes audited: ${matrix.summary.apiRouteCount}`);
  lines.push(`- Missing API contracts: ${matrix.summary.missingApiRouteCount}`);
  lines.push(`- Accepted exceptions: ${matrix.summary.acceptedExceptionCount}`);
  lines.push(`- Blocking gaps: ${matrix.summary.blockingGapCount}`);
  lines.push("");

  lines.push("## Blocking Gaps");
  lines.push("");
  if (matrix.blockingGaps.length === 0) {
    lines.push("- None");
  } else {
    for (const gap of matrix.blockingGaps) {
      lines.push(
        `- [${gap.category}] \`${gap.capabilityId}\` on \`${gap.route}\`: ${gap.detail}`
      );
    }
  }
  lines.push("");

  lines.push("## Accepted Exceptions");
  lines.push("");
  if ((matrix.acceptedExceptions || []).length === 0) {
    lines.push("- None");
  } else {
    for (const item of matrix.acceptedExceptions) {
      lines.push(
        `- \`${item.capabilityId}\` / \`${item.category}\`: ${item.reason} (owner: ${item.owner}, review: ${item.review})`
      );
    }
  }
  lines.push("");

  lines.push("## Capability Matrix");
  lines.push("");
  lines.push("| Capability | Route | Native | Status | Transport |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const capability of matrix.capabilities) {
    lines.push(
      `| \`${capability.capabilityId}\` | \`${capability.route}\` | ${capability.nativeSupported ? "yes" : "no"} | ${capability.parityStatus} | ${capability.transportModes.join(", ") || "none"} |`
    );
  }
  lines.push("");

  lines.push("## API Route Coverage");
  lines.push("");
  lines.push("| Route file | Contract | Status |");
  lines.push("| --- | --- | --- |");
  for (const route of matrix.apiRouteCoverage) {
    lines.push(
      `| \`${route.routeFile}\` | ${route.contractId ? `\`${route.contractId}\`` : "-"} | ${route.status} |`
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

module.exports = {
  buildCapabilityMatrix,
  renderGapReport,
  stableStringify,
};
