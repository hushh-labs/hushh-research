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
// One copy per Docker build context: the repo-root original, the webapp's, and
// the backend's. `deploy/backend.cloudbuild.yaml` builds with context
// `consent-protocol`, so anything outside it simply is not in the image.
const outputs = [
  path.join(repoRoot, "contracts/kai/one-route-orchestration-index.v1.json"),
  path.join(appRoot, "contracts/kai/one-route-orchestration-index.v1.json"),
  path.join(
    repoRoot,
    "consent-protocol/contracts/kai/one-route-orchestration-index.v1.json",
  ),
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
  // The physical route map intentionally indexes a pathname once. Finance
  // actions carry explicit tab query state, so compare route families here;
  // the action target itself remains the authoritative tab destination.
  const routePath = String(route).split("?", 1)[0];
  const patternPath = String(pattern).split("?", 1)[0];
  if (routePath === patternPath) return true;
  const routeSegments = routePath.split("/").filter(Boolean);
  const patternSegments = patternPath.split("/").filter(Boolean);
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
    const playbook = entry.route_contract?.voice_playbook;
    if (!playbook)
      throw new Error(`Route ${route} has no generated voice playbook`);
    const mode = entry.route_contract?.mode || "unclassified";
    const localActionIds = new Set(entry.voice_action_contract_ids || []);
    // Redirect/callback routes never publish ordinary actions. Their physical
    // page file may share a compatibility component with a canonical route,
    // but the current route has no mounted controls and must not inherit them.
    const routeActions = mode === "redirect" ? [] : actions.filter(
      (action) =>
        localActionIds.has(action.action_id) ||
        (Array.isArray(action.reachability?.routes) &&
          action.reachability.routes.some((actionRoute) =>
            // Reachability patterns may admit a concrete physical route, but a
            // concrete action must never leak into a dynamic physical-route entry.
            routeMatchesPattern(route, actionRoute),
          ) &&
          // A route index represents controls that can be reached from this
          // route, not every action that happens to navigate *to* it. Keep a
          // route-reachable action only when it has an authored control or is
          // explicitly declared hidden-navigable.
          ((action.control_ids || []).length > 0 ||
            action.reachability?.hidden_navigable === true)),
    );
    const actionIds = routeActions
      .filter((action) => action.execution_target?.status === "wired")
      .map((action) => action.action_id)
      .sort();
    const delegateAgentIds = [
      ...new Set(
        routeActions
          .filter((action) => action.execution_target?.status === "wired")
          .map((action) => action.delegate_agent_id)
          .filter((agentId) => typeof agentId === "string" && agentId.trim()),
      ),
    ].sort();
    const transitional =
      mode === "redirect" ||
      /oauth\/return|callback|logout/.test(route) ||
      (mode === "hidden" && actionIds.length === 0);
    // Delegation is blocked only on genuine redirect/callback surfaces where the
    // user is mid-flow and never actually converses (OAuth return, logout,
    // redirect). Context-only "hidden" screens are real interactive surfaces
    // where One must still be able to delegate, so they are NOT blocked here.
    const blocksDelegation =
      mode === "redirect" || /oauth\/return|callback|logout/.test(route);
    const authored =
      routeActions
        .map((action) => surfaces.get(action.surface_id)?.orchestration)
        .find((value) => value && Object.values(value).some(Boolean)) || {};
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
      canonical_screen: playbook.screen || null,
      voice_contract_file:
        entry.voice_action_contract_file ||
        (route === "/one/setup/finance"
          ? "app/one/setup/kai/page.voice-action-contract.json"
          : null),
      action_ids: actionIds,
      action_coverage: actionIds.length
        ? "inherited"
        : entry.voice_action_contract_file
          ? "local"
          : "none",
      // One is the single routing authority: admission defaults to allow, so
      // no_delegation/one_action_gate both admit and allowed_delegate_agent_ids
      // is advisory (the screen's primary specialists). Only transitional
      // surfaces (redirect, OAuth-return, callback, logout) explicitly block
      // delegation, where mid-flow specialist work would be incoherent. Consent
      // and TrustLink still gate every call inside the specialist.
      delegation_policy: {
        mode:
          authored.delegation_policy ||
          (blocksDelegation
            ? "block_delegation"
            : delegateAgentIds.length
              ? "one_action_gate"
              : "no_delegation"),
        allowed_delegate_agent_ids: delegateAgentIds,
      },
      trust_boundary: authored.trust_boundary || trustBoundary(actionIds, byId),
      native_surface_id: entry.native?.expectedMarker || null,
    };
  })
  .sort((left, right) => left.route_pattern.localeCompare(right.route_pattern));

// Same-screen action reconciliation.
//
// A screen is often served by several physical routes (/one/profile and
// /one/profile/account, /one/profile/security and .../security/vault). Actions
// are indexed against whichever route file declares them, so the sibling routes
// rendering the SAME screen exposed a partial inventory -- and the executor
// refuses anything absent from it with "that action is not available", on the
// very screen that owns the control. Reconcile by canonical_screen so every
// route showing a screen can reach that screen's whole inventory.
//
// Transitional surfaces (redirect, OAuth-return, callback, logout) are excluded
// deliberately: they are given an empty inventory above because the person is
// mid-flow and never converses there. Granting them actions would undo that.
const isTransitional = (entry) =>
  entry.orchestration_class === "transitional" || entry.route_mode === "redirect";
const screenActionIds = new Map();
for (const entry of routes) {
  if (!entry.canonical_screen || isTransitional(entry)) continue;
  const held = screenActionIds.get(entry.canonical_screen) || new Set();
  for (const actionId of entry.action_ids || []) held.add(actionId);
  screenActionIds.set(entry.canonical_screen, held);
}
for (const entry of routes) {
  if (!entry.canonical_screen || isTransitional(entry)) continue;
  const shared = screenActionIds.get(entry.canonical_screen);
  if (!shared || !shared.size) continue;
  const merged = [...new Set([...(entry.action_ids || []), ...shared])].sort();
  if (merged.length !== (entry.action_ids || []).length) {
    entry.action_ids = merged;
    // An inventory is what makes a surface interactive rather than context-only.
    if (entry.orchestration_class === "context_only") {
      entry.orchestration_class = "interactive";
    }
  }
}

// Query-qualified screen variants.
//
// The physical route map indexes a pathname once, so tab-based surfaces that
// live at the same path (/one/kai?tab=analysis vs ?tab=market) collapsed onto a
// single canonical_screen. Because the relay derives the authoritative screen
// from this index -- deliberately ignoring what the browser claims -- a journey
// whose settlement_target named the tab's screen could never observe it, and
// stalled forever on the destination it had already reached.
//
// These entries add ONLY a canonical_screen override for query-qualified routes
// the contracts already declare. Everything else (actions, delegation, trust
// boundary) is inherited verbatim from the physical route: it is the same page.
const routeByPattern = new Map(routes.map((entry) => [entry.route_pattern, entry]));
const variantScreens = new Map();
for (const action of actions) {
  const reachability = action.reachability || {};
  const screens = (reachability.screens || []).filter(
    (screen) => typeof screen === "string" && screen.trim(),
  );
  // A multi-screen action cannot attribute one screen to one route, so it never
  // defines a variant. Guessing here would mislabel the destination.
  if (screens.length !== 1) continue;
  for (const declared of reachability.routes || []) {
    if (typeof declared !== "string" || !declared.includes("?")) continue;
    const previous = variantScreens.get(declared);
    if (previous && previous !== screens[0]) {
      throw new Error(
        `Route variant ${declared} declares conflicting screens: ${previous} vs ${screens[0]}`,
      );
    }
    variantScreens.set(declared, screens[0]);
  }
}
// A variant may only name a screen some physical route already canonicalises
// to. Contracts can declare a screen the app never actually renders for that
// URL (/ria/clients/[userId]?tab=access names ria_client_workspace_access,
// which no route derives), and publishing it would tell the relay to wait for
// a screen that can never arrive -- reintroducing the exact stall this fixes,
// one layer further down. Deriving the allowed set from the index keeps this
// self-validating instead of an authored exclusion list.
const derivableScreens = new Set(
  routes.map((entry) => entry.canonical_screen).filter(Boolean),
);
// A variant IS the screen it names, so it must inherit that screen's action
// inventory -- not the base path's. /one/kai?tab=analysis renders the same
// surface as /one/kai/analysis, but analysis.start is declared only on the
// latter (a legacy path that redirects to the former). Inheriting the base
// gave the tab the market inventory, so the executor refused the journey's own
// action with "that action is not available" on the very screen that owns it.
// Several physical routes can canonicalise to one screen (a legacy /kai/*
// alias plus the real /one/kai/* page). Take the richest inventory rather than
// whichever sorts first, or the variant inherits an empty alias entry.
const routeByScreen = new Map();
for (const entry of routes) {
  if (!entry.canonical_screen) continue;
  const held = routeByScreen.get(entry.canonical_screen);
  if (
    !held ||
    (entry.action_ids || []).length > (held.action_ids || []).length
  ) {
    routeByScreen.set(entry.canonical_screen, entry);
  }
}
const routeVariants = [];
for (const [declared, screen] of variantScreens) {
  const base = routeByPattern.get(declared.split("?", 1)[0]);
  // No physical route to inherit policy from, or the query does not change the
  // screen -- either way the base entry already answers correctly.
  if (!base || base.canonical_screen === screen) continue;
  if (!derivableScreens.has(screen)) continue;
  // Union, not replace. The variant is the base page rendering a specific
  // screen, so it can legitimately reach both inventories: taking only the
  // screen's entry stripped tabs whose screen route declares nothing, and
  // taking only the base's dropped the screen's own actions. Union keeps the
  // page's controls AND the ones declared against the screen it is showing.
  const screenEntry = routeByScreen.get(screen);
  const mergedActionIds = [
    ...new Set([...(base.action_ids || []), ...((screenEntry || {}).action_ids || [])]),
  ].sort();
  // The playbook is the spoken layer: purpose, entry cue, preferred action.
  // Inheriting the base page's verbatim described the wrong screen -- the
  // Analysis tab carried Finance's "choose the active finance view" cue, so
  // One read it out as a navigation every time the note refired. Prefer the
  // playbook authored for the screen actually being rendered, and pin its
  // `screen` either way so it can never disagree with canonical_screen.
  const variantPlaybook = {
    ...((screenEntry || {}).voice_playbook || base.voice_playbook),
    screen,
  };
  routeVariants.push({
    ...base,
    route_pattern: declared,
    canonical_screen: screen,
    voice_playbook: variantPlaybook,
    action_ids: mergedActionIds,
  });
}
const allRoutes = [...routes, ...routeVariants].sort((left, right) =>
  left.route_pattern.localeCompare(right.route_pattern),
);

const payload = {
  schema_version: "one.route_orchestration_index.v2",
  purpose:
    "Generated, redacted route discovery and One delegation-admission index.",
  sources: [
    "hushh-webapp/frontend-native-surface-map.generated.json",
    "contracts/kai/kai-action-gateway.vnext.json",
  ],
  routes: allRoutes,
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
      : `Wrote route orchestration index (${allRoutes.length} routes, ` +
        `${routeVariants.length} query-qualified screen variants).`,
  );
