/** Authored form/action vectors only; the parent owns Vite lifetime and emission. */
export async function loadNativeProfileFormArtwork(profileLoader) {
  const rows = await profileLoader.ssrLoadModule("/components/icons/agents/row-icons.tsx");
  const { PROFILE_ICONS } = await profileLoader.ssrLoadModule("/components/icons/profile-icons.ts");
  const payoutInnerIcons = await profileLoader.ssrLoadModule("/components/profile/profile-inner-icons.tsx");
  const payoutSecondaryIcons = await profileLoader.ssrLoadModule("/components/profile/profile-secondary-icons.tsx");
  const { GeminiLogo } = await profileLoader.ssrLoadModule("/components/brand/gemini-logo.tsx");
  const { Brain } = await profileLoader.ssrLoadModule("/components/icons/legacy-ui-icons.tsx");
  const { NATIVE_ACTION_ARTWORK } = await profileLoader.ssrLoadModule("/lib/capacitor/native-action-artwork.ts");
  return [
    ...[...NATIVE_ACTION_ARTWORK].map(([icon, id]) => ({ id, icon })),
    { id: "ai-connection", icon: Brain },
    { id: "style-name", icon: rows.PreferredNameRowIcon },
    { id: "style-tone", icon: rows.ToneRowIcon },
    { id: "style-length", icon: rows.ReplyLengthRowIcon },
    { id: "style-language", icon: rows.LanguageRowIcon },
    { id: "style-punctuation", icon: rows.PunctuationRowIcon },
    { id: "account-name", icon: PROFILE_ICONS.name },
    { id: "account-mail", icon: PROFILE_ICONS.mail },
    { id: "account-phone", icon: PROFILE_ICONS.phone },
    { id: "account-wallet", icon: PROFILE_ICONS.wallet },
    { id: "account-reset", icon: PROFILE_ICONS.reset },
    { id: "account-delete", icon: PROFILE_ICONS.delete },
    { id: "appearance", icon: PROFILE_ICONS.appearance },
    { id: "accent", icon: PROFILE_ICONS.accent },
    { id: "voice", icon: PROFILE_ICONS.voice },
    { id: "vault-methods", icon: PROFILE_ICONS.vault },
    { id: "vault-password", icon: PROFILE_ICONS.passphrase },
    { id: "payout-receipt", icon: payoutSecondaryIcons.ProfileSecondaryReceiptIcon },
    { id: "payout-warning", icon: payoutInnerIcons.ProfileInnerWarningIcon },
    { id: "payout-progress", icon: payoutInnerIcons.ProfileInnerProgressIcon },
    { id: "payout-review", icon: payoutInnerIcons.ProfileInnerReviewIcon },
    { id: "referral-link", icon: rows.LinkRowIcon },
    { id: "referral-join", icon: rows.JoinRowIcon },
    { id: "referral-agent", icon: rows.UseAgentRowIcon },
    { id: "referral-qualified", icon: rows.QualifiedRowIcon },
    { id: "referral-success", icon: rows.SuccessRowIcon },
    { id: "referral-people", icon: rows.PeopleRowIcon },
    { id: "referral-progress", icon: rows.ProgressRowIcon },
    { id: "referral-review", icon: rows.ReviewRowIcon },
    { id: "referral-warning", icon: rows.WarningRowIcon },
    { id: "gemini", icon: GeminiLogo, original: true, size: 32 },
  ];
}
