/** Typed direct connection and memory-only reachability; never an authority grant. */
import { canonicalJson } from "./owner-pod-crypto";

export type PinnedEndpoint = {
  hushhId: string;
  url: string;
  podKeyId: string;
  environment: string;
  endpointVersion: number;
  signature: string;
  pinnedAt: number;
  /** Pins from the former prefix-only verifier must be admitted again once. */
  verificationVersion: 1;
};

export type PodSessionRecord = {
  session: string;
  sid: string;
  role: "app";
  scopes: string[];
  epoch: number;
  expiresAt: number;
  version: number;
  subjectId: string;
  /** Verified grant ceiling; renewal cannot extend owner authorization. */
  grantExpiresAt?: number;
};

export type OwnerPodConnection = {
  endpoint: PinnedEndpoint;
  session: PodSessionRecord;
  /** Memory-only evidence of validated direct admission, never authorization. */
  directVerifiedAt?: number;
};

const directAdmissions = new Map<string, { identity: string; at: number }>();

function admissionIdentity(endpoint: PinnedEndpoint, session: PodSessionRecord): string {
  return canonicalJson({ endpoint, sid: session.sid, epoch: session.epoch, version: session.version });
}

export function recordDirectAdmission(userId: string, endpoint: PinnedEndpoint, session: PodSessionRecord, at: number): void {
  directAdmissions.set(userId, { identity: admissionIdentity(endpoint, session), at });
}

export function forgetDirectAdmission(userId: string): void {
  directAdmissions.delete(userId);
}

export function observedConnection(userId: string, endpoint: PinnedEndpoint, session: PodSessionRecord): OwnerPodConnection {
  const admission = directAdmissions.get(userId);
  const directVerifiedAt = admission?.identity === admissionIdentity(endpoint, session)
    ? admission.at : undefined;
  return { endpoint, session, directVerifiedAt };
}
