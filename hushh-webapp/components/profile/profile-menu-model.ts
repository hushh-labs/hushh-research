import {
  AccountProfileIcon, PreferencesProfileIcon, SecurityProfileIcon,
  DevicesProfileIcon, ConnectedSystemsAgentIcon, InviteFriendsProfileIcon,
  SupportProfileIcon, DeveloperToolsProfileIcon, SignOutProfileIcon,
  PROFILE_ICON_COLORS,
} from "@/components/icons/agents";
import { ProfileAccountBankIcon, ProfileAccountPriceIcon } from "./profile-your-account-icons";
import { ProfilePaneWalletIcon, ProfilePaneWorldModelIcon } from "./profile-pane-icons";
import { ShieldCheck, ScrollText } from "@/components/icons";
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
    { id: "account", label: PROFILE_LABELS.account, icon: AccountProfileIcon, symbol: "person", iconHex: PROFILE_ICON_COLORS.account },
    { id: "payouts", label: "Payouts", icon: ProfileAccountBankIcon, symbol: "building.columns", voiceControlId: "profile_payouts", voiceActionId: "route.profile_payouts", voicePurpose: "Opens bank setup and transaction history." },
    { id: "request-pricing", label: "Request pricing", icon: ProfileAccountPriceIcon, symbol: "tag", voiceControlId: "profile_request_pricing", voiceActionId: "route.profile_request_pricing", voicePurpose: "Opens your default document request price." },
    { id: "my-data", label: "Memory", icon: ProfilePaneWalletIcon, symbol: "wallet.pass", voiceControlId: "profile_my_data", voiceActionId: "route.profile_my_data", voicePurpose: "Opens saved details and sharing." },
    { id: "world-model", label: "Personal World Model", icon: ProfilePaneWorldModelIcon, symbol: "globe", voiceControlId: "profile_world_model", voiceActionId: "route.profile_world_model", voicePurpose: "Opens your Personal World Model." },
    { id: "preferences", label: PROFILE_LABELS.preferences, icon: PreferencesProfileIcon, symbol: "slider.horizontal.3", iconHex: PROFILE_ICON_COLORS.preferences },
    { id: "security", label: PROFILE_LABELS.security, icon: SecurityProfileIcon, symbol: "checkmark.shield", iconHex: PROFILE_ICON_COLORS.security },
    { id: "devices", label: "Trusted devices", icon: DevicesProfileIcon, symbol: "laptopcomputer", iconHex: PROFILE_ICON_COLORS.devices },
    { id: "connectors", label: "Connectors", icon: ConnectedSystemsAgentIcon, symbol: "powerplug", iconHex: PROFILE_ICON_COLORS.connectors },
    { id: "invite", label: PROFILE_LABELS.referrals, icon: InviteFriendsProfileIcon, symbol: "person.2", iconHex: PROFILE_ICON_COLORS.invite },
    { id: "support", label: PROFILE_LABELS.support, icon: SupportProfileIcon, symbol: "questionmark.circle", iconHex: PROFILE_ICON_COLORS.support },
    { id: "developer-tools", label: PROFILE_LABELS.developerTools, icon: DeveloperToolsProfileIcon, symbol: "chevron.left.forwardslash.chevron.right", iconHex: PROFILE_ICON_COLORS.developerTools, localOnly: true },
  ] },
  { id: "legal", title: "Legal", entries: [
    { id: "privacy", label: LEGAL_DOCUMENTS.privacy.title, icon: ShieldCheck, symbol: "checkmark.shield" },
    { id: "terms", label: LEGAL_DOCUMENTS.terms.title, icon: ScrollText, symbol: "text.document" },
  ] },
  { id: "account-access", title: PROFILE_LABELS.accountAccess, entries: [
    { id: "sign-out", label: "Sign out", icon: SignOutProfileIcon, symbol: "rectangle.portrait.and.arrow.right", iconHex: PROFILE_ICON_COLORS.signOut, destructive: true },
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
