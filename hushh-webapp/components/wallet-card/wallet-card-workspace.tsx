"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Lock, Wallet } from "@/components/icons";
import { SuccessRowIcon, WalletAgentIcon } from "@/components/icons/agents";
import { toast } from "sonner";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import { RowDescription, SectionTitle } from "@/components/app-ui/typography";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { WalletCardImageShareButton } from "@/components/wallet/wallet-card-image-share-button";
import type { WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { Button } from "@/lib/morphy-ux/morphy";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
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
  getWalletCardPreferredField,
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
  type WalletPassVariant,
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
function WalletProfileShell({ embedded, title, description, children }: {
  embedded: boolean; title: string; description: string; children: ReactNode;
}) {
  return <SettingsPresentationProvider separatorInset density="compact">{embedded ? <section aria-label={title} className="space-y-4">
    <div className="space-y-1"><SectionTitle as="h3">{title}</SectionTitle><RowDescription compact>{description}</RowDescription></div>
    {children}
  </section> : <PkmSettingsShell title={title} description={description} innerClassName="mx-auto max-w-[580px]">{children}</PkmSettingsShell>}</SettingsPresentationProvider>;
}

type WalletCardWorkspaceProps = { embedded?: boolean; passVariant?: WalletPassVariant; active?: boolean };

export function WalletCardWorkspace(props: WalletCardWorkspaceProps = {}) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  // Owner changes and vault locks discard all card, draft, and visitor state
  // during render. Late requests can only update the unmounted owner's tree.
  const ownerScope = `${user?.uid ?? "anonymous"}:${isVaultUnlocked && vaultOwnerToken ? "ready" : "locked"}`;
  return <WalletCardOwnerWorkspace key={ownerScope} {...props} />;
}

function WalletCardOwnerWorkspace({ embedded = false, passVariant = "profile", active = true }: WalletCardWorkspaceProps) {
  const { user, loading: authLoading, phoneNumber } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const avatarUrl = useEffectiveAvatarUrl();
  const userId = user?.uid ?? null;
  const loadGeneration = useRef(0);

  const [stage, setStage] = useState<WalletCardStage>("loading");
  const [card, setCard] = useState<WalletCardRecord | null>(null);
  const [shareLink, setShareLink] = useState<WalletCardShareLink | null>(null);
  const [draft, setDraft] = useState<WalletCardDraft>(EMPTY_WALLET_CARD_DRAFT);
  const [errors, setErrors] = useState<WalletCardValidationErrors>({});
  const [visitorPreview, setVisitorPreview] = useState<VisitorPreviewState>({
    status: "idle",
  });
  const [previewOrigin, setPreviewOrigin] = useState<"setup" | "manage">(
    "setup",
  );
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<WalletCardManageAction | null>(
    null,
  );

  // Every stage swaps in place on one pathname, so the shell's pathname-keyed
  // reset never fires and the previous stage's scroll offset carries over.
  useScrollReset(stage, { enabled: true, behavior: "auto" });
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [applePassSupported, setApplePassSupported] = useState(false);
  const imageShareProfile = useMemo<WalletDemoProfile>(() => ({
    ownerId: userId ?? undefined,
    displayName: card?.cardPayload?.full_name?.trim() || card?.displayName || user?.displayName || null,
    cardPayload: card?.cardPayload ?? null,
    memberSince: user?.metadata?.creationTime ?? card?.createdAt ?? null,
    walletId: card?.passSerial ?? null,
    shareUrl: shareLink?.shareUrl ?? null,
    shareToken: shareLink?.shareToken ?? null,
  }), [userId, user?.displayName, user?.metadata?.creationTime, card, shareLink]);
  const imageShareAction = <WalletCardImageShareButton
    cardId={passVariant === "nws" ? "agent-one-nws" : "agent-one-profile"}
    profile={imageShareProfile}
    disabled={!active || authLoading || !userId || !vaultOwnerToken || !isVaultUnlocked || card?.status !== "active" || !shareLink || saving || busyAction !== null}
  />;

  const localStageOpen = stage === "edit" || stage === "preview" || stage === "success";
  const closeLocalStage = useCallback(() => {
    if (!localStageOpen) return false;
    if (saving || busyAction) return true;
    setStage(card ? "manage" : "intro");
    return true;
  }, [localStageOpen, saving, busyAction, card]);
  useBackLayer(
    embedded ? ROUTES.ONE_WALLET : ROUTES.ONE_WALLET_CARD,
    active && localStageOpen && isVaultUnlocked && vaultOwnerToken && userId ? 2 : 0,
    closeLocalStage,
  );

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
   * The device copy lets the QR and Add-to-Wallet link render between owner
   * reads; authenticated ensure can recover the encrypted token when needed.
   * `readShareLink` drops it when the stored token version no longer
   * matches the card, which is how a rotation performed on another device
   * stops this one from showing a dead QR.
   */
  const adoptCard = useCallback(
    (next: WalletCardRecord | null) => {
      setCard(next);
      setShareLink(
        userId ? WalletCardService.readShareLink(userId, next) : null,
      );
    },
    [userId],
  );

  const loadCard = useCallback(async () => {
    if (!vaultOwnerToken || !userId) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current;
    setStage("loading");
    try {
      const state = await WalletCardService.getCard({
        vaultOwnerToken,
        userId,
      });
      if (!isCurrent()) return;
      if (!state.enabled) {
        setStage("unavailable");
        return;
      }
      if (!state.exists || !state.card) {
        const result = await WalletCardService.ensureCard({
          vaultOwnerToken, userId, payload: draftToPayload(smartDefaults), avatarUrl,
        });
        if (!isCurrent()) return;
        adoptCard(result.card);
        setStage("manage");
        return;
      }
      if (state.card.status === "revoked") {
        adoptCard(null);
        setStage("intro");
        return;
      }
      // Ensure also recovers a previously created QR on a new device.
      if (!WalletCardService.readShareLink(userId, state.card)) {
        const result = await WalletCardService.ensureCard({ vaultOwnerToken, userId });
        if (!isCurrent()) return;
        adoptCard(result.card);
      } else adoptCard(state.card);
      setStage("manage");
    } catch {
      if (isCurrent()) setStage("error");
    }
  }, [adoptCard, userId, vaultOwnerToken, smartDefaults, avatarUrl]);

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
    return () => { loadGeneration.current += 1; };
  }, [authLoading, isVaultUnlocked, vaultOwnerToken, userId, loadCard]);

  // Keep scan totals and other-device edits fresh while preserving an unsaved draft.
  useEffect(() => {
    if (!userId || !vaultOwnerToken || stage !== "manage") return;
    let cancelled = false;
    let running = false;
    const recoveryAttempts = new Set<number | null>();
    const refresh = async () => {
      if (cancelled || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const state = await WalletCardService.getCard({ userId, vaultOwnerToken });
        if (!cancelled && state.card) {
          adoptCard(state.card.status === "revoked" ? null : state.card);
          if (state.card.status === "revoked") setStage("intro");
          else if (!WalletCardService.readShareLink(userId, state.card)) {
            const version = state.card.shareTokenVersion ?? null;
            // Legacy rows may have no recoverable envelope. Try each observed
            // version once, rather than every poll or our own change event.
            if (!recoveryAttempts.has(version)) {
              recoveryAttempts.add(version);
              const recovered = await WalletCardService.ensureCard({ userId, vaultOwnerToken });
              if (!cancelled) {
                adoptCard(recovered.card.status === "revoked" ? null : recovered.card);
                if (recovered.card.status === "revoked") setStage("intro");
              }
            }
          }
        }
      } catch { /* Keep the last confirmed state during a transient outage. */ }
      finally { running = false; }
    };
    const unsubscribe = WalletCardService.subscribe(userId, () => void refresh());
    const visible = () => void refresh();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 15000);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [adoptCard, stage, userId, vaultOwnerToken]);

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
      username: stored.username || smartDefaults.username,
    });
    setErrors({});
    setStage("edit");
  }, [card, smartDefaults.fullName, smartDefaults.username]);

  const onDraftChange = useCallback(
    (key: keyof WalletCardDraft, value: string) => {
      const activePreferredField = getWalletCardPreferredField(
        draft.preferredContact,
      ).key;
      setDraft((current) =>
        key === "preferredContact"
          ? {
              ...current,
              preferredContact: value as WalletCardPreferredContact,
            }
          : { ...current, [key]: value },
      );
      setErrors((current) => {
        if (!(key in current) && key !== activePreferredField) return current;
        const next = { ...current };
        delete next[key];
        if (key === "preferredContact" || key === activePreferredField) {
          delete next.preferredContact;
        }
        return next;
      });
    },
    [draft.preferredContact],
  );

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
        toast.error(
          "Some of this information can't be shared. Check the fields above.",
        );
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
      const result = await WalletCardService.addToAppleWallet(
        shareLink.shareToken, { variant: passVariant },
      );
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
  }, [shareLink, passVariant]);

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
        adoptCard(
          await WalletCardService.pauseCard({ vaultOwnerToken, userId }),
        );
        toast.success(WALLET_CARD_OWNER_COPY.paused);
      } else if (confirm === "resume") {
        adoptCard(
          await WalletCardService.resumeCard({ vaultOwnerToken, userId }),
        );
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
    [
      addToWallet,
      copyLinkAction,
      loadVisitorPreview,
      shareLinkAction,
      startEdit,
    ],
  );

  const header = useMemo(() => {
    if (stage === "edit" && !card) {
      return WALLET_CARD_COPY.setupIntro;
    }
    if (stage === "edit" && card) {
      return {
        title: "Edit Wallet Profile",
        description: "Choose what people see after a scan.",
      };
    }
    if (stage === "preview") {
      return {
        title: WALLET_CARD_OWNER_COPY.previewTitle,
        description: WALLET_CARD_OWNER_COPY.previewDescription,
      };
    }
    if (stage === "success") {
      return WALLET_CARD_COPY.success;
    }
    return card
      ? WALLET_CARD_COPY.entryAfterSetup
      : WALLET_CARD_COPY.entryBeforeSetup;
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
    <WalletProfileShell
      embedded={embedded}
      title={header.title}
      description={header.description}
    >
      {!embedded ? <NativeTestBeacon
        routeId="/one/wallet-card"
        marker="native-route-one-wallet-card"
        authState={
          authLoading ? "pending" : user ? "authenticated" : "anonymous"
        }
        dataState={dataState}
      /> : null}

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
              icon={WalletAgentIcon}
              iconTone="capability"
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
          onCancel={closeLocalStage}
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

          <RowDescription compact className="px-1">
            {WALLET_CARD_OWNER_COPY.updatesAutomatically}
          </RowDescription>

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
                ) : imageShareAction}
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
                  onClick={closeLocalStage}
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
                onClick={closeLocalStage}
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
              icon={SuccessRowIcon}
              iconTone="capability"
              title={WALLET_CARD_COPY.success.title}
              description={WALLET_CARD_COPY.success.description}
            />
            <SettingsRow
              title="Nothing else to do"
              description={WALLET_CARD_OWNER_COPY.updatesAutomatically}
            />
          </SettingsGroup>
          <Button type="button" size="sm" onClick={closeLocalStage}>
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
          shareAction={imageShareAction}
        />
      ) : null}

      <WalletCardConfirmDialog
        open={confirm !== null}
        title={confirm ? WALLET_CARD_CONFIRMATIONS[confirm].title : ""}
        body={confirm ? WALLET_CARD_CONFIRMATIONS[confirm].body : ""}
        confirmLabel={
          confirm ? WALLET_CARD_CONFIRMATIONS[confirm].confirmLabel : ""
        }
        destructive={confirm === "remove" || confirm === "rotate"}
        busy={busyAction !== null}
        onConfirm={() => void runConfirmedAction()}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      />
    </WalletProfileShell>
  );
}
