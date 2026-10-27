import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { currentConsentInvalidationEpoch } from "@/lib/cache/consent-read-after-write";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { requireDocumentSession, type DocumentSession } from "./document-hosting-service";
import { DrivePacketResourceService, DRIVE_PACKET_READ_BUDGET_MS } from "./drive-packet-resource-service";
import { OneCopyService, type OneCopy, type OneCopyActivityPage } from "./one-copy-service";

function scope(session: DocumentSession) {
  requireDocumentSession(session);
  const auth = getAuthSessionGeneration(), vault = snapshotVaultSessionEpoch();
  const consent = currentConsentInvalidationEpoch(session.userId);
  return { key: `${session.userId}:${auth}:${vault}:one-copy:${consent}`, guard: () => {
    requireDocumentSession(session);
    if (getAuthSessionGeneration() !== auth || snapshotVaultSessionEpoch() !== vault ||
      currentConsentInvalidationEpoch(session.userId) !== consent) throw new DOMException("Session changed", "AbortError");
  } };
}
function peek<T>(session: DocumentSession, resource: string): T | null {
  try { return DrivePacketResourceService.peek<T>(scope(session).key, resource); }
  catch { return null; }
}
async function load<T>(session: DocumentSession, resource: string, signal: AbortSignal, force: boolean,
  read: (lease: DocumentSession, signal: AbortSignal) => Promise<T>): Promise<T> {
  const current = scope(session);
  const consumer = () => { signal.throwIfAborted(); current.guard(); };
  return DrivePacketResourceService.load(current.key, resource, consumer, async guard => {
    // A departing mount cannot cancel another current consumer's shared read.
    const lease = { ...session, isCurrent: () => { try { guard(); return true; } catch { return false; } } };
    return read(lease, AbortSignal.timeout(DRIVE_PACKET_READ_BUDGET_MS));
  }, { force });
}
const statusKey = (requestId: string) => `one-copy-status:${requestId}`;
const activityKey = (requestId: string, cursor?: string) => `one-copy-activity:${requestId}:${cursor ?? "first"}`;
/** Display metadata only. Content and every access/mutation check use OneCopyService directly. */
export const OneCopyPresentationService = {
  peekStatus: (session: DocumentSession, requestId: string) => peek<OneCopy>(session, statusKey(requestId)),
  status: (session: DocumentSession, requestId: string, signal: AbortSignal, force = false) =>
    load(session, statusKey(requestId), signal, force, (lease, timeout) => OneCopyService.status(lease, requestId, timeout)),
  peekActivity: (session: DocumentSession, requestId: string) => peek<OneCopyActivityPage>(session, activityKey(requestId)),
  activity: (session: DocumentSession, requestId: string, signal: AbortSignal, cursor?: string, force = false) =>
    load(session, activityKey(requestId, cursor), signal, force, (lease, timeout) => OneCopyService.activity(lease, requestId, timeout, cursor)),
};
