/** Rollback switches for phone availability fixes; neither switch grants identity authority. */
export function getPhoneReliabilityFlags(): { recovery: boolean; sessionFencing: boolean } {
  return {
    recovery: process.env.NEXT_PUBLIC_AUTH_PHONE_RECOVERY_ENABLED !== "false",
    sessionFencing: process.env.NEXT_PUBLIC_AUTH_PHONE_SESSION_FENCING_ENABLED !== "false",
  };
}
