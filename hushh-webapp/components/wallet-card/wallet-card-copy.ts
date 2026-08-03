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
  /** Entry point shown before a Wallet Profile exists. */
  entryBeforeSetup: {
    title: "Add to Apple Wallet",
    description: "Keep your Hussh One profile ready to share.",
  },
  /** Setup introduction. */
  setupIntro: {
    title: "Your profile, ready when you need it",
    description:
      "Add a secure Hussh One pass to Apple Wallet and share your selected details with a simple scan.",
  },
  /** Privacy assurance shown alongside the shared-information review. */
  privacyAssurance: {
    title: "You stay in control",
    description:
      "Only the information you select will be visible. You can update or disable access at any time.",
  },
  /** Entry point shown once a Wallet Profile exists. */
  entryAfterSetup: {
    title: "Manage Wallet Profile",
    description: "Control what people see when they scan your pass.",
  },
  /** Confirmation after the pass has been handed to Apple Wallet. */
  success: {
    title: "Your Hussh One pass is ready",
    description: "You can now share your profile directly from Apple Wallet.",
  },
  /** Shown when pass signing is unavailable. The technical error stays server-side. */
  signingFailure:
    "We couldn't create your Wallet pass right now. Please try again in a moment.",
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
  eyebrow: "One / Wallet Profile",
  onlyThisInformation: "Only this information will be shared.",
  optionalDisclosure: "Choose what people can see",
  optionalDisclosureHint:
    "Optional. Everything here is off until you fill it in, and you can change it later.",
  recommendedGroupTitle: "Shared by default",
  fromYourProfile: "From your Hussh profile",
  reviewPrimaryAction: "Continue to preview",
  previewTitle: "Preview",
  walletPreviewTitle: "Wallet preview",
  walletPreviewHint: "How your pass looks in Apple Wallet.",
  visitorPreviewTitle: "What a visitor sees",
  visitorPreviewHint: "The exact page someone gets when they scan your pass.",
  visitorPreviewLoading: "Loading the visitor view…",
  visitorPreviewError:
    "We couldn't load the visitor view right now. Please try again in a moment.",
  addToWallet: "Add to Apple Wallet",
  shareLink: "Share your link",
  copyLink: "Copy link",
  editInformation: "Edit shared information",
  previewAsVisitor: "Preview as visitor",
  pauseSharing: "Pause sharing",
  resumeSharing: "Resume sharing",
  rotateAccess: "Rotate QR access",
  removeProfile: "Remove Wallet profile",
  updatesAutomatically:
    "Your shared profile updates automatically. You never need to add the pass again after changing what you share.",
  statusActive: "Sharing is on",
  statusPaused: "Sharing is paused",
  statusPausedDetail: "A scan shows nothing until you resume.",
  lastUpdatedLabel: "Last updated",
  scanCountLabel: "Scans",
  lastScannedLabel: "Last scan",
  noLinkOnThisDevice:
    "Your share link isn't stored on this device, so the QR can't be shown here. Rotate QR access to create a new link — the current QR stops working.",
  vaultLocked: "Unlock your vault to set up your Wallet Profile.",
  featureUnavailable: "Wallet Profile isn't available on this account yet.",
  loadFailed: "We couldn't load your Wallet Profile. Please try again in a moment.",
  saveFailed: "We couldn't save your Wallet Profile. Please try again in a moment.",
  shareFailed: "Sharing isn't supported on this device. Copy the link instead.",
  linkCopied: "Link copied.",
  saved: "Saved.",
  paused: "Sharing paused.",
  resumed: "Sharing resumed.",
  rotated: "New QR access created. Add your pass again to pick up the new QR.",
  removed: "Wallet profile removed.",
} as const;

/** Explanations shown before every action that changes or ends sharing. */
export const WALLET_CARD_CONFIRMATIONS = {
  pause: {
    title: "Pause sharing?",
    body: "Anyone who scans your pass will see nothing at all — the page behaves as if the profile does not exist. Your pass stays in Apple Wallet and you can resume sharing at any time.",
    confirmLabel: "Pause sharing",
  },
  resume: {
    title: "Resume sharing?",
    body: "Your selected information becomes visible again to anyone who scans your pass. The QR is unchanged, so a pass already in Apple Wallet keeps working.",
    confirmLabel: "Resume sharing",
  },
  rotate: {
    title: "Rotate QR access?",
    body: "The current QR stops working immediately, so anyone holding the old link loses access. A new link is created and you will need to add the pass to Apple Wallet again to pick up the new QR.",
    confirmLabel: "Rotate QR access",
  },
  remove: {
    title: "Remove Wallet profile?",
    body: "Sharing stops immediately and anyone who scans sees that this profile is no longer shared. The pass in Apple Wallet stops resolving. This cannot be undone — you would need to set the Wallet Profile up again.",
    confirmLabel: "Remove Wallet profile",
  },
} as const;
