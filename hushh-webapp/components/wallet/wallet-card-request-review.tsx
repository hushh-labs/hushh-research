"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  WalletCardAccessService,
  CardRequestStateError,
} from "@/lib/services/wallet-card-access-service";
import {
  prepareTemporaryCardShares,
  CardRecipientKeyUnavailableError,
  type CardShareContext,
} from "@/lib/services/wallet-card-share-service";
import {
  WalletService,
  type WalletCardSummary,
} from "@/lib/services/wallet-service";
import { type WalletCardRequest } from "@/lib/wallet/card-request";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";
import {
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { cardNetworkLabel } from "./card-network-mark";

const STATUS_COPY = {
  fulfilled: "Card sent",
  declined: "Request declined",
  cancelled: "Request withdrawn",
  expired: "Request expired",
};

export function WalletCardRequestReview({
  requestId,
  cards,
  getContext,
  onClose,
}: {
  requestId: string;
  cards: readonly WalletCardSummary[];
  getContext: (cardId: string) => CardShareContext | null;
  onClose: () => void;
}) {
  const [request, setRequest] = useState<WalletCardRequest | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileState, setProfileState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [selected, setSelected] = useState("");
  const [duration, setDuration] = useState<15 | 60 | 120>(15);
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reload, setReload] = useState(0);
  const epoch = useSyncExternalStore(
    subscribeVaultSessionEpoch,
    snapshotVaultSessionEpoch,
    () => 0,
  );
  const generation = useRef(0),
    mounted = useRef(true),
    sending = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    const revision = ++generation.current,
      controller = new AbortController(),
      context = getContext("");
    setRequest(null);
    setProfileId(null);
    setProfileState("loading");
    setSelected("");
    setError(null);
    setFailed(false);
    setBusy(false);
    if (!context) return () => controller.abort();
    const current = () =>
      mounted.current &&
      revision === generation.current &&
      context.isCurrent() &&
      !controller.signal.aborted;
    void WalletCardAccessService.getRequest(
      context,
      requestId,
      controller.signal,
    )
      .then(async (result) => {
        if (!current()) return;
        setRequest(result);
        if (result.role === "owner" && result.status === "pending") {
          try {
            const profile = await WalletCardAccessService.profile(
              context,
              controller.signal,
            );
            if (current()) {
              setProfileId(profile.eligible ? profile.cardId : null);
              setProfileState("ready");
            }
          } catch {
            if (current()) setProfileState("failed");
          }
        }
      })
      .catch(() => {
        if (current()) setFailed(true);
      });
    return () => {
      controller.abort();
      generation.current += 1;
    };
  }, [getContext, requestId, epoch, reload]);
  useEffect(() => {
    const resume = () => {
      generation.current += 1;
      setSelected("");
      setBusy(false);
      if (document.visibilityState === "visible")
        setReload((value) => value + 1);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
  const operationContext = () => {
    const base = getContext(""),
      revision = generation.current;
    return base
      ? {
          ...base,
          isCurrent: () =>
            mounted.current &&
            revision === generation.current &&
            base.isCurrent(),
        }
      : null;
  };
  const share = async () => {
    const context = operationContext();
    if (
      !request ||
      request.role !== "owner" ||
      request.status !== "pending" ||
      !selected ||
      !context ||
      sending.current
    )
      return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify([
      context.userId,
      requestId,
      selected,
      duration,
    ]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: walletOperationId() };
    try {
      const fresh = await WalletCardAccessService.getRequest(
        context,
        requestId,
      );
      if (!context.isCurrent()) return;
      if (fresh.status !== "pending") {
        setRequest(fresh);
        return;
      }
      if (
        fresh.role !== "owner" ||
        fresh.requesterPersonRef !== request.requesterPersonRef
      )
        throw new Error("Request changed.");
      const state = await WalletCardAccessService.state(context, selected);
      if (!context.isCurrent()) return;
      const isProfile = selected === profileId;
      if (!isProfile && !cards.some((card) => card.cardId === selected))
        throw new Error("Card unavailable.");
      if (!state.eligible) {
        if (isProfile) throw new Error("Profile unavailable.");
        await WalletService.prepareCardSharing({
          ...context,
          cardId: selected,
        });
      }
      if (!context.isCurrent()) return;
      const refs = [fresh.requesterPersonRef];
      const encrypted = isProfile
        ? undefined
        : await prepareTemporaryCardShares(context, selected, refs);
      if (!context.isCurrent()) return;
      await WalletCardAccessService.share(
        context,
        selected,
        refs,
        duration,
        attempt.current.id,
        encrypted,
        requestId,
      );
      if (!context.isCurrent()) return;
      setRequest({ ...fresh, status: "fulfilled" });
      setSelected("");
      attempt.current = null;
      CacheSyncService.onFeedChanged(context.userId);
    } catch (failure) {
      if (context.isCurrent())
        setError(
          failure instanceof CardRecipientKeyUnavailableError
            ? failure.message
            : failure instanceof CardRequestStateError
              ? "This request is no longer available. Close it and check your Feed."
              : "Could not confirm sharing. Retry to check the same response.",
        );
    } finally {
      sending.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  const decline = async () => {
    const context = operationContext();
    if (!context || !request || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await WalletCardAccessService.decideRequest(
        context,
        requestId,
        request.role === "owner" ? "decline" : "cancel",
      );
      if (context.isCurrent()) {
        setRequest(result);
        CacheSyncService.onFeedChanged(context.userId);
      }
    } catch {
      if (context.isCurrent())
        setError("Could not update this request. Please retry.");
    } finally {
      sending.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  const pendingOwner =
    request?.status === "pending" && request.role === "owner";
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) {
          generation.current += 1;
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {pendingOwner ? "Choose a card to share" : "Card request"}
          </DialogTitle>
          <DialogDescription>
            {request
              ? request.role === "owner"
                ? `${request.requesterName} requested a card from you.`
                : `You requested a card from ${request.ownerName}.`
              : "Checking this request…"}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <div role="alert">
            <p>This request is unavailable.</p>
            <Button
              variant="secondary"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {request?.status !== "pending" && request ? (
          <p role="status">{STATUS_COPY[request.status]}</p>
        ) : null}
        {request?.role === "requester" && request.status === "pending" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Waiting for them to choose a card.
          </p>
        ) : null}
        {pendingOwner ? (
          <>
            <fieldset disabled={busy} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Card</legend>
              {profileId ? (
                <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border p-3">
                  <input
                    type="radio"
                    name="response-card"
                    value={profileId}
                    checked={selected === profileId}
                    onChange={() => setSelected(profileId)}
                  />
                  Agent One Profile
                </label>
              ) : null}
              {cards.map((card) => (
                <label
                  key={card.cardId}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border p-3"
                >
                  <input
                    type="radio"
                    name="response-card"
                    value={card.cardId}
                    checked={selected === card.cardId}
                    onChange={() => setSelected(card.cardId)}
                  />
                  <span>
                    {card.nickname || cardNetworkLabel(card.brand)} · ••••{" "}
                    {card.last4}
                  </span>
                </label>
              ))}
              {profileState === "loading" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Checking your Profile Card…
                </p>
              ) : null}
              {profileState === "failed" ? (
                <div role="alert" className="text-sm">
                  <p>Could not load your Profile Card.</p>
                  <Button
                    variant="secondary"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Retry Profile Card
                  </Button>
                </div>
              ) : null}
              {profileState === "ready" && !profileId && !cards.length ? (
                <p className="text-sm text-muted-foreground">
                  Add a card to Wallet, then reopen this request to share it.
                </p>
              ) : null}
              <label className="flex flex-col gap-2 text-sm font-medium">
                Access duration
                <select
                  className="min-h-11 rounded-[var(--app-input-radius)] border bg-background px-3 text-sm"
                  value={duration}
                  onChange={(event) =>
                    setDuration(Number(event.target.value) as 15 | 60 | 120)
                  }
                >
                  <option value={15}>15 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={120}>2 hours</option>
                </select>
              </label>
            </fieldset>
            <p className="text-sm text-muted-foreground">
              Only {request.requesterName} will receive this card.
            </p>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <FlowActionGroup
          primary={
            pendingOwner ? (
              <Button disabled={busy || !selected} onClick={() => void share()}>
                {busy ? "Sharing…" : "Share card"}
              </Button>
            ) : (
              <Button onClick={onClose} disabled={busy}>
                Done
              </Button>
            )
          }
          secondary={
            request?.status === "pending" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void decline()}
              >
                {request.role === "owner" ? "Decline" : "Withdraw request"}
              </Button>
            ) : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}
