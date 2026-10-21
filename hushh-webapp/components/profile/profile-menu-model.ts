import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { ConnectedSystemsAgentIcon, PROFILE_ICON_COLORS } from "@/components/icons/agents";
import { RefreshCw } from "@/components/icons";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

export const PROFILE_LABELS = {
  account: "Your account", preferences: "Appearance & preferences",
  security: "Security & privacy", referrals: "Invite friends",
  support: "Help & feedback", developerTools: "Developer tools",
  accountAccess: "Account access", setup: "Set up One",
} as const;

/** One authored roster for React and the native presentation. Callbacks and
 * availability remain with Profile; this model grants no operation authority. */
export const PROFILE_MENU_GROUPS = [
  { id: "settings", title: "Your settings", entries: [
    { id: "hosting", label: "Hosting", icon: ConnectedSystemsAgentIcon, symbol: "cloud", iconHex: PROFILE_ICON_COLORS.connectors },
    { id: "software-updates", label: "Software updates", icon: RefreshCw, symbol: "arrow.triangle.2.circlepath", iconHex: PROFILE_ICON_COLORS.connectors },
    { id: "account", label: PROFILE_LABELS.account, icon: PROFILE_ICONS.account, symbol: "person" },
    { id: "payouts", label: "Payouts", icon: PROFILE_ICONS.payouts, symbol: "building.columns", voiceControlId: "profile_payouts", voiceActionId: "route.profile_payouts", voicePurpose: "Opens bank setup and transaction history." },
    { id: "request-pricing", label: "Request pricing", icon: PROFILE_ICONS.pricing, symbol: "tag", voiceControlId: "profile_request_pricing", voiceActionId: "route.profile_request_pricing", voicePurpose: "Opens your default document request price." },
    { id: "my-data", label: "Memory", icon: PROFILE_ICONS.memory, symbol: "wallet.pass", voiceControlId: "profile_my_data", voiceActionId: "route.profile_my_data", voicePurpose: "Opens saved details and sharing." },
    { id: "world-model", label: "Personal World Model", icon: PROFILE_ICONS.worldModel, symbol: "globe", voiceControlId: "profile_world_model", voiceActionId: "route.profile_world_model", voicePurpose: "Opens your Personal World Model." },
    { id: "preferences", label: PROFILE_LABELS.preferences, icon: PROFILE_ICONS.preferences, symbol: "slider.horizontal.3" },
    { id: "security", label: PROFILE_LABELS.security, icon: PROFILE_ICONS.security, symbol: "checkmark.shield" },
    { id: "devices", label: "Trusted devices", icon: PROFILE_ICONS.devices, symbol: "laptopcomputer" },
    { id: "connectors", label: "Connectors", icon: PROFILE_ICONS.connectors, symbol: "powerplug" },
    { id: "invite", label: PROFILE_LABELS.referrals, icon: PROFILE_ICONS.invite, symbol: "person.2" },
    { id: "support", label: PROFILE_LABELS.support, icon: PROFILE_ICONS.support, symbol: "questionmark.circle" },
    { id: "developer-tools", label: PROFILE_LABELS.developerTools, icon: PROFILE_ICONS.developerTools, symbol: "chevron.left.forwardslash.chevron.right", localOnly: true },
  ] },
  { id: "legal", title: "Legal", entries: [
    { id: "privacy", label: LEGAL_DOCUMENTS.privacy.title, icon: PROFILE_ICONS.privacy, symbol: "checkmark.shield" },
    { id: "terms", label: LEGAL_DOCUMENTS.terms.title, icon: PROFILE_ICONS.terms, symbol: "text.document" },
  ] },
  { id: "account-access", title: PROFILE_LABELS.accountAccess, entries: [
    { id: "sign-out", label: "Sign out", icon: PROFILE_ICONS.signOut, symbol: "rectangle.portrait.and.arrow.right", destructive: true },
  ] },
] as const;

export type ProfileMenuItem = (typeof PROFILE_MENU_GROUPS)[number]["entries"][number];
export type ProfileMenuId = ProfileMenuItem["id"];
export type ProfileMenuActions = Record<ProfileMenuId, () => void | Promise<void>>;

export function profileMenuGroups(developerToolsAvailable: boolean) {
  return PROFILE_MENU_GROUPS.map(group => ({ ...group,
    entries: group.entries.filter(entry => !("localOnly" in entry) || developerToolsAvailable),
  }));
}
