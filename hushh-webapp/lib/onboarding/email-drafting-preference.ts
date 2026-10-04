/**
 * Compatibility shim while the retired one@ mailbox setup screen is removed
 * from generated navigation. Personal Gmail KYC has its own monitor setting.
 */
export async function loadEmailDraftingEnabled(_: { userId: string; idToken: string }): Promise<boolean> {
  return false;
}

export async function saveEmailDraftingEnabled(_: {
  userId: string;
  idToken: string;
  enabled: boolean;
}): Promise<boolean> {
  return false;
}
