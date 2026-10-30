import type { LocationPkmFinalizeAuthorizationV1 } from "@/lib/services/one-location-onboarding-run-client";

/** Transient wire adapter. This capability is never stored in a checkpoint or log. */
export function locationFinalizeWire(
  value: LocationPkmFinalizeAuthorizationV1,
) {
  return {
    schema_version: value.schemaVersion,
    authorization_id: value.authorizationId,
    token: value.token,
    run_id: value.runId,
    run_revision: value.runRevision,
    lease_id: value.leaseId,
    directive_id: value.directiveId,
    draft_ref: value.draftRef,
    draft_digest: value.draftDigest,
    expected_commit_id: value.expectedCommitId,
    expires_at: value.expiresAt,
  };
}
export type LocationFinalizeWire = ReturnType<typeof locationFinalizeWire>;
