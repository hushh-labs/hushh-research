"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Lock, Share2, Wallet } from "lucide-react";
import { toast } from "sonner";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { Button } from "@/lib/morphy-ux/morphy";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { useVault } from "@/lib/vault/vault-context";
import {
  normalizePublicWalletCard,
  PublicWalletCardSkeleton,
  PublicWalletCardView,
  type PublicWalletCard,
} from "@/components/wallet-card/public-card-view";
import {
  WALLET_CARD_CONFIRMATIONS,
  WALLET_CARD_COPY,
  WALLET_CARD_OWNER_COPY,
} from "@/components/wallet-card/wallet-card-copy";
import { WalletCardConfirmDialog } from "@/components/wallet-card/wallet-card-confirm-dialog";
import {
  EMPTY_WALLET_CARD_DRAFT,
  buildSmartDefaultDraft,
  draftFromPayload,
  draftToPayload,
  hasValidationErrors,
  validateDraft,
  type WalletCardDraft,
  type WalletCardValidationErrors,
} from "@/components/wallet-card/wallet-card-fields";
import {
  WalletCardManage,
  type WalletCardManageAction,
} from "@/components/wallet-card/wallet-card-manage";
import { WalletCardPassPreview } from "@/components/wallet-card/wallet-card-pass-preview";
import { WalletCardSetup } from "@/components/wallet-card/wallet-card-setup";
import {
  copyWalletCardLink,
  isShareAbortError,
  shareWalletCardLink,
} from "@/components/wallet-card/wallet-card-share";
import {
  canAddToAppleWallet,
  WalletCardPayloadError,
  WalletCardService,
  type WalletCardPreferredContact,
  type WalletCardRecord,
  type WalletCardShareLink,
} from "@/lib/services/wallet-card-service";

type WalletCardStage =
  | "loading"
  | "locked"
  | "unavailable"
  | "error"
  | "intro"
  | "edit"
  | "preview"
  | "success"
  | "manage";

type ConfirmKind = "pause" | "resume" | "rotate" | "remove";

type VisitorPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; card: PublicWalletCard }
  | { status: "error"; message: string };

/**
 * Owner workspace for the Wallet Profile.
 *
 * One route carries the whole lifecycle: an entry state before setup, a
 * smart-default review, a preview of both the pass face and the real visitor
 * page, and the management surface afterwards. Every network call goes through
 * `WalletCardService` — nothing here talks to the API directly.
 */
export function WalletCardWorkspace() {
  const { user, loading: authLoading, phoneNumber } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const avatarUrl = useEffectiveAvatarUrl();
  const userId = user?.uid ?? null;

  const [stage, setStage] = useState<WalletCardStage>("loading");
  const [card, setCard] = useState<WalletCardRecord | null>(null);
  const [shareLink, setShareLink] = useState<WalletCardShareLink | null>(null);
  const [draft, setDraft] = useState<WalletCardDraft>(EMPTY_WALLET_CARD_DRAFT);
  const [errors, setErrors] = useState<WalletCardValidationErrors>({});
  const [visitorPreview, setVisitorPreview] = useState<VisitorPreviewState>({
    status: "idle",
  });
  const [previewOrigin, setPreviewOrigin] = useState<"setup" | "manage">("setup");
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<WalletCardManageAction | null>(null);

  // Every stage swaps in place on one pathname, so the shell's pathname-keyed
  // reset never fires and the previous stage's scroll offset carries over.
  useScrollReset(stage, { enabled: true, behavior: "auto" });
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [applePassSupported, setApplePassSupported] = useState(false);

  // Platform capability is read after mount: the user agent is not available
  // during server rendering and would otherwise cause a hydration mismatch.
  useEffect(() => {
    setApplePassSupported(canAddToAppleWallet());
  }, []);

  const smartDefaults = useMemo(
    () =>
      buildSmartDefaultDraft({
        displayName: user?.displayName ?? null,
        email: user?.email ?? null,
        phoneNumber: phoneNumber ?? user?.phoneNumber ?? null,
      }),
    [user?.displayName, user?.email, user?.phoneNumber, phoneNumber],
  );

  /**
   * Adopt a freshly-loaded card and re-read the device-local share link.
   *
   * The plaintext token is returned by the backend only at create and rotate,
   * so this device copy is what lets the QR and the Add-to-Wallet link render
   * later. `readShareLink` drops it when the stored token version no longer
   * matches the card, which is how a rotation performed on another device
   * stops this one from showing a dead QR.
   */
  const adoptCard = useCallback(
    (next: WalletCardRecord | null) => {
      setCard(next);
      setShareLink(userId ? WalletCardService.readShareLink(userId, next) : null);
    },
    [userId],
  );

  const loadCard = useCallback(async () => {
    if (!vaultOwnerToken || !userId) return;
    setStage("loading");
    try {
      const state = await WalletCardService.getCard({ vaultOwnerToken, userId });
      if (!state.enabled) {
        setStage("unavailable");
        return;
      }
      if (!state.exists || !state.card || state.card.status === "revoked") {
        adoptCard(null);
        setStage("intro");
        return;
      }
      adoptCard(state.card);
      setStage("manage");
    } catch {
      setStage("error");
    }
  }, [adoptCard, userId, vaultOwnerToken]);

  useEffect(() => {
    if (authLoading) {
      setStage("loading");
      return;
    }
    if (!isVaultUnlocked || !vaultOwnerToken || !userId) {
      setStage("locked");
      return;
    }
    void loadCard();
  }, [authLoading, isVaultUnlocked, vaultOwnerToken, userId, loadCard]);

  const loadVisitorPreview = useCallback(async () => {
    if (!vaultOwnerToken || !userId) return;
    setVisitorPreview({ status: "loading" });
    try {
      // The projection comes from the backend so it is produced by the same
      // builder that serves the public page, and it is rendered with the same
      // component `/c/[token]` uses. A local re-implementation could drift.
      const result = await WalletCardService.previewAsVisitor({
        vaultOwnerToken,
        userId,
      });
      if (result.state !== "available") {
        setVisitorPreview({ status: "error", message: result.message });
        return;
      }
      const normalized = normalizePublicWalletCard(result.card);
      if (!normalized) {
        setVisitorPreview({
          status: "error",
          message: WALLET_CARD_OWNER_COPY.visitorPreviewError,
        });
        return;
      }
      setVisitorPreview({ status: "ready", card: normalized });
    } catch {
      setVisitorPreview({
        status: "error",
        message: WALLET_CARD_OWNER_COPY.visitorPreviewError,
      });
    }
  }, [userId, vaultOwnerToken]);

  const startSetup = useCallback(() => {
    setDraft(smartDefaults);
    setErrors({});
    setStage("edit");
  }, [smartDefaults]);

  const startEdit = useCallback(() => {
    if (!card) return;
    const stored = draftFromPayload(card.cardPayload);
    setDraft({
      ...stored,
      // Fall back to what the product already knows rather than showing a blank.
      fullName: stored.fullName || smartDefaults.fullName,
    });
    setErrors({});
    setStage("edit");
  }, [card, smartDefaults.fullName]);

  const onDraftChange = useCallback((key: keyof WalletCardDraft, value: string) => {
    setDraft((current) =>
      key === "preferredContact"
        ? { ...current, preferredContact: value as WalletCardPreferredContact }
        : { ...current, [key]: value },
    );
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const submitDraft = useCallback(async () => {
    if (!vaultOwnerToken || !userId) return;
    const validation = validateDraft(draft);
    if (hasValidationErrors(validation)) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setSaving(true);
    const isFirstSetup = !card;
    try {
      const result = await WalletCardService.saveCard({
        vaultOwnerToken,
        userId,
        payload: draftToPayload(draft),
      });
      // The plaintext token only comes back on create; persist it before the
      // response is discarded or the QR can never be rendered again.
      if (result.shareToken && result.shareUrl) {
        WalletCardService.rememberShareLink(userId, {
          card: result.card,
          shareToken: result.shareToken,
          shareUrl: result.shareUrl,
        });
      }
      adoptCard(result.card);
      // First setup ends at Add to Apple Wallet; a later edit only confirms
      // what changed, because an installed pass never needs re-adding.
      setPreviewOrigin(isFirstSetup ? "setup" : "manage");
      if (!isFirstSetup) toast.success(WALLET_CARD_OWNER_COPY.saved);
      setStage("preview");
      void loadVisitorPreview();
    } catch (error) {
      if (error instanceof WalletCardPayloadError) {
        toast.error("Some of this information can't be shared. Check the fields above.");
        return;
      }
      toast.error(WALLET_CARD_OWNER_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [adoptCard, card, draft, loadVisitorPreview, userId, vaultOwnerToken]);

  const addToWallet = useCallback(async () => {
    if (!shareLink) return;
    setBusyAction("add-to-wallet");
    try {
      // The service verifies the pass builds before handing the URL to the OS,
      // so a missing signing certificate surfaces as product copy here instead
      // of a raw error page in Safari.
      const result = await WalletCardService.addToAppleWallet(shareLink.shareToken);
      if (result.state === "opened") {
        setStage("success");
        return;
      }
      toast.error(result.message || WALLET_CARD_COPY.signingFailure);
    } catch {
      toast.error(WALLET_CARD_COPY.signingFailure);
    } finally {
      setBusyAction(null);
    }
  }, [shareLink]);

  const shareLinkAction = useCallback(async () => {
    if (!shareLink) return;
    setBusyAction("share");
    try {
      const outcome = await shareWalletCardLink({
        title: "My Hussh One profile",
        text: "Here is my Hussh One profile.",
        url: shareLink.shareUrl,
        dialogTitle: "Share your Hussh One profile",
      });
      if (outcome === "copied") {
        toast.success(WALLET_CARD_OWNER_COPY.linkCopied);
      }
      if (stage === "preview") setStage("success");
    } catch (error) {
      if (isShareAbortError(error)) return;
      toast.error(WALLET_CARD_OWNER_COPY.shareFailed);
    } finally {
      setBusyAction(null);
    }
  }, [shareLink, stage]);

  const copyLinkAction = useCallback(async () => {
    if (!shareLink) return;
    if (await copyWalletCardLink(shareLink.shareUrl)) {
      toast.success(WALLET_CARD_OWNER_COPY.linkCopied);
      return;
    }
    toast.error(WALLET_CARD_OWNER_COPY.shareFailed);
  }, [shareLink]);

  const runConfirmedAction = useCallback(async () => {
    if (!confirm || !vaultOwnerToken || !userId) return;
    setBusyAction(confirm);
    try {
      if (confirm === "pause") {
        adoptCard(await WalletCardService.pauseCard({ vaultOwnerToken, userId }));
        toast.success(WALLET_CARD_OWNER_COPY.paused);
      } else if (confirm === "resume") {
        adoptCard(await WalletCardService.resumeCard({ vaultOwnerToken, userId }));
        toast.success(WALLET_CARD_OWNER_COPY.resumed);
      } else if (confirm === "rotate") {
        const result = await WalletCardService.rotateShareToken({
          vaultOwnerToken,
          userId,
        });
        if (result.shareToken && result.shareUrl) {
          WalletCardService.rememberShareLink(userId, {
            card: result.card,
            shareToken: result.shareToken,
            shareUrl: result.shareUrl,
          });
        }
        adoptCard(result.card);
        toast.success(WALLET_CARD_OWNER_COPY.rotated);
      } else {
        await WalletCardService.revokeCard({ vaultOwnerToken, userId });
        WalletCardService.forgetShareLink(userId);
        adoptCard(null);
        setVisitorPreview({ status: "idle" });
        setStage("intro");
        toast.success(WALLET_CARD_OWNER_COPY.removed);
      }
      setConfirm(null);
    } catch {
      toast.error(WALLET_CARD_OWNER_COPY.saveFailed);
    } finally {
      setBusyAction(null);
    }
  }, [adoptCard, confirm, userId, vaultOwnerToken]);

  const onManageAction = useCallback(
    (action: WalletCardManageAction) => {
      switch (action) {
        case "preview":
          setPreviewOrigin("manage");
          setStage("preview");
          void loadVisitorPreview();
          return;
        case "edit":
          startEdit();
          return;
        case "add-to-wallet":
          void addToWallet();
          return;
        case "share":
          void shareLinkAction();
          return;
        case "copy":
          void copyLinkAction();
          return;
        default:
          setConfirm(action);
      }
    },
    [addToWallet, copyLinkAction, loadVisitorPreview, shareLinkAction, startEdit],
  );

  const header = useMemo(() => {
    if (stage === "edit" && !card) {
      return WALLET_CARD_COPY.setupIntro;
    }
    if (stage === "success") {
      return WALLET_CARD_COPY.success;
    }
    return card ? WALLET_CARD_COPY.entryAfterSetup : WALLET_CARD_COPY.entryBeforeSetup;
  }, [card, stage]);

  const dataState =
    stage === "loading"
      ? "loading"
      : stage === "error"
        ? "error"
        : stage === "unavailable"
          ? "unavailable-valid"
          : card
            ? "loaded"
            : "empty-valid";

  return (
    <PkmSettingsShell
      eyebrow={WALLET_CARD_OWNER_COPY.eyebrow}
      title={header.title}
      description={header.description}
    >
      <NativeTestBeacon
        routeId="/one/wallet-card"
        marker="native-route-one-wallet-card"
        authState={authLoading ? "pending" : user ? "authenticated" : "anonymous"}
        dataState={dataState}
      />

      {stage === "loading" ? (
        <div className="rounded-2xl border p-6 text-center text-sm text-muted-foreground">
          Loading your Wallet Profile…
        </div>
      ) : null}

      {stage === "locked" ? (
        <div className="flex items-center gap-2 rounded-2xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" aria-hidden />
          {WALLET_CARD_OWNER_COPY.vaultLocked}
        </div>
      ) : null}

      {stage === "unavailable" ? (
        <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {WALLET_CARD_OWNER_COPY.featureUnavailable}
        </div>
      ) : null}

      {stage === "error" ? (
        <div className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <p>{WALLET_CARD_OWNER_COPY.loadFailed}</p>
          <Button
            type="button"
            size="sm"
            variant="none"
            effect="fade"
            onClick={() => void loadCard()}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {stage === "intro" ? (
        <div className="space-y-4">
          <SettingsGroup>
            <SettingsRow
              icon={Wallet}
              iconTone="blue"
              title={WALLET_CARD_COPY.setupIntro.title}
              description={WALLET_CARD_COPY.setupIntro.description}
            />
            <SettingsRow
              title={WALLET_CARD_COPY.privacyAssurance.title}
              description={WALLET_CARD_COPY.privacyAssurance.description}
            />
          </SettingsGroup>
          <Button type="button" size="sm" onClick={startSetup}>
            Set up Wallet Profile
          </Button>
        </div>
      ) : null}

      {stage === "edit" ? (
        <WalletCardSetup
          draft={draft}
          errors={errors}
          avatarUrl={avatarUrl}
          saving={saving}
          isEditingExisting={Boolean(card)}
          onChange={onDraftChange}
          onSubmit={() => void submitDraft()}
          onCancel={() => setStage(card ? "manage" : "intro")}
        />
      ) : null}

      {stage === "preview" ? (
        <div className="space-y-4">
          <SettingsGroup
            title={WALLET_CARD_OWNER_COPY.walletPreviewTitle}
            description={WALLET_CARD_OWNER_COPY.walletPreviewHint}
          >
            <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
              <WalletCardPassPreview
                fullName={draft.fullName || card?.displayName || ""}
                headline={draft.headline || card?.headline || ""}
                organisation={draft.organisation}
                locationLabel={draft.locationLabel}
                avatarUrl={avatarUrl}
                shareUrl={shareLink?.shareUrl ?? null}
              />
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={WALLET_CARD_OWNER_COPY.visitorPreviewTitle}
            description={WALLET_CARD_OWNER_COPY.visitorPreviewHint}
          >
            <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
              {visitorPreview.status === "ready" ? (
                <PublicWalletCardView card={visitorPreview.card} />
              ) : visitorPreview.status === "error" ? (
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>{visitorPreview.message}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="none"
                    effect="fade"
                    onClick={() => void loadVisitorPreview()}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <PublicWalletCardSkeleton />
              )}
            </div>
          </SettingsGroup>

          <p className="px-1 text-[12px] leading-[1.5] text-muted-foreground">
            {WALLET_CARD_OWNER_COPY.updatesAutomatically}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {previewOrigin === "setup" ? (
              <>
                {applePassSupported ? (
                  <Button
                    type="button"
                    size="sm"
                    loading={busyAction === "add-to-wallet"}
                    disabled={!shareLink}
                    onClick={() => void addToWallet()}
                  >
                    <Wallet className="mr-2 h-4 w-4" aria-hidden />
                    {WALLET_CARD_OWNER_COPY.addToWallet}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    loading={busyAction === "share"}
                    disabled={!shareLink}
                    onClick={() => void shareLinkAction()}
                  >
                    <Share2 className="mr-2 h-4 w-4" aria-hidden />
                    {WALLET_CARD_OWNER_COPY.shareLink}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="none"
                  effect="fade"
                  onClick={startEdit}
                >
                  {WALLET_CARD_OWNER_COPY.editInformation}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="none"
                  effect="fade"
                  onClick={() => setStage("manage")}
                >
                  Not now
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="none"
                effect="fade"
                onClick={() => setStage("manage")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
                Back
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {stage === "success" ? (
        <div className="space-y-4">
          <SettingsGroup>
            <SettingsRow
              icon={CheckCircle2}
              iconTone="green"
              title={WALLET_CARD_COPY.success.title}
              description={WALLET_CARD_COPY.success.description}
            />
            <SettingsRow
              title="Nothing else to do"
              description={WALLET_CARD_OWNER_COPY.updatesAutomatically}
            />
          </SettingsGroup>
          <Button type="button" size="sm" onClick={() => setStage("manage")}>
            {WALLET_CARD_COPY.entryAfterSetup.title}
          </Button>
        </div>
      ) : null}

      {stage === "manage" && card ? (
        <WalletCardManage
          card={card}
          shareLink={shareLink}
          applePassSupported={applePassSupported}
          busyAction={busyAction}
          onAction={onManageAction}
        />
      ) : null}

      <WalletCardConfirmDialog
        open={confirm !== null}
        title={confirm ? WALLET_CARD_CONFIRMATIONS[confirm].title : ""}
        body={confirm ? WALLET_CARD_CONFIRMATIONS[confirm].body : ""}
        confirmLabel={confirm ? WALLET_CARD_CONFIRMATIONS[confirm].confirmLabel : ""}
        destructive={confirm === "remove" || confirm === "rotate"}
        busy={busyAction !== null}
        onConfirm={() => void runConfirmedAction()}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      />
    </PkmSettingsShell>
  );
}
