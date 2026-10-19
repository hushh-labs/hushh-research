import { Code2 } from "./legacy-ui-icons";
import {
  ProfilePaneAccountIcon, ProfilePaneAppearanceIcon, ProfilePaneSecurityIcon,
  ProfilePaneDevicesIcon, ProfilePaneConnectorsIcon, ProfilePaneInviteIcon,
  ProfilePaneHelpIcon, ProfilePanePrivacyIcon, ProfilePaneTermsIcon,
  ProfilePaneSignOutIcon, ProfilePaneWalletIcon, ProfilePaneWorldModelIcon,
} from "../profile/profile-pane-icons";
import {
  ProfileAccountNameIcon, ProfileAccountMailIcon, ProfileAccountPhoneIcon,
  ProfileAccountProviderIcon, ProfileAccountWalletIcon, ProfileAccountResetIcon,
  ProfileAccountDeleteIcon, ProfileAccountBankIcon, ProfileAccountPriceIcon,
} from "../profile/profile-your-account-icons";
import {
  ProfileSecondaryFingerprintIcon, ProfileSecondaryPassphraseIcon,
  ProfileSecondaryRefreshIcon, ProfileSecondaryInboxIcon,
  ProfileSecondaryLocationIcon, ProfileSecondaryVisibilityIcon,
} from "../profile/profile-secondary-icons";
import { ProfileInnerPeopleIcon, ProfileInnerReviewIcon } from "../profile/profile-inner-icons";

/** Approved Profile artwork, shared by React rows and generated native templates.
 * Keep the original geometry; capability/launcher palettes are independent. */
export const PROFILE_ICONS = {
  account: ProfilePaneAccountIcon, preferences: ProfilePaneAppearanceIcon,
  security: ProfilePaneSecurityIcon, devices: ProfilePaneDevicesIcon,
  connectors: ProfilePaneConnectorsIcon, invite: ProfilePaneInviteIcon,
  support: ProfilePaneHelpIcon, privacy: ProfilePanePrivacyIcon,
  terms: ProfilePaneTermsIcon, signOut: ProfilePaneSignOutIcon,
  memory: ProfilePaneWalletIcon, worldModel: ProfilePaneWorldModelIcon,
  payouts: ProfileAccountBankIcon, pricing: ProfileAccountPriceIcon,
  developerTools: Code2, name: ProfileAccountNameIcon, mail: ProfileAccountMailIcon,
  phone: ProfileAccountPhoneIcon, provider: ProfileAccountProviderIcon,
  wallet: ProfileAccountWalletIcon, reset: ProfileAccountResetIcon,
  delete: ProfileAccountDeleteIcon, vault: ProfileSecondaryFingerprintIcon,
  passphrase: ProfileSecondaryPassphraseIcon, refresh: ProfileSecondaryRefreshIcon,
  inbox: ProfileSecondaryInboxIcon, location: ProfileSecondaryLocationIcon,
  visibility: ProfileSecondaryVisibilityIcon, people: ProfileInnerPeopleIcon,
  review: ProfileInnerReviewIcon,
} as const;
