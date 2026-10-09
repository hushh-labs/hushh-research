"use client";

import { useCallback, useContext, useMemo, useState } from "react";
import { Loader2 } from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { peekReceiptMemoryIndex } from "@/lib/agent/agent-pkm-memory";
import type { ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";
import { Button } from "@/lib/morphy-ux/button";
import {
  RECEIPT_ACTION_RECONNECT_NOTICE,
  RECEIPT_ACTION_REFRESH_NOTICE,
  receiptActionLabel,
} from "@/lib/profile/gmail-receipt-action";
import {
  savedReceiptChatActions,
  type SavedReceiptChatAction,
} from "@/lib/profile/gmail-saved-receipts";
import { GmailReceiptsService, receiptActionFailure } from "@/lib/services/gmail-receipts-service";
import { openExternalUrlWhenResolved } from "@/lib/utils/browser-navigation";
import { VaultContext } from "@/lib/vault/vault-context";

const STATUS_TEXT: Partial<Record<ConnectorReadExperience["status"], string>> = {
  ok: "Saved receipts checked",
  input_required: "Saved receipts need more detail",
  invalid_argument: "Ask about your saved receipts by date, merchant or status",
};

/**
 * The provenance card for an answer read from the owner's saved receipts, with
 * the receipt's verified action beside it when one exists. The link is resolved
 * by the server only when the owner clicks, and is never shown.
 */
export function SavedReceiptsReadReceipt({ experience }: { experience: ConnectorReadExperience }) {
  const { user } = useAuth();
  const vaultOwnerToken = useContext(VaultContext)?.vaultOwnerToken ?? null;
  const ownerId = user?.uid ?? null;
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A reference that stopped naming a link waits; the answer and the rest stay.
  const [stale, setStale] = useState<ReadonlyMap<string, "expired" | "reconnect">>(() => new Map());
  const actions = useMemo(
    () =>
      experience.status === "ok" && ownerId
        ? savedReceiptChatActions(peekReceiptMemoryIndex({ userId: ownerId }), experience.sourceRefs)
        : [],
    [experience.sourceRefs, experience.status, ownerId],
  );

  const open = useCallback(
    async (item: SavedReceiptChatAction) => {
      if (!user || !vaultOwnerToken) {
        setError("Open your private vault to open this receipt.");
        return;
      }
      setBusyRef(item.ref);
      setError(null);
      try {
        await openExternalUrlWhenResolved(async () => {
          const resolved = await GmailReceiptsService.resolveReceiptActionLink({
            idToken: await user.getIdToken(),
            vaultOwnerToken,
            userId: user.uid,
            action: item.action,
          });
          return resolved.url;
        });
      } catch (failure) {
        const reason = receiptActionFailure(failure);
        if (reason !== "failed") {
          setStale((current) => new Map(current).set(item.ref, reason));
          return;
        }
        setError(
          failure instanceof Error && failure.message.trim()
            ? failure.message
            : "We couldn't open that link. Please try again.",
        );
      } finally {
        setBusyRef(null);
      }
    },
    [user, vaultOwnerToken],
  );

  const cited = experience.sourceRefs.length;
  return (
    <section
      aria-label="Saved receipts read details"
      className="min-w-0 space-y-2 text-sm text-muted-foreground"
      data-testid="saved-receipts-read"
    >
      <p role="status">{STATUS_TEXT[experience.status] ?? "Saved receipts are unavailable"}</p>
      {experience.status === "ok" && cited > 0 ? (
        <p>
          From your private memory · {cited} saved {cited === 1 ? "receipt" : "receipts"}
        </p>
      ) : null}
      {experience.status === "ok" && experience.truncated ? (
        <p>More saved receipts match than are shown.</p>
      ) : null}
      {actions.length > 0 ? (
        <ul aria-label="Receipt actions" className="flex min-w-0 flex-wrap gap-2">
          {actions.map((item) => (
            <li className="min-w-0 max-w-full" key={item.ref}>
              <Button
                aria-label={`${receiptActionLabel(item.action.kind)} for ${item.label}`}
                className="max-w-full"
                disabled={busyRef !== null || stale.has(item.ref)}
                onClick={() => void open(item)}
                size="compact"
                type="button"
                variant="muted"
              >
                {busyRef === item.ref ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                <span className="truncate">
                  {receiptActionLabel(item.action.kind)} · {item.label}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {stale.size > 0 ? (
        <p className="text-xs" role="status">
          {[...stale.values()].includes("reconnect")
            ? RECEIPT_ACTION_RECONNECT_NOTICE
            : RECEIPT_ACTION_REFRESH_NOTICE}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
