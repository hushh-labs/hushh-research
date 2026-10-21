"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import {
  CardRequestStateError,
  WalletCardAccessService,
} from "@/lib/services/wallet-card-access-service";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { Button } from "@/lib/morphy-ux/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

export function RequestCardsButton({
  personRef,
  personName,
  className,
  renderTrigger,
  canRequest = true,
  showTrigger = true,
}: {
  personRef: string;
  personName: string;
  className?: string;
  renderTrigger?: (label: string) => ReactNode;
  canRequest?: boolean;
  showTrigger?: boolean;
}) {
  const { user } = useAuth();
  const { vaultOwnerToken, vaultKey, isVaultUnlocked } = useVault();
  const epoch = useSyncExternalStore(
    subscribeVaultSessionEpoch,
    snapshotVaultSessionEpoch,
    () => 0,
  );
  const [open, setOpen] = useState(false),
    [unlockOpen, setUnlockOpen] = useState(false);
  const [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false),
    [error, setError] = useState<string | null>(null);
  const current = useRef({
    user,
    token: vaultOwnerToken,
    vaultKey,
    unlocked: isVaultUnlocked,
    personRef,
  });
  current.current = {
    user,
    token: vaultOwnerToken,
    vaultKey,
    unlocked: isVaultUnlocked,
    personRef,
  };
  const mounted = useRef(true),
    sending = useRef(false),
    attempt = useRef(walletOperationId());
  const visibilityRevision = useRef(0);
  const eligibility = useRef(canRequest);
  eligibility.current = canRequest;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const change = () => {
      visibilityRevision.current += 1;
      setOpen(false);
      setBusy(false);
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    // Credential renewal revalidates transport authority without dismissing a
    // review or receipt. A true lock/person/account change still retires it.
    if (!isVaultUnlocked) setOpen(false);
    setBusy(false);
    setError(null);
  }, [isVaultUnlocked, vaultOwnerToken, epoch]);
  useEffect(() => {
    setOpen(false);
    setBusy(false);
    setError(null);
  }, [user?.uid, personRef]);
  const review = () => {
    if (!user || sent) return false;
    if (!isVaultUnlocked || !vaultOwnerToken) {
      setUnlockOpen(true);
      return false;
    }
    setError(null);
    setOpen(true);
    return true;
  };
  useLocalOnboardingActionHandler(
    "people.profile.request_card",
    async () =>
      review()
        ? { status: "succeeded", summary: "Card request review opened." }
        : {
            status: "blocked",
            summary: "Unlock your wallet before requesting a card.",
          },
    { enabled: Boolean(user) && !sent },
  );
  const send = async () => {
    const owner = current.current,
      operationEpoch = snapshotVaultSessionEpoch(),
      visibility = visibilityRevision.current;
    const isCurrent = () =>
      mounted.current &&
      visibilityRevision.current === visibility &&
      document.visibilityState !== "hidden" &&
      current.current.user?.uid === owner.user?.uid &&
      current.current.token === owner.token &&
      current.current.vaultKey === owner.vaultKey &&
      current.current.unlocked &&
      current.current.personRef === owner.personRef &&
      isVaultSessionEpochCurrent(operationEpoch);
    if (
      sending.current ||
      !eligibility.current ||
      !owner.user ||
      !owner.token ||
      !owner.vaultKey ||
      !isCurrent()
    )
      return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const context = {
        userId: owner.user.uid,
        vaultOwnerToken: owner.token,
        vaultKey: owner.vaultKey,
        getIdToken: () => owner.user!.getIdToken(),
        isCurrent,
        canDispatch: () => eligibility.current,
      };
      // Establish the existing recipient key so a first-time requester can receive
      // the owner's encrypted response; no payment card is read here.
      const key = await bootstrapCurrentUserLocationRecipientKey({
        ...context,
        strictRecovery: true,
      });
      if (!isCurrent()) return;
      if (!eligibility.current) {
        setError("Your connection needs to be confirmed before sending. Your review is kept.");
        return;
      }
      if (key.userId !== owner.user.uid || !key.publicKeyJwk)
        throw new Error("Recipient key unavailable.");
      await WalletCardAccessService.createRequest(
        context,
        owner.personRef,
        attempt.current,
      );
      if (isCurrent()) {
        setSent(true);
        setOpen(false);
      }
    } catch (failure) {
      if (isCurrent())
        setError(
          failure instanceof CardRequestStateError &&
            failure.code === "WALLET_CARD_REQUEST_PENDING"
            ? "A card request is already waiting for this person."
            : "Could not confirm your request. Retry to check the same request.",
        );
    } finally {
      sending.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <>
      {showTrigger ? <Button
        type="button"
        variant="none"
        effect="fade"
        className={className}
        onClick={review}
        disabled={sent}
        data-voice-control-id="person-profile-request-card"
      >
        {renderTrigger?.(sent ? "Card request sent" : "Request cards") ?? (sent ? "Card request sent" : "Request cards")}
      </Button> : null}
      <Dialog
        open={open && isVaultUnlocked}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Request a card</DialogTitle>
            <DialogDescription>
              Ask {personName} to choose a card to share with you.
            </DialogDescription>
          </DialogHeader>
          {!canRequest ? <p role="status" className="text-sm text-muted-foreground">Your connection needs to be confirmed before sending.</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <FlowActionGroup
            primary={
              <Button
                type="button"
                variant="blue-gradient"
                effect="fill"
                disabled={busy || !canRequest}
                onClick={() => void send()}
              >
                {busy ? "Sending…" : "Send request"}
              </Button>
            }
            secondary={
              <Button
                type="button"
                variant="none"
                effect="fade"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            }
          />
        </DialogContent>
      </Dialog>
      {user && unlockOpen ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onSuccess={() => setUnlockOpen(false)}
          title="Unlock your wallet"
          description="Unlock to request a card."
          allowVaultCreation={false}
        />
      ) : null}
    </>
  );
}
