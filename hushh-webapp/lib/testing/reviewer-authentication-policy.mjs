/** Authentication policy for the explicitly injected, memory-only reviewer bridge. */
export function resolveReviewerAuthMode(value = "local_credentials") {
  const mode = value || "local_credentials";
  if (!["local_credentials", "custom_token", "human_authenticated"].includes(mode)) {
    throw new Error("Unsupported reviewer authentication mode.");
  }
  return mode;
}

export function isHumanReviewerSession(config) {
  return config.enabled === true && config.reviewerAuthMode === "human_authenticated";
}

export function shouldAutoAuthenticateReviewer(config) {
  return config.enabled === true && config.autoReviewerLogin === true && !isHumanReviewerSession(config);
}

export function canStartReviewerLogin(config, reviewModeEnabled, hasLocalCredentials) {
  return !isHumanReviewerSession(config) && Boolean(reviewModeEnabled || config.autoReviewerLogin || hasLocalCredentials);
}

export function shouldBootstrapReviewerVault(config) {
  return shouldAutoAuthenticateReviewer(config) && Boolean(config.expectedUserId && config.vaultPassphrase);
}

export function humanReviewerAdmissionStage(expectedUid, currentUid, loading, hadIdentity) {
  if (!expectedUid || currentUid && currentUid !== expectedUid) return "uid_mismatch";
  if (!currentUid && hadIdentity) return "auth_error";
  if (loading || !currentUid) return "waiting_auth";
  return "authenticated";
}

export function isHumanReviewerAuthenticationRequest(rawUrl, method) {
  if (method !== "POST") return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.origin === "https://identitytoolkit.googleapis.com") {
    return ["/v1/accounts:signInWithIdp", "/v1/accounts:lookup"].includes(url.pathname);
  }
  if (url.origin === "https://securetoken.googleapis.com") return url.pathname === "/v1/token";
  return url.origin === "https://accounts.google.com" &&
    ["/signin/", "/v3/signin/", "/_/signin/", "/o/oauth2/"].some(prefix => url.pathname.startsWith(prefix));
}
