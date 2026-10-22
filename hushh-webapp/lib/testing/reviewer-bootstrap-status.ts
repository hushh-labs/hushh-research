export function updateBootstrapStatus(
  stage: string,
  options?: { userId?: string | null; errorClass?: string | null; detail?: string | null; invalidate?: boolean }
) {
  if (typeof window === "undefined") {
    return;
  }
  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (!bridge?.enabled) {
    return;
  }
  const stageRank: Record<string, number> = {
    waiting_auth: 10,
    authenticating: 20,
    authenticated: 30,
    waiting_vault_user: 35,
    loading_vault_state: 40,
    unlocking_vault: 50,
    vault_unlocked: 60,
    auth_error: 70,
    uid_mismatch: 70,
    vault_error: 70,
  };
  const currentStage = bridge.bootstrapState || "";
  const currentRank = stageRank[currentStage] ?? 0;
  const nextRank = stageRank[stage] ?? 0;
  const failureStages = new Set(["auth_error", "uid_mismatch", "vault_error"]);
  const isRecoveringFromFailure =
    failureStages.has(currentStage) && !failureStages.has(stage);
  if (nextRank < currentRank && !isRecoveringFromFailure && !options?.invalidate) {
    return;
  }
  bridge.bootstrapState = stage;
  bridge.bootstrapUserId = options?.userId ?? bridge.bootstrapUserId ?? "";
  bridge.bootstrapError = "";
  bridge.bootstrapErrorClass = options?.errorClass ?? "";
  // Where the identity that decided this stage came from, plus a uid prefix,
  // so a device run explains a mismatch without a console attached.
  bridge.bootstrapDetail = options?.detail ?? "";
}
