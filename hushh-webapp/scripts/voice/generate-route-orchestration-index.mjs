#!/usr/bin/env node

// One generated route-intelligence index. It joins the complete physical-route
// map with the generated action gateway; it is discovery/admission metadata,
// never a TrustLink, consent grant, transcript, or user-state store.
import fs from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..");
const surfaceMapPath = path.join(
  appRoot,
  "frontend-native-surface-map.generated.json",
);
const gatewayPath = path.join(
  repoRoot,
  "contracts/kai/kai-action-gateway.vnext.json",
);
const outputs = [
  path.join(repoRoot, "contracts/kai/one-route-orchestration-index.v1.json"),
  path.join(appRoot, "contracts/kai/one-route-orchestration-index.v1.json"),
];

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function idFor(route) {
  return `route.${route === "/" ? "root" : route.slice(1).replace(/[^a-z0-9]+/gi, ".")}`;
}
function trustBoundary(actionIds, byId) {
  const guards = actionIds.flatMap((id) => byId.get(id)?.guard_ids || []);
  if (guards.some((guard) => /consent/i.test(guard))) return "consent";
  if (guards.some((guard) => /vault/i.test(guard))) return "vault";
  if (guards.some((guard) => /auth|signed_in/i.test(guard))) return "auth";
  return "none";
}
function routeMatchesPattern(route, pattern) {
  if (route === pattern) return true;
  const routeSegments = String(route).split("/").filter(Boolean);
  const patternSegments = String(pattern).split("/").filter(Boolean);
  if (routeSegments.length !== patternSegments.length) return false;
  return patternSegments.every(
    (segment, index) =>
      /^\[[^\]]+\]$/.test(segment) || segment === routeSegments[index],
  );
}

const surfaceMap = JSON.parse(fs.readFileSync(surfaceMapPath, "utf8"));
const gateway = JSON.parse(fs.readFileSync(gatewayPath, "utf8"));
const actions = Array.isArray(gateway.actions) ? gateway.actions : [];
const byId = new Map(actions.map((action) => [action.action_id, action]));
const surfaces = new Map(
  (gateway.surfaces || []).map((surface) => [surface.surface_id, surface]),
);
const routes = (surfaceMap.routes || [])
  .map((entry) => {
    const route = entry.route;
    const localActionIds = new Set(entry.voice_action_contract_ids || []);
    const routeActions = actions.filter(
      (action) =>
        localActionIds.has(action.action_id) ||
        (Array.isArray(action.reachability?.routes) &&
          action.reachability.routes.some((actionRoute) =>
            // Reachability patterns may admit a concrete physical route, but a
            // concrete action must never leak into a dynamic physical-route entry.
            routeMatchesPattern(route, actionRoute),
          )),
    );
    const actionIds = routeActions
      .filter((action) => action.execution_target?.status === "wired")
      .map((action) => action.action_id)
      .sort();
    const delegateAgentIds = [
      ...new Set(
        routeActions
          .map((action) => action.delegate_agent_id)
          .filter((agentId) => typeof agentId === "string" && agentId.trim()),
      ),
    ].sort();
    const mode = entry.route_contract?.mode || "unclassified";
    const transitional =
      mode === "redirect" ||
      /oauth\/return|callback|logout/.test(route) ||
      (mode === "hidden" && actionIds.length === 0);
    const authored =
      routeActions
        .map((action) => surfaces.get(action.surface_id)?.orchestration)
        .find((value) => value && Object.values(value).some(Boolean)) || {};
    const playbook = entry.route_contract?.voice_playbook;
    if (!playbook)
      throw new Error(`Route ${route} has no generated voice playbook`);
    if (
      playbook.primary_action_id &&
      !actionIds.includes(playbook.primary_action_id)
    ) {
      throw new Error(
        `Route ${route} primary action ${playbook.primary_action_id} is not reachable`,
      );
    }
    for (const actionId of playbook.happy_path_action_ids || []) {
      if (!actionIds.includes(actionId)) {
        throw new Error(
          `Route ${route} happy-path action ${actionId} is not reachable`,
        );
      }
    }
    return {
      route_pattern: route,
      page_file: entry.page_file,
      route_mode: mode,
      orchestration_class: transitional
        ? "transitional"
        : actionIds.length
          ? "interactive"
          : "context_only",
      instruction_id:
        playbook.playbook_id || authored.instruction_id || idFor(route),
      context_policy: transitional
        ? "suppress"
        : playbook.proactivity === "on_entry"
          ? "publish"
          : "minimal",
      voice_playbook: playbook,
      interaction_layer_policy: entry.route_contract
        ?.interaction_layer_policy || { allowed_families: [] },
      voice_contract_file: entry.voice_action_contract_file,
      action_ids: actionIds,
      action_coverage: actionIds.length
        ? "inherited"
        : entry.voice_action_contract_file
          ? "local"
          : "none",
      delegation_policy: {
        mode:
          authored.delegation_policy ||
          (delegateAgentIds.length ? "one_action_gate" : "no_delegation"),
        allowed_delegate_agent_ids: delegateAgentIds,
      },
      trust_boundary: authored.trust_boundary || trustBoundary(actionIds, byId),
      native_surface_id: entry.native?.expectedMarker || null,
    };
  })
  .sort((left, right) => left.route_pattern.localeCompare(right.route_pattern));

const payload = {
  schema_version: "one.route_orchestration_index.v2",
  purpose:
    "Generated, redacted route discovery and One delegation-admission index.",
  sources: [
    "hushh-webapp/frontend-native-surface-map.generated.json",
    "contracts/kai/kai-action-gateway.vnext.json",
  ],
  routes,
};
const check = process.argv.includes("--check");
for (const output of outputs) {
  const next = stable(payload);
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== next) {
      console.error(
        `route-orchestration-index: ${path.relative(repoRoot, output)} is stale.`,
      );
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, next);
  }
}
if (!process.exitCode)
  console.log(
    check
      ? "Route orchestration index is current."
      : `Wrote route orchestration index (${routes.length} routes).`,
  );
