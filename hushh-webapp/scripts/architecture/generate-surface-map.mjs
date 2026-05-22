#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..");
const outputPath = path.join(appRoot, "frontend-native-surface-map.generated.json");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(read(filePath));
}

function routeValuesFromRoutesTs(source) {
  return [
    ...new Set(
      [...source.matchAll(/\b[A-Z0-9_]+:\s*"([^"]+)"/g)].map((match) => match[1])
    ),
  ].sort();
}

function routeValuesFromAppPages() {
  return walkFiles(path.join(appRoot, "app"), (filePath) => filePath.endsWith("/page.tsx"))
    .map((filePath) => {
      const relative = path.relative(path.join(appRoot, "app"), filePath);
      const route = relative.replace(/(?:^|\/)page\.tsx$/, "");
      return route ? `/${route}` : "/";
    })
    .sort();
}

function walkFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function routeToPageFile(route) {
  const candidate = route === "/" ? "app/page.tsx" : `app${route}/page.tsx`;
  const absolute = path.join(appRoot, candidate);
  return fs.existsSync(absolute) ? candidate : null;
}

function routeToVoiceContractFile(route) {
  const candidate =
    route === "/" ? "app/page.voice-action-contract.json" : `app${route}/page.voice-action-contract.json`;
  const absolute = path.join(appRoot, candidate);
  return fs.existsSync(absolute) ? candidate : null;
}

function apiTemplateFromRouteFile(filePath) {
  const relative = path.relative(path.join(appRoot, "app/api"), filePath);
  const withoutRoute = relative.replace(/\/route\.ts$/, "");
  const parts = withoutRoute.split(path.sep).map((part) => {
    const catchAll = part.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) return `{${catchAll[1]}*}`;
    const dynamic = part.match(/^\[(.+)\]$/);
    if (dynamic) return `{${dynamic[1]}}`;
    return part;
  });
  return `/api/${parts.join("/")}`;
}

function readVoiceActionIds(contractFile) {
  if (!contractFile) return [];
  const payload = readJson(path.join(appRoot, contractFile));
  return Array.isArray(payload.actions)
    ? payload.actions
        .map((action) => action?.action_id)
        .filter((actionId) => typeof actionId === "string" && actionId.trim())
        .sort()
    : [];
}

function shellForPage(pageFile) {
  if (!pageFile) {
    return {
      app_page_shell: false,
      page_header: false,
      settings_ui: false,
      shared_loader: false,
      back_button_pattern: "unknown",
    };
  }
  const source = read(path.join(appRoot, pageFile));
  return {
    app_page_shell: source.includes("AppPageShell"),
    page_header: source.includes("PageHeader"),
    settings_ui:
      source.includes("SettingsGroup") ||
      source.includes("SettingsRow") ||
      source.includes("SettingsDetailPanel"),
    shared_loader: source.includes("HushhLoader"),
    back_button_pattern: source.includes("Back") ? "route-local-check-required" : "shared-shell",
  };
}

function routeSort(left, right) {
  if (left === right) return 0;
  if (left === "/") return -1;
  if (right === "/") return 1;
  return left.localeCompare(right);
}

const routeOverrides = {
  "/one/kyc": {
    api_dependencies: [
      {
        service_file: "lib/services/one-kyc-service.ts",
        service_methods: [
          "listWorkflows",
          "refreshWorkflow",
          "selectScopes",
          "getWorkflowConsentExports",
          "sendApprovedReply",
          "rejectDraft",
          "redraft",
          "writebackComplete",
          "getClientConnector",
          "registerClientConnector",
        ],
        nextjs_api_route: "/api/one/{path*}",
        nextjs_proxy_file: "app/api/one/[...path]/route.ts",
        backend_endpoint_family: "/one/kyc/*",
        native_transport: "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
      {
        service_file: "lib/services/account-service.ts",
        service_methods: ["listEmailAliases", "startEmailAliasVerification", "confirmEmailAliasVerification"],
        nextjs_api_route: "/api/account/{path*}",
        nextjs_proxy_file: "app/api/account/[...path]/route.ts",
        backend_endpoint_family: "/account/*",
        native_transport: "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
      {
        service_file: "lib/services/kyc-pkm-write-service.ts",
        service_methods: ["writeWorkflowArtifact"],
        nextjs_api_route: "/api/pkm/{path*}",
        nextjs_proxy_file: "app/api/pkm/[...path]/route.ts",
        backend_endpoint_family: "/pkm/*",
        native_transport: "CapacitorHttp direct backend plus client vault/PKM services",
      },
    ],
    native_plugin_dependencies: [
      {
        js_name: "HushhVault",
        reason: "Vault unlock and client-held KYC connector key material stay outside the Next.js server.",
      },
      {
        js_name: "HushhConsent",
        reason: "Consent status and export authorization must preserve the native consent boundary.",
      },
    ],
    thread_and_consent_contract: {
      original_thread_required: true,
      approved_send_requires_workflow_scopes: true,
      approved_body_transport: "transient send-approved-reply request only",
      local_plaintext_cleanup: "drop local draft/export payloads after terminal or non-ready workflow states",
    },
  },
};

function buildSurfaceMap() {
  const routeContract = readJson(path.join(appRoot, "lib/navigation/app-route-layout.contract.json"));
  const contractByRoute = new Map((routeContract || []).map((entry) => [entry.route, entry]));
  const routes = [
    ...new Set([
      ...routeValuesFromRoutesTs(read(path.join(appRoot, "lib/navigation/routes.ts"))),
      ...routeValuesFromAppPages(),
      ...(routeContract || []).map((entry) => entry.route),
    ]),
  ].sort(routeSort);
  const inventory = readJson(path.join(appRoot, "native-route-inventory.json"));
  const inventoryByRoute = new Map((inventory.routes || []).map((route) => [route.route, route]));
  const apiRoutes = walkFiles(path.join(appRoot, "app/api"), (filePath) =>
    filePath.endsWith("/route.ts")
  )
    .map((filePath) => ({
      template: apiTemplateFromRouteFile(filePath),
      file: path.relative(appRoot, filePath),
    }))
    .sort((left, right) => left.template.localeCompare(right.template));

  return {
    schema_version: "hushh.frontend_native_surface_map.v1",
    generated_at: "2026-05-21",
    purpose:
      "Scaffolded contract mapping app routes to Next.js API, backend, native parity, plugin, and voice/action surfaces.",
    sources: {
      route_contract: "lib/navigation/routes.ts",
      route_layout_contract: "lib/navigation/app-route-layout.contract.json",
      physical_pages: "app/**/page.tsx",
      native_inventory: "native-route-inventory.json",
      api_routes: "app/api/**/route.ts",
      route_docs: "../docs/reference/architecture/route-contracts.md",
      mobile_docs: "../docs/reference/mobile/capacitor-parity-audit.md",
    },
    nextjs_api_routes: apiRoutes,
    routes: routes.map((route) => {
      const pageFile = routeToPageFile(route);
      const voiceContractFile = routeToVoiceContractFile(route);
      const routeContractEntry = contractByRoute.get(route) || null;
      return {
        route,
        page_file: pageFile,
        physical_page_exists: Boolean(pageFile),
        route_contract: routeContractEntry
          ? {
              mode: routeContractEntry.mode,
              exemption_reason: routeContractEntry.exemptionReason || null,
              shell_verification_file: routeContractEntry.shellVerification?.file || null,
              shell_verification_includes: routeContractEntry.shellVerification?.includes || [],
            }
          : null,
        native: inventoryByRoute.get(route) || null,
        shell: shellForPage(pageFile),
        voice_action_contract_file: voiceContractFile,
        voice_action_contract_ids: readVoiceActionIds(voiceContractFile),
        api_dependencies: routeOverrides[route]?.api_dependencies || [],
        native_plugin_dependencies: routeOverrides[route]?.native_plugin_dependencies || [],
        thread_and_consent_contract: routeOverrides[route]?.thread_and_consent_contract || null,
      };
    }),
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const check = process.argv.includes("--check");
const next = stableJson(buildSurfaceMap());

if (check) {
  const current = fs.existsSync(outputPath) ? read(outputPath) : "";
  if (current !== next) {
    console.error(
      `surface-map: ${path.relative(repoRoot, outputPath)} is stale. Run node scripts/architecture/generate-surface-map.mjs from hushh-webapp.`
    );
    process.exit(1);
  }
  console.log("Surface map is current.");
} else {
  fs.writeFileSync(outputPath, next);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
