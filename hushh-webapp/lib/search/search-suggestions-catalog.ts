/** Curated presentation over generated actions; labels and guards have one owner. */
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  listKaiActions,
  searchKaiActions,
  type KaiActionDefinition,
} from "@/lib/kai/actions/kai-action-gateway";
import {
  isDiscoverableCapability,
  projectKaiActionCapability,
  type VoiceCapabilityStateV1,
} from "@/lib/kai/actions/capability-projection";
import type { AppRuntimeState } from "@/lib/kai/actions/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { mailDisplayLabel } from "@/lib/copy/mail-terminology";

export type SearchCatalogIconHint = "profile" | "consent" | "history" | "market" | "location" | "memory" | "wallet" | "feed" | "agents" | "generic";
export type SearchCatalogEntry = {
  actionId: string;
  label: string;
  keywords: readonly string[];
  icon: SearchCatalogIconHint;
  disabled: boolean;
  reason: string | null;
};
export type SearchSuggestionContext = {
  appRuntimeState?: AppRuntimeState;
  capabilityState?: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
};

/** Presentation order only; new destinations are discovered from the gateway. */
export const IDLE_SUGGESTION_IDS: readonly string[] = [
  "route.one_location", "route.one_pkm", "route.one_wallet", "route.kai_dashboard",
  "route.kai_home", "route.one_feed", "route.one_agents", "route.profile", "route.consents",
];
/** Legacy, redundant or context-bound destinations retain their declared lifecycle. */
export const EXCLUDED_ACTION_IDS: readonly string[] = [
  "route.connected_system_list", "route.mail_connections", "route.messages_connections",
  "route.puppy_agents", "route.wallet_profile_cards", "route.profile_receipts",
  "route.one_gmail_kyc", "route.profile_connected_systems", "route.profile_pkm_agent_lab",
  "route.person_profile", "route.ria_client_workspace", "route.ria_home",
  "route.ria_requests_compat", "route.ria_settings_compat", "route.ria_workspace_compat",
];
/** These authored command targets implement navigation through the existing dispatcher. */
export const NAV_LIKE_KAI_COMMAND_IDS: readonly string[] = [
  "route.profile", "route.consents", "route.analysis_history", "route.kai_import",
];
const ICONS: Readonly<Record<string, SearchCatalogIconHint>> = {
  "route.profile": "profile", "route.consents": "consent", "route.analysis_history": "history",
  "route.one_location": "location", "route.one_pkm": "memory", "route.one_wallet": "wallet",
  "route.profile_payouts": "wallet", "route.one_feed": "feed", "route.one_agents": "agents",
  "route.kai_dashboard": "market", "route.kai_home": "market",
};

export function isSearchDestination(action: KaiActionDefinition): boolean {
  const target = action.execution_target;
  if (target.status !== "wired" || EXCLUDED_ACTION_IDS.includes(action.action_id)) return false;
  if (target.path !== "route" && !NAV_LIKE_KAI_COMMAND_IDS.includes(action.action_id)) return false;
  if (/\[[^\]]+\]/.test(target.target) || target.params?.requires_client_id === true) return false;
  return !action.goal.required_inputs.some(input => input.required !== false && String(input.resolver).startsWith("opaque_"));
}

function projectEntry(action: KaiActionDefinition, context: SearchSuggestionContext): SearchCatalogEntry | undefined {
  if (!isSearchDestination(action)) return undefined;
  if (context.capabilityState && !isDiscoverableCapability(projectKaiActionCapability({
    actionId: action.action_id, state: context.capabilityState, surfaceMetadata: context.surfaceMetadata,
  }))) return undefined;
  const availability = evaluateKaiActionAvailability({action, ...context});
  return {
    actionId: action.action_id, label: action.label,
    keywords: [...action.aliases, ...action.search_keywords], icon: ICONS[action.action_id] ?? "generic",
    disabled: availability.status !== "available", reason: availability.reason,
  };
}

/** Compatibility projection, never a hand-authored copy of action semantics. */
export const SEARCH_CATALOG: readonly SearchCatalogEntry[] = listKaiActions().flatMap(action => {
  const entry = projectEntry(action, {});
  return entry ? [entry] : [];
});

export function getCatalogEntry(actionId: string, context: SearchSuggestionContext = {}): SearchCatalogEntry | undefined {
  const action = getKaiActionById(actionId);
  return action ? projectEntry(action, context) : undefined;
}

export function getIdleSuggestions(context: SearchSuggestionContext = {}): SearchCatalogEntry[] {
  return IDLE_SUGGESTION_IDS.flatMap(actionId => {
    const entry = getCatalogEntry(actionId, context);
    return entry ? [entry] : [];
  });
}

export function searchCatalog(query: string, limit = 24, context: SearchSuggestionContext = {}): SearchCatalogEntry[] {
  return searchKaiActions({query, ...context, limit: 40}).flatMap(({action}) => {
    const entry = projectEntry(action, context);
    return entry ? [entry] : [];
  }).slice(0, Math.max(1, Math.min(limit, 40)));
}

export function findExactCatalogMatch(query: string, context: SearchSuggestionContext = {}): SearchCatalogEntry | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  return searchCatalog(query, 40, context).find(entry => {
    const action = getKaiActionById(entry.actionId);
    return !entry.disabled && action &&
      [action.action_id, action.label, mailDisplayLabel(action.label), ...action.aliases]
        .some(value => value.trim().toLowerCase() === normalized);
  });
}
