import type {
  KaiCircleCandidate,
  KaiCircleCta,
  OneLocationViewerCapabilities,
} from "@/lib/one-location/types";

export function resolveKaiCircleCtas(params: {
  candidate: KaiCircleCandidate;
  mode: "share" | "request";
  viewerCapabilities?: OneLocationViewerCapabilities | null;
  hasActiveOwnerGrant?: boolean;
  hasReceivedGrant?: boolean;
  hasPendingOwnerRequest?: boolean;
}): KaiCircleCta[] {
  const { candidate, mode, viewerCapabilities } = params;
  const ctas: KaiCircleCta[] = [];

  if (params.hasPendingOwnerRequest) {
    ctas.push(
      { id: "approve", label: "Approve", enabled: candidate.isShareReady },
      { id: "deny", label: "Deny", enabled: true },
    );
    return ctas;
  }

  if (params.hasReceivedGrant) {
    ctas.push({ id: "view_shared_location", label: "View Shared Location", enabled: true });
  }

  if (params.hasActiveOwnerGrant) {
    ctas.push({ id: "revoke_access", label: "Revoke Access", enabled: true });
  }

  if (!candidate.userId || candidate.isPublicProfileOnly) {
    ctas.push({
      id: "open_connect_profile",
      label: "Invite to One",
      enabled: Boolean(candidate.profileHref || candidate.connectionHref),
    });
    return ctas;
  }

  if (mode === "share") {
    if (candidate.isShareReady) {
      ctas.push({ id: "share_location", label: "Share Location", enabled: true });
    } else {
      ctas.push({
        id: "ask_to_setup_one_location",
        label: "Ask to Setup One Location",
        enabled: true,
        reason: "They need a One Location recipient key before private sharing.",
      });
    }
  } else {
    ctas.push({
      id: "request_location",
      label: "Request Location",
      enabled: viewerCapabilities?.canRequestLocation !== false,
      reason:
        viewerCapabilities?.hasLocationRecipientKey === false
          ? "Your One Location key will be set up before sending the request."
          : null,
    });
  }

  if (candidate.profileHref || candidate.connectionHref) {
    ctas.push({
      id: "open_connect_profile",
      label: "Open Connect Profile",
      enabled: true,
    });
  }

  return ctas;
}
