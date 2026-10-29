"use client";
/**
 * Receipt sync on by default. One bounded sync through the shared Mail Receipts
 * resource (its dedupe, progress, owner and vault fences, encrypted device
 * snapshot), started by a chat receipt question that finds nothing saved, or in
 * the background after unlock or a Gmail connection. No second store or endpoint.
 */
import { getConnectorView } from "@/lib/profile/gmail-connector-store";
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { ReceiptStoreSession } from "./receipt-store";

/** `unavailable`: Mail isn't connected for sync here, so nothing was started. */
export type DeviceReceiptSync = "synced" | "failed" | "unavailable";

export const RECEIPT_SYNC_BUDGET_MS = 45_000;
const BACKGROUND_STALE_MS = 24 * 60 * 60_000;
let auth: { ownerId: string; getIdToken: () => Promise<string> } | null = null;
const backgroundEpochs = new Map<string, number>();

/** The signed-in owner's ID token source; the returned release forgets it. */
export function registerReceiptSyncAuth(ownerId: string, getIdToken: () => Promise<string>): () => void {
  const registration = { ownerId, getIdToken };
  auth = registration;
  return () => { if (auth === registration) auth = null; };
}

/** The connected Mail account and token source a sync needs, from state the app already holds. */
function syncInputs(ownerId: string) {
  const status = getConnectorView(ownerId).status;
  const usable = status?.connected === true && !status.revoked && status.needs_reauth !== true && status.receipt_sync_available !== false;
  const account = usable ? status.google_sub || status.google_email || null : null;
  return account && auth?.ownerId === ownerId ? { account, getIdToken: auth.getIdToken } : null;
}

/** Saves this device's receipts within the budget. `synced` only when a snapshot was written. */
export async function syncReceiptsOnDevice(session: ReceiptStoreSession, onStart?: () => void,
  budgetMs = RECEIPT_SYNC_BUDGET_MS): Promise<DeviceReceiptSync> {
  const inputs = syncInputs(session.userId);
  if (!inputs || !(session.isCurrent?.() ?? true)) return "unavailable";
  onStart?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Past the budget the turn answers honestly; the shared sync may still finish for the next question.
  const deadline = new Promise<"failed">(resolve => { timer = setTimeout(() => resolve("failed"), budgetMs); });
  try {
    return await Promise.race([
      MailReceiptResourceService.refresh(session, inputs.account, inputs.getIdToken).then(() => "synced" as const, () => "failed" as const),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * At most once per owner, account and vault session: restore the saved
 * receipts, and sync only when none are saved, an earlier sync was interrupted,
 * or they are a day old. A restore that fails stays unknown and never starts a scan.
 */
export async function startBackgroundReceiptSync(session: ReceiptStoreSession): Promise<DeviceReceiptSync | "skipped"> {
  const inputs = syncInputs(session.userId);
  if (!inputs) return "unavailable";
  const epoch = snapshotVaultSessionEpoch();
  const key = JSON.stringify([session.userId, inputs.account]);
  if (backgroundEpochs.get(key) === epoch) return "skipped";
  backgroundEpochs.set(key, epoch);
  try {
    let saved;
    try {
      saved = await MailReceiptResourceService.hydrate(session, inputs.account);
    } catch {
      return "failed";
    }
    // An interrupted sync (a saved page cursor) resumes; a finished one rests for a day.
    if (saved && !saved.sync?.pending && Date.now() - Date.parse(saved.freshness) < BACKGROUND_STALE_MS) return "skipped";
    if (!isVaultSessionEpochCurrent(epoch) || !(session.isCurrent?.() ?? true)) return "skipped";
    return await syncReceiptsOnDevice(session);
  } finally {
    // A run its session ended (a credential renewal re-runs the bridge) never uses up this vault session.
    if (!(session.isCurrent?.() ?? true) && backgroundEpochs.get(key) === epoch) backgroundEpochs.delete(key);
  }
}
