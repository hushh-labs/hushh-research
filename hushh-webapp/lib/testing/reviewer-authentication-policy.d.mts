export type ReviewerAuthMode = "local_credentials" | "custom_token" | "human_authenticated";
type ReviewerConfig = {
  enabled?: boolean;
  autoReviewerLogin?: boolean;
  reviewerAuthMode?: ReviewerAuthMode;
  expectedUserId?: string | null;
  vaultPassphrase?: string | null;
};
export function resolveReviewerAuthMode(value?: string): ReviewerAuthMode;
export function isHumanReviewerSession(config: ReviewerConfig): boolean;
export function shouldAutoAuthenticateReviewer(config: ReviewerConfig): boolean;
export function canStartReviewerLogin(config: ReviewerConfig, reviewModeEnabled: boolean, hasLocalCredentials: boolean): boolean;
export function shouldBootstrapReviewerVault(config: ReviewerConfig): boolean;
export function humanReviewerAdmissionStage(expectedUid: string | null, currentUid: string | null, loading: boolean, hadIdentity: boolean): "uid_mismatch" | "auth_error" | "waiting_auth" | "authenticated";
export function isHumanReviewerAuthenticationRequest(rawUrl: string, method: string): boolean;
