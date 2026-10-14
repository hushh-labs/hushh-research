/**
 * Wallet Profile copy.
 *
 * The strings in `WALLET_CARD_COPY` are fixed by the Wallet Card contract
 * (docs/superpowers/specs/2026-08-03-wallet-card-contract.md §9) and are used
 * verbatim on every surface — owner setup, owner management, and the public
 * scanned page. Do not reword them here; change the contract first.
 *
 * Public prose says "Hussh". Route, API, and schema identifiers keep the
 * legacy `hushh` spelling.
 */

export const WALLET_CARD_COPY = {
  /**
   * Settings-list row in Profile > Your account. One string for both states,
   * because that list does not hold a vault owner token and so cannot know
   * whether a card exists without making the row gate on an unlock.
   */
  profileEntry: {
    title: "Apple Wallet",
    description: "Share your profile with a scan.",
  },
  /** Entry point shown before a Wallet Profile exists. */
  entryBeforeSetup: {
    title: "Add to Apple Wallet",
    description: "Your profile, ready to share.",
  },
  /** Setup introduction. */
  setupIntro: {
    title: "Your profile, one scan away",
    description: "Add a Hussh One pass to Apple Wallet.",
  },
  /**
   * Privacy assurance shown alongside the shared-information review. Both
   * disclosures survive the shorter wording: what is visible, and that it
   * stays reversible.
   */
  privacyAssurance: {
    title: "You choose what shows",
    description:
      "Only what you pick is visible. Change or switch it off anytime.",
  },
  /** Entry point shown once a Wallet Profile exists. */
  entryAfterSetup: {
    title: "Wallet Profile",
    description: "Control what people see.",
  },
  /** Confirmation after the pass has been handed to Apple Wallet. */
  success: {
    title: "Pass added",
    description: "Share your profile straight from Apple Wallet.",
  },
  /** Shown when pass signing is unavailable. The technical error stays server-side. */
  signingFailure: "Couldn't create your pass. Try again in a moment.",
  /** Public page state after the owner removes their Wallet Profile. */
  revokedPage: "This profile is no longer shared.",
  /** Public page state once the share link has expired. */
  expiredPage: "This profile link has expired.",
} as const;

/**
 * Owner-surface copy that supports the contract strings above. Kept in one
 * place so the setup and management screens never drift apart.
 */
export const WALLET_CARD_OWNER_COPY = {
  optionalDisclosure: "More details",
  fromYourProfile: "From your Hussh profile",
  createProfile: "Create profile",
  saveChanges: "Save changes",
  previewTitle: "Preview",
  previewDescription: "Check what people will see after a scan.",
  walletPreviewTitle: "Wallet preview",
  walletPreviewHint: "How your pass looks in Apple Wallet.",
  visitorPreviewTitle: "What a visitor sees",
  visitorPreviewHint: "The exact page someone gets when they scan your pass.",
  visitorPreviewLoading: "Loading the visitor view…",
  visitorPreviewError:
    "We couldn't load the visitor view right now. Please try again in a moment.",
  addToWallet: "Add to Apple Wallet",
  addOnIphoneHint: "Open this page on your iPhone to add the pass.",
  shareLink: "Share your link",
  copyLink: "Copy link",
  editInformation: "Edit shared information",
  previewAsVisitor: "Preview as visitor",
  pauseSharing: "Pause sharing",
  resumeSharing: "Resume sharing",
  rotateAccess: "Rotate QR access",
  revokeAccess: "Revoke access",
  removeProfile: "Remove Wallet profile",
  updatesAutomatically: "Updates automatically.",
  statusActive: "Sharing is on",
  statusPaused: "Sharing is paused",
  statusPausedDetail: "Hidden until you resume.",
  lastUpdatedLabel: "Last updated",
  scanCountLabel: "Scans",
  lastScannedLabel: "Last scan",
  noLinkOnThisDevice:
    "Revoke access to create a QR on this device.",
  vaultLocked: "Unlock your vault to set up your Wallet Profile.",
  featureUnavailable: "Wallet Profile isn't available on this account yet.",
  loadFailed:
    "We couldn't load your Wallet Profile. Please try again in a moment.",
  saveFailed:
    "We couldn't save your Wallet Profile. Please try again in a moment.",
  shareFailed: "Sharing isn't supported on this device. Copy the link instead.",
  linkCopied: "Link copied.",
  saved: "Saved.",
  paused: "Sharing paused.",
  resumed: "Sharing resumed.",
  rotated: "Old QR access revoked. Scans reset for your new QR. Add your pass again to update it.",
  removed: "Wallet profile removed.",
} as const;

/** Explanations shown before every action that changes or ends sharing. */
export const WALLET_CARD_CONFIRMATIONS = {
  pause: {
    title: "Pause sharing?",
    body: "Hide your profile until you resume sharing.",
    confirmLabel: "Pause sharing",
  },
  resume: {
    title: "Resume sharing?",
    body: "Your selected information becomes visible again to anyone who scans your pass. The QR is unchanged, so a pass already in Apple Wallet keeps working.",
    confirmLabel: "Resume sharing",
  },
  rotate: {
    title: "Revoke QR access?",
    body: "Replace shared QR links and reset scans for Profile and NWS.",
    confirmLabel: "Revoke access",
  },
  remove: {
    title: "Remove Wallet profile?",
    body: "Permanently remove this profile and stop sharing.",
    confirmLabel: "Remove profile",
  },
} as const;
