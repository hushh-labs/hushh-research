/** Public status projection; lifecycle authority stays on the server. */
export type PersonalAgentStatus = {
  filesActivationAvailable?: boolean;
  state?: string | null;
  featureEnabled?: boolean;
  hushhId?: string | null;
  health?: string | null;
  lastSeenAt?: string | null;
  cloudProject?: string | null;
  cloudRegion?: string | null;
  deploymentTarget?: string | null;
  hostingMode?: "shared" | "byoc" | "hussh_pods" | "pending" | "unknown" | "unplaced";
  credentialMode?: string | null;
  runningImage?: string | null;
  targetImage?: string | null;
  updateAvailable?: boolean;
  updateOfferable?: boolean;
  updateInstallable?: boolean;
  updateInProgress?: boolean;
  updateFailed?: boolean;
  updateError?: string | null;
  updateVerified?: boolean;
  installedReleaseVerified?: boolean;
  installedReleaseVerifiedAt?: string;
  releaseCheckedAt?: string;
  installedRelease?: { version: string; sourceRevision?: string; imageDigest?: string };
  completedUpdate?: {
    operationId: string;
    releaseId: string;
    podIncarnation: string;
    imageDigest: string;
    verifiedAt: string;
    version?: string;
    releasedAt?: string;
    notes?: { improvements: string[]; fixes: string[]; security: string[] };
  };
  availableRelease?: {
    version: string;
    summary: string;
    releasedAt: string;
    notes: { improvements: string[]; fixes: string[]; security: string[] };
  };
  update?: {
    releaseId?: string;
    summary: string;
    presentationState: "ready" | "deferred" | "scheduled" | "updating" | "verified" | "blocked";
    phase?: "scheduled" | "preparing" | "installing" | "verifying" | "verified" | "blocked";
    remindAt?: string;
    reminderDue?: boolean;
    operationId?: string;
    verifiedAt?: string;
  };
};
