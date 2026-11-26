"use client";
/**
 * Receipt sync on by default. One bounded sync through the shared Mail Receipts
 * resource (its dedupe, progress, owner and vault fences, encrypted device
 * snapshot), started by a chat receipt question that finds nothing saved, or in
 * the background after unlock or a Gmail connection. No second store or endpoint.
 */
import { MailReceiptResourceService } from "@/lib/services/mail-receipt-resource-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { PrivateReceiptMailbox } from "@/lib/services/gmail-receipts-service";
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
async function syncInputs(ownerId: string) {
  // Loaded lazily like knownGmailConnection: browser layout fixtures stub this store.
  const { getConnectorView } = await import("@/lib/profile/gmail-connector-store");
  const identity = () => {
    const status = getConnectorView(ownerId).status;
    if (!status?.connected || status.revoked || status.needs_reauth || status.receipt_sync_available === false) return null;
    return status.google_sub || status.google_email || null;
  };
  const account = identity();
  const registration = auth;
  if (!account || registration?.ownerId !== ownerId) return null;
  return { account, getIdToken: registration.getIdToken,
    isCurrent: () => auth === registration && identity() === account };
}

/** Saves this device's receipts within the budget. `synced` only when a snapshot was written. */
export async function syncReceiptsOnDevice(session: ReceiptStoreSession, onStart?: () => void,
  budgetMs = RECEIPT_SYNC_BUDGET_MS): Promise<DeviceReceiptSync> {
  const inputs = await syncInputs(session.userId);
  if (!inputs) return "unavailable";
  return syncMailbox(session, inputs, onStart, budgetMs);
}

type SyncInputs = NonNullable<Awaited<ReturnType<typeof syncInputs>>> & { privateMailbox?: PrivateReceiptMailbox };

async function syncMailbox(session: ReceiptStoreSession, inputs: SyncInputs,
  onStart?: () => void, budgetMs = RECEIPT_SYNC_BUDGET_MS): Promise<DeviceReceiptSync> {
  const isCurrent = () => inputs.isCurrent() && (session.isCurrent?.() ?? true);
  if (!isCurrent()) return "unavailable";
  onStart?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Past the budget the turn answers honestly; the shared sync may still finish for the next question.
  const deadline = new Promise<"failed">(resolve => { timer = setTimeout(() => resolve("failed"), budgetMs); });
  try {
    return await Promise.race([
      MailReceiptResourceService.refresh({ ...session, isCurrent }, inputs.account, inputs.getIdToken, ...(inputs.privateMailbox ? [{ privateMailbox: inputs.privateMailbox }] : [])).then(() => "synced" as const, () => "failed" as const),
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
export async function startBackgroundReceiptSync(session: ReceiptStoreSession, selected?: SyncInputs): Promise<DeviceReceiptSync | "skipped"> {
  const inputs = selected ?? await syncInputs(session.userId);
  if (!inputs) return "unavailable";
  const epoch = snapshotVaultSessionEpoch();
  const key = JSON.stringify([session.userId, inputs.account]);
  if (backgroundEpochs.get(key) === epoch) return "skipped";
  backgroundEpochs.set(key, epoch);
  try {
    let saved;
    try {
      saved = await MailReceiptResourceService.hydrate({ ...session, isCurrent: () => inputs.isCurrent() && (session.isCurrent?.() ?? true) }, inputs.account);
    } catch {
      return "failed";
    }
    // An interrupted sync (a saved page cursor) resumes; a finished one rests for a day.
    if (saved && !saved.sync?.pending && Date.now() - Date.parse(saved.freshness) < BACKGROUND_STALE_MS) return "skipped";
    if (!isVaultSessionEpochCurrent(epoch) || !(session.isCurrent?.() ?? true)) return "skipped";
    return await syncMailbox(session, inputs);
  } finally {
    // A run its session ended (a credential renewal re-runs the bridge) never uses up this vault session.
    if (!(session.isCurrent?.() ?? true) && backgroundEpochs.get(key) === epoch) backgroundEpochs.delete(key);
  }
}
