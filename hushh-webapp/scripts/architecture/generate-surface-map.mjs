#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..");
const outputPath = path.join(
  appRoot,
  "frontend-native-surface-map.generated.json",
);

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(read(filePath));
}

function routeValuesFromRoutesTs(source) {
  return [
    ...new Set(
      [...source.matchAll(/\b[A-Z0-9_]+:\s*"([^"]+)"/g)].map(
        (match) => match[1] || "/",
      ),
    ),
  ].sort();
}

function routeValuesFromAppPages() {
  return walkFiles(path.join(appRoot, "app"), (filePath) =>
    path.basename(filePath) === "page.tsx",
  )
    .map((filePath) => {
      const relative = toPosixPath(
        path.relative(path.join(appRoot, "app"), filePath),
      );
      const route = relative.replace(/(?:^|\/)page\.tsx$/, "");
      return route ? `/${route}` : "/";
    })
    .sort();
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

/**
 * Route constants can deliberately include a query-backed workspace view.
 * They still resolve to the physical pathname and inherit that route's shell
 * contract, but must remain distinct in the generated inventory so cache and
 * native checks cannot silently miss a canonical tab selection.
 */
function pathnameForRoute(route) {
  return String(route || "/").split(/[?#]/, 1)[0] || "/";
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
  const pathname = pathnameForRoute(route);
  const candidate = pathname === "/" ? "app/page.tsx" : `app${pathname}/page.tsx`;
  const absolute = path.join(appRoot, candidate);
  return fs.existsSync(absolute) ? candidate : null;
}

function routeToVoiceContractFile(route) {
  const pathname = pathnameForRoute(route);
  const base = pathname === "/" ? "app" : `app${pathname}`;
  const candidates = [
    `${base}/page.voice-action-contract.json`,
    `${base}/page-client.voice-action-contract.json`,
    ...(pathname === "/one/setup/[capability]"
      ? [`${base}/one-onboarding-capability-step.voice-action-contract.json`]
      : []),
  ].filter((candidate) => fs.existsSync(path.join(appRoot, candidate)));
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous voice action contracts for ${route}: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] || null;
}

function apiTemplateFromRouteFile(filePath) {
  const relative = toPosixPath(
    path.relative(path.join(appRoot, "app/api"), filePath),
  );
  const withoutRoute = relative.replace(/\/route\.ts$/, "");
  const parts = withoutRoute.split("/").map((part) => {
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
    shared_loader:
      source.includes("HushhLoader") || source.includes("RouteLoadingState"),
    back_button_pattern: source.includes("Back")
      ? "route-local-check-required"
      : "shared-shell",
  };
}

function routeSort(left, right) {
  if (left === right) return 0;
  if (left === "/") return -1;
  if (right === "/") return 1;
  return left.localeCompare(right);
}

const routeOverrides = {
  "/one/location": {
    api_dependencies: [
      {
        service_file: "lib/one-location/service.ts",
        service_methods: [
          "getState",
          "listCircles",
          "getCircle",
          "createNamedCircle",
          "updateNamedCircle",
          "deleteNamedCircle",
          "createNamedCircleInviteCode",
          "revokeNamedCircleInviteCode",
          "resolveNamedCircleCode",
          "joinNamedCircle",
          "removeNamedCircleMember",
          "leaveNamedCircle",
        ],
        nextjs_api_route: "/api/one/{path*}",
        nextjs_proxy_file: "app/api/one/[...path]/route.ts",
        backend_endpoint_family: "/api/one/location/{circles,circle-codes}/*",
        native_transport:
          "CapacitorHttp direct backend via the shared One Location service",
      },
    ],
    native_plugin_dependencies: [
      {
        package: "@capacitor/share",
        integration:
          "Native iOS and Android share sheets for text-only Circle invite codes; code values never enter URLs",
      },
    ],
    thread_and_consent_contract: {
      membership_authority:
        "Circle membership is metadata-only and never creates a connection, SMS selection, or location grant",
      location_authority:
        "Every live-location share remains recipient-specific, encrypted, duration-bounded, and explicitly confirmed",
      invite_code_storage:
        "Raw codes are returned once for sharing and never persisted by the client or placed in URLs",
    },
  },
  "/one/location/map": {
    api_dependencies: [
      {
        service_file: "lib/one-location/service.ts",
        service_methods: ["getMapState", "updateMapPreferences", "getState", "storeEnvelope"],
        nextjs_api_route: "/api/one/{path*}",
        nextjs_proxy_file: "app/api/one/[...path]/route.ts",
        backend_endpoint_family: "/api/one/location/{map-state,map-preferences,grants/*/envelopes}",
        native_transport: "CapacitorHttp direct backend via the shared One Location service",
      },
    ],
    native_plugin_dependencies: [
      {
        package: "@capacitor/google-maps",
        integration: "Capacitor sync-managed native renderer; no handwritten plugin bridge",
        ios: "Restricted bundle-ID Maps SDK key passed to GoogleMap.create",
        android: "Restricted package/SHA Maps SDK key plus transparent map route layers",
      },
      {
        package: "@capacitor/app",
        integration: "Foreground lifecycle gates the bounded map refresh loop",
      },
    ],
    thread_and_consent_contract: {
      baseline_transport: "Active recipient-scoped ciphertext only; no public or iframe fallback",
      coordinate_storage: "foreground renderer memory only; preferences contain no coordinates",
      location_capture: "explicit Locate me action only; opening the route never captures or watches location",
      visibility: "Ghost Mode by default; foreground map publication never promotes direct/background envelopes",
    },
  },
  "/one/kai/news": {
    api_dependencies: [
      {
        service_file: "lib/kai/kai-market-news-resource.ts",
        service_methods: ["getStaleFirst", "refresh", "invalidateUser"],
        nextjs_api_route: "/api/kai/{path*}",
        nextjs_proxy_file: "app/api/kai/[...path]/route.ts",
        backend_endpoint_family: "/api/kai/market/news/*",
        native_transport:
          "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
    ],
    native_plugin_dependencies: [],
    thread_and_consent_contract: {
      baseline_transport: "Firebase-authenticated public market snapshot",
      personalized_transport:
        "VAULT_OWNER token scopes tracked-symbol headlines; token stays memory-only",
      cache_boundary:
        "browser page cache contains only public provider headlines; server cursor slices its cached snapshot",
    },
  },
  "/connected-systems": {
    api_dependencies: [
      {
        service_file: "lib/services/connected-systems-service.ts",
        service_methods: [
          "listSystems",
          "getSchema",
          "readRecord",
          "createRecordIntent",
          "updateRecordIntent",
          "approveIntent",
          "rejectIntent",
        ],
        nextjs_api_route: "/api/connected-systems/{path*}",
        nextjs_proxy_file: "app/api/connected-systems/[...path]/route.ts",
        backend_endpoint_family: "/api/connected-systems/*",
        native_transport:
          "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
    ],
    native_plugin_dependencies: [],
    thread_and_consent_contract: {
      vault_owner_token_required: true,
      write_actions_require_explicit_intent_approval: true,
      terminal_payload_storage:
        "field names, record id, result class, and sanitized summaries only",
      external_plaintext_boundary:
        "Salesforce CRM MCP transport is outside the ZK boundary. Hussh reaches MuleSoft Managed Omni Gateway over Streamable HTTP; MuleSoft Private Space owns the downstream CRM network boundary.",
    },
  },
  "/gmail": {
    api_dependencies: [
      {
        service_file: "lib/services/gmail-receipts-service.ts",
        service_methods: ["getStatus", "syncNow", "listReceipts"],
        nextjs_api_route: "/api/profile/gmail/{path*}",
        nextjs_proxy_file: "app/api/profile/gmail/[...path]/route.ts",
        backend_endpoint_family: "/profile/gmail/*",
        native_transport:
          "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
      {
        service_file: "lib/services/personal-knowledge-model-service.ts",
        service_methods: ["getMetadata", "getDomainData", "storeDomainData"],
        nextjs_api_route: "/api/pkm/{path*}",
        nextjs_proxy_file: "app/api/pkm/[...path]/route.ts",
        backend_endpoint_family: "/pkm/*",
        native_transport:
          "CapacitorHttp direct backend plus client vault/PKM services",
      },
    ],
    native_plugin_dependencies: [],
    thread_and_consent_contract: {
      vault_owner_token_required: true,
      gmail_scope_required: "readonly receipt sync only",
      pkm_payload_storage:
        "encrypted domain resource only; observability is metadata-only",
    },
  },
  "/pkm": {
    api_dependencies: [
      {
        service_file: "lib/services/personal-knowledge-model-service.ts",
        service_methods: [
          "getMetadata",
          "getDomainData",
          "getDomainManifest",
          "storeDomainData",
        ],
        nextjs_api_route: "/api/pkm/{path*}",
        nextjs_proxy_file: "app/api/pkm/[...path]/route.ts",
        backend_endpoint_family: "/pkm/*",
        native_transport:
          "CapacitorHttp direct backend plus client vault/PKM services",
      },
      {
        service_file: "lib/services/pkm-upgrade-service.ts",
        service_methods: ["getStatus", "startOrResume"],
        nextjs_api_route: "/api/pkm/{path*}",
        nextjs_proxy_file: "app/api/pkm/[...path]/route.ts",
        backend_endpoint_family: "/pkm/*",
        native_transport:
          "CapacitorHttp direct backend plus client vault/PKM services",
      },
    ],
    native_plugin_dependencies: [
      {
        js_name: "HushhVault",
        reason:
          "PKM payload decryption remains client-held and metadata-only for route observability.",
      },
    ],
    thread_and_consent_contract: {
      vault_owner_token_required: true,
      pkm_payload_storage:
        "encrypted domain resource only; route/cache events must not include decrypted values",
    },
  },
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
        native_transport:
          "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
      {
        service_file: "lib/services/account-service.ts",
        service_methods: [
          "listEmailAliases",
          "startEmailAliasVerification",
          "confirmEmailAliasVerification",
        ],
        nextjs_api_route: "/api/account/{path*}",
        nextjs_proxy_file: "app/api/account/[...path]/route.ts",
        backend_endpoint_family: "/account/*",
        native_transport:
          "CapacitorHttp direct backend via ApiService.apiFetch on native",
      },
      {
        service_file: "lib/services/kyc-pkm-write-service.ts",
        service_methods: ["writeWorkflowArtifact"],
        nextjs_api_route: "/api/pkm/{path*}",
        nextjs_proxy_file: "app/api/pkm/[...path]/route.ts",
        backend_endpoint_family: "/pkm/*",
        native_transport:
          "CapacitorHttp direct backend plus client vault/PKM services",
      },
    ],
    native_plugin_dependencies: [
      {
        js_name: "HushhVault",
        reason:
          "Vault unlock and client-held KYC connector key material stay outside the Next.js server.",
      },
      {
        js_name: "HushhConsent",
        reason:
          "Consent status and export authorization must preserve the native consent boundary.",
      },
    ],
    thread_and_consent_contract: {
      original_thread_required: true,
      approved_send_requires_workflow_scopes: true,
      approved_body_transport: "transient send-approved-reply request only",
      local_plaintext_cleanup:
        "drop local draft/export payloads after terminal or non-ready workflow states",
    },
  },
};

function validateVoicePlaybook(route, value) {
  const requiredStrings = [
    "playbookId",
    "purpose",
    "screen",
    "completionBoundary",
    "outOfScopeBehavior",
  ];
  for (const field of requiredStrings) {
    if (typeof value?.[field] !== "string" || !value[field].trim()) {
      throw new Error(`Route ${route} voicePlaybook.${field} is required`);
    }
  }
  if (!/^[a-z0-9._-]{3,96}$/.test(value.playbookId)) {
    throw new Error(`Route ${route} has an invalid voicePlaybook.playbookId`);
  }
  if (!["on_entry", "ambient"].includes(value.proactivity)) {
    throw new Error(`Route ${route} has invalid voicePlaybook.proactivity`);
  }
  if (
    ![
      "stay",
      "navigate",
      "external_callback",
      "return_to_hub",
      "resolve_root",
    ].includes(value.returnPolicy)
  ) {
    throw new Error(`Route ${route} has invalid voicePlaybook.returnPolicy`);
  }
  if (
    !Array.isArray(value.happyPathActionIds) ||
    !Array.isArray(value.requiredInputs)
  ) {
    throw new Error(
      `Route ${route} playbook action/input collections must be arrays`,
    );
  }
  for (const recovery of [
    "blocked",
    "cancelled",
    "failed",
    "timeout",
    "callbackError",
    "routeMismatch",
  ]) {
    if (
      typeof value.recoveries?.[recovery] !== "string" ||
      !value.recoveries[recovery].trim()
    ) {
      throw new Error(
        `Route ${route} voicePlaybook.recoveries.${recovery} is required`,
      );
    }
  }
  if (
    value.proactivity === "on_entry" &&
    !String(value.entryCue || "").trim()
  ) {
    throw new Error(`Route ${route} proactive playbook requires an entryCue`);
  }
  if (value.proactivity === "on_entry" && !String(value.primaryActionId || "").trim()) {
    throw new Error(`Route ${route} proactive playbook requires a primaryActionId`);
  }
  return value;
}

function buildSurfaceMap() {
  const routeContract = readJson(
    path.join(appRoot, "lib/navigation/app-route-layout.contract.json"),
  );
  const contractByRoute = new Map(
    (routeContract || []).map((entry) => [entry.route, entry]),
  );
  if (contractByRoute.size !== (routeContract || []).length) {
    throw new Error("app-route-layout.contract.json contains duplicate routes");
  }
  const structuralPatterns = new Set();
  for (const entry of routeContract || []) {
    const structural = String(entry.route).replace(/\[[^\]]+\]/g, "[]");
    if (structuralPatterns.has(structural)) {
      throw new Error(`Ambiguous dynamic route layout pattern: ${structural}`);
    }
    structuralPatterns.add(structural);
  }
  const routes = [
    ...new Set([
      ...routeValuesFromRoutesTs(
        read(path.join(appRoot, "lib/navigation/routes.ts")),
      ),
      ...routeValuesFromAppPages(),
      ...(routeContract || []).map((entry) => entry.route),
    ]),
  ].sort(routeSort);
  const inventory = readJson(path.join(appRoot, "native-route-inventory.json"));
  const inventoryByRoute = new Map(
    (inventory.routes || []).map((route) => [route.route, route]),
  );
  const apiRoutes = walkFiles(
    path.join(appRoot, "app/api"),
    (filePath) => path.basename(filePath) === "route.ts",
  )
    .map((filePath) => ({
      template: apiTemplateFromRouteFile(filePath),
      file: toPosixPath(path.relative(appRoot, filePath)),
    }))
    .sort((left, right) => left.template.localeCompare(right.template));

  return {
    schema_version: "hushh.frontend_native_surface_map.v1",
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
      const routeContractEntry =
        contractByRoute.get(route) ||
        contractByRoute.get(pathnameForRoute(route)) ||
        null;
      if (!routeContractEntry) {
        throw new Error(
          `Route ${route} is missing from app-route-layout.contract.json`,
        );
      }
      const voicePlaybook = routeContractEntry.voicePlaybook;
      if (!voicePlaybook || typeof voicePlaybook !== "object") {
        throw new Error(`Route ${route} is missing its required voicePlaybook`);
      }
      validateVoicePlaybook(route, voicePlaybook);
      const interactionLayerPolicy =
        routeContractEntry.interactionLayerPolicy || {
          allowedFamilies: [],
        };
      if (
        !Array.isArray(interactionLayerPolicy.allowedFamilies) ||
        interactionLayerPolicy.allowedFamilies.some(
          (family) => typeof family !== "string" || !family.trim(),
        )
      ) {
        throw new Error(
          `Route ${route} has invalid interactionLayerPolicy.allowedFamilies`,
        );
      }
      return {
        route,
        page_file: pageFile,
        physical_page_exists: Boolean(pageFile),
        route_contract: routeContractEntry
          ? {
              mode: routeContractEntry.mode,
              exemption_reason: routeContractEntry.exemptionReason || null,
              shell_verification_file:
                routeContractEntry.shellVerification?.file || null,
              shell_verification_includes:
                routeContractEntry.shellVerification?.includes || [],
              interaction_layer_policy: {
                allowed_families: interactionLayerPolicy.allowedFamilies,
              },
              voice_playbook: {
                playbook_id: voicePlaybook.playbookId,
                purpose: voicePlaybook.purpose,
                screen: voicePlaybook.screen,
                entry_cue: voicePlaybook.entryCue,
                proactivity: voicePlaybook.proactivity,
                primary_action_id: voicePlaybook.primaryActionId || null,
                happy_path_action_ids: voicePlaybook.happyPathActionIds || [],
                required_inputs: voicePlaybook.requiredInputs || [],
                recoveries: {
                  blocked: voicePlaybook.recoveries?.blocked || "",
                  cancelled: voicePlaybook.recoveries?.cancelled || "",
                  failed: voicePlaybook.recoveries?.failed || "",
                  timeout: voicePlaybook.recoveries?.timeout || "",
                  callback_error: voicePlaybook.recoveries?.callbackError || "",
                  route_mismatch: voicePlaybook.recoveries?.routeMismatch || "",
                },
                completion_boundary: voicePlaybook.completionBoundary,
                next_route: voicePlaybook.nextRoute || null,
                return_policy: voicePlaybook.returnPolicy,
                out_of_scope_behavior: voicePlaybook.outOfScopeBehavior,
              },
            }
          : null,
        native:
          inventoryByRoute.get(route) ||
          inventoryByRoute.get(pathnameForRoute(route)) ||
          null,
        shell: shellForPage(pageFile),
        voice_action_contract_file: voiceContractFile,
        voice_action_contract_ids: readVoiceActionIds(voiceContractFile),
        api_dependencies:
          (routeOverrides[route] || routeOverrides[pathnameForRoute(route)])
            ?.api_dependencies || [],
        native_plugin_dependencies:
          (routeOverrides[route] || routeOverrides[pathnameForRoute(route)])
            ?.native_plugin_dependencies || [],
        thread_and_consent_contract:
          (routeOverrides[route] || routeOverrides[pathnameForRoute(route)])
            ?.thread_and_consent_contract || null,
      };
    }),
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withContentDigest(value) {
  return {
    ...value,
    content_sha256: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
  };
}

const check = process.argv.includes("--check");
const next = stableJson(withContentDigest(buildSurfaceMap()));

if (check) {
  const current = fs.existsSync(outputPath) ? read(outputPath) : "";
  if (current !== next) {
    console.error(
      `surface-map: ${path.relative(repoRoot, outputPath)} is stale. Run node scripts/architecture/generate-surface-map.mjs from hushh-webapp.`,
    );
    process.exit(1);
  }
  console.log("Surface map is current.");
} else {
  fs.writeFileSync(outputPath, next);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}
