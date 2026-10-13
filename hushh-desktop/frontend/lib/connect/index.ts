/**
 * lib/connect/index.ts
 *
 * Barrel export for the Connect Tab discovery and people discovery domain layer.
 */

export * from "./types";
export {
  isDiscoverable,
  buildCandidateId,
  mergeSourceTypes,
  hasConnectionSource,
  isVisibilityPostureDiscoverable,
} from "./connect-visibility";

export {
  CONNECT_SCORES,
  REASON_LABELS,
  computeQueryScore,
  computeConnectionStatusScore,
  computeSourceScore,
  applyScoreToCandidate,
  sortCandidatesByScore,
  filterPassedCandidates,
} from "./connect-ranking";

export {
  normalizeRiaToCandidate,
  normalizeInvestorToCandidate,
  normalizeContactMatchToCandidate,
  normalizeConsentEntryToCandidate,
  mergeCandidates,
} from "./candidates";

export {
  loadConnectPayload,
  loadContactMatches,
  type ConnectServiceLoadOptions,
  type ConnectContactLoadResult,
} from "./service";

export { useConnectDiscovery } from "./use-connect-discovery";
