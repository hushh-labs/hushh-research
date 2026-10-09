"use client";

/**
 * Wallet workspace - the /one/wallet owner surface for the reserved
 * wallet PKM domain. Everything decrypts on this device under the
 * vault key; the server only ever holds ciphertext plus the non-secret
 * summary envelope. Distinct from the Wallet Profile surface.
 *
 * The cards are a stack of physical-feeling objects (see
 * `wallet-card-stack.tsx`). The page composes the shared shell directly and
 * runs no page-enter animation of its own: the single route crossfade is the
 * only motion on open, and content lands where its placeholder stood.
 * States and the reveal rule live in `lib/wallet/wallet-view-state.ts`.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { WALLET_HERO_SRC } from "@/lib/wallet/wallet-artwork";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { WalletSavedCardDetails } from "./wallet-saved-card-details";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  PageTitle,
  TYPOGRAPHY_CLASSNAMES,
} from "@/components/app-ui/typography";
import { Lock, Plus, Search } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";
import { clearSecretOffer, peekSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { SecureCardReveal } from "@/components/wallet/secure-card-reveal";
import { WalletCardBrowser } from "@/components/wallet/wallet-card-browser";
import type { WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";
import browserStyles from "@/components/wallet/wallet-card-browser.module.css";
import { WalletSharing } from "@/components/wallet/wallet-sharing";
import { useAuth } from "@/hooks/use-auth";
import { prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { trackEvent } from "@/lib/observability/client";
import {
  WalletService,
  type WalletCardSummary,
} from "@/lib/services/wallet-service";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import { ReferralService, type ReferralSummary } from "@/lib/services/referral-service";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { CARD_CORNER_RADIUS_RATIO } from "@/lib/wallet/wallet-card-presentation";
import {
  INITIAL_WALLET_VIEW,
  focusedCardIdOf,
  walletViewReducer,
} from "@/lib/wallet/wallet-view-state";
import { takeReservedOfferPrefill } from "@/lib/pkm/reserved-offer";



const WALLET_TABS = [
  { value: "cards", label: "Cards" },
  { value: "add", label: "Add" },
  { value: "sharing", label: "Sharing" },
];
type WalletTab = "cards" | "add" | "sharing";

/** One column for header and content, so both share a start line. */
const WALLET_COLUMN = "mx-auto w-full max-w-[820px] space-y-1.5 sm:space-y-3.5";

const CARD_SLOT_RADIUS = { borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})` };

/** A card-shaped slot: the loading placeholder and the empty and locked frames. */
function CardSlot({
  children,
  variant,
  testId,
}: {
  children?: ReactNode;
  variant: "placeholder" | "outline";
  testId?: string;
}) {
  return (
    <div className="@container w-full" data-testid={testId}>
      <div
        className={cn(
          "flex aspect-[85.6/53.98] w-full items-center justify-center",
          variant === "placeholder"
            ? "bg-[color:var(--app-neutral-fill)]"
            : "border border-dashed border-[color:var(--app-separator)]",
        )}
        style={CARD_SLOT_RADIUS}
      >
        {children}
      </div>
    </div>
  );
}

function StateMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <p className={TYPOGRAPHY_CLASSNAMES.mediumRowLabel}>{title}</p>
      <p className={TYPOGRAPHY_CLASSNAMES.helperText}>{body}</p>
    </div>
  );
}

function WalletIntroduction({ onConnect, loading }: { onConnect: () => void; loading: boolean }) {
  return (
    <section
      className="flex w-full flex-col items-center justify-center py-6 text-center"
      style={{ minHeight: "calc(100svh - var(--app-top-shell-height, 64px) - var(--app-bottom-shell-height, 132px) - 32px)" }}
      aria-labelledby="one-wallet-empty-title"
      data-testid={loading ? "one-wallet-loading" : "one-wallet-empty"}
      aria-busy={loading}
    >
      <div
        className="relative aspect-[698/894] w-auto"
        style={{ height: "clamp(9rem, calc(100svh - 27rem), 17rem)" }}
        aria-hidden="true"
        data-testid="one-wallet-empty-art"
      >
        <span className="pointer-events-none absolute inset-[9%] rounded-full bg-white/90 blur-3xl dark:bg-white/80" />
        <span className="pointer-events-none absolute inset-[20%] rounded-full bg-[color:var(--app-accent-surface)] blur-3xl" />
        <div className="absolute inset-0 overflow-hidden">
          <Image
            src={WALLET_HERO_SRC}
            unoptimized
            loading="eager"
            fetchPriority="high"
            decoding="sync"
            alt=""
            width={1214}
            height={1295}
            sizes="(max-width: 434px) 70vw, 304px"
            className="absolute left-[-38.25%] top-[-22.82%] h-auto w-[173.93%] max-w-none"
          />
        </div>
      </div>

      <h2 id="one-wallet-empty-title" className="sr-only">
        All your cards. In one place.
      </h2>
      <PageTitle
        as="p"
        aria-hidden="true"
        className="mt-4 max-w-[20rem] text-balance lg:max-w-none lg:whitespace-nowrap"
        data-testid="one-wallet-empty-display-title"
      >
        <span className="block lg:inline">All your cards.</span>{" "}
        <span className="block lg:inline">In one place.</span>
      </PageTitle>
      <div className="mx-auto mt-5 w-full max-w-[244px]">
        <Button
          size="prominent"
          className="w-full"
          onClick={onConnect}
          disabled={loading}
          data-testid="one-wallet-empty-action"
        >
          {loading ? "Opening your wallet…" : "Continue"}
        </Button>
        {loading ? <span className="sr-only" role="status">Opening your wallet…</span> : null}
      </div>
    </section>
  );
}

export function WalletWorkspace() {
  const { user, loading: authLoading } = useAuth();
  const renderedOwnerId = user?.uid ?? null;
  const activeOwnerIdRef = useRef<string | null>(renderedOwnerId);
  activeOwnerIdRef.current = renderedOwnerId;
  useEffect(() => {
    activeOwnerIdRef.current = renderedOwnerId;
    return () => {
      if (activeOwnerIdRef.current === renderedOwnerId) {
        activeOwnerIdRef.current = null;
      }
    };
  }, [renderedOwnerId]);
  const { vaultKey, getVaultOwnerToken } = useVault();
  const [demoProfile, setDemoProfile] = useState<WalletDemoProfile | null>(null);
  // Read the token getter through a ref: its identity changes with the vault
  // context, and putting it in effect deps re-ran the list load on every render.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  getVaultOwnerTokenRef.current = getVaultOwnerToken;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, dispatch] = useReducer(walletViewReducer, INITIAL_WALLET_VIEW);
  const [tab, setTab] = useState<WalletTab>("cards");
  const [introduction, setIntroduction] = useState<{ ownerId: string; seen: boolean } | null>(null);
  const [introductionSaving, setIntroductionSaving] = useState(false);
  const introductionLoading = !renderedOwnerId || introduction?.ownerId !== renderedOwnerId;
  const introductionOpen = introductionLoading || !introduction?.seen;
  const [cardDockHost, setCardDockHost] = useState<HTMLDivElement | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [removingCardId, setRemovingCardId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (renderedOwnerId) {
      void OnboardingLocalService.hasSeenWalletIntroduction(renderedOwnerId).then((seen) => {
        if (!cancelled) setIntroduction({ ownerId: renderedOwnerId, seen });
      });
    }
    return () => { cancelled = true; };
  }, [renderedOwnerId]);
  const completeIntroduction = async () => {
    if (!renderedOwnerId || introductionSaving) return;
    const ownerId = renderedOwnerId;
    setIntroductionSaving(true);
    await OnboardingLocalService.markWalletIntroductionSeen(ownerId);
    if (activeOwnerIdRef.current === ownerId) setIntroduction({ ownerId, seen: true });
    setIntroductionSaving(false);
  };
  const [selectedDeckCardId, setSelectedDeckCardId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(Boolean(searchParams?.get("q")));
  const ready = view.kind === "list" || view.kind === "add" || view.kind === "reveal";
  const activeTab = view.kind === "add" ? "add" : tab;
  const cardReadRevision = useRef(0);
  const [cardSnapshot, setCardSnapshot] = useState<{
    ownerId: string;
    cards: WalletCardSummary[];
    cardholderNames: Record<string, string>;
  } | null>(null);
  const ownedSnapshot = vaultKey && cardSnapshot?.ownerId === renderedOwnerId ? cardSnapshot : null;
  const cards = useMemo(() => ownedSnapshot?.cards ?? [], [ownedSnapshot]);
  const cardholderNames = ownedSnapshot?.cardholderNames ?? {};
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WalletCardSummary | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  // A chat offer ("Add Amex Gold to Wallet") hands over the nickname in memory
  // (lib/pkm/reserved-offer.ts); the owner enters the card here, as always.
  const [offerNickname, setOfferNickname] = useState<string | null>(null);
  // A card kept in Secrets that the owner chose to file here, decrypted from
  // the vault on this device. Memory only; cleared on save or cancel.
  const [filing, setFiling] = useState<{ secretId: string; pan: string } | null>(null);
  useEffect(() => {
    if (!ready) {
      setSelectedDeckCardId(null);
      setRemovingCardId(null);
      setTab("cards");
      setFiling(null);
      setOfferNickname(null);
      setCardSnapshot(null);
    }
  }, [ready, view.kind]);

  useEffect(() => {
    if (!ready || activeTab !== "cards") return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("[data-app-scroll-root='true']")?.scrollTo({ top: 0, behavior: "instant" });
      });
    });
    return () => { window.cancelAnimationFrame(first); if (second) window.cancelAnimationFrame(second); };
  }, [activeTab, ready]);

  const selectTab = (value: string) => {
    if (!ready || value === activeTab || !WALLET_TABS.some((option) => option.value === value)) return;
    // Drop revealed values and reject an in-flight reveal when leaving Cards.
    dispatch({ type: "unfocus" });
    dispatch({ type: "close_add" });
    setTab(value as WalletTab);
    if (value === "cards") {
      // Add and Sharing can be much taller than the deck. Restore the card
      // surface to its start when returning so the first card is the entry
      // point instead of inheriting the previous pane's scroll position.
      window.requestAnimationFrame(() => {
        const root = document.querySelector<HTMLElement>("[data-app-scroll-root='true']");
        root?.scrollTo({ top: 0, behavior: "instant" });
      });
    }
  };
  // Metadata search stays in q; presentation selection stays in memory.
  const routeQuery = searchParams?.get("q") || "";
  const [searchValue, setSearchValue] = useState(routeQuery);
  const deferredQuery = useDeferredValue(searchValue.trim());
  useEffect(() => {
    setSearchValue(routeQuery);
    setSearchOpen(Boolean(routeQuery));
    dispatch({ type: "unfocus" });
  }, [routeQuery]);
  const updateSearch = (value: string) => {
    setSearchValue(value);
    const next = new URLSearchParams(searchParams?.toString() || "");
    if (value.trim()) next.set("q", value.trim());
    else next.delete("q");
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const filteredCards = useMemo(
    () => cards.filter((card) => WalletService.matchesQuery(card, deferredQuery)),
    [cards, deferredQuery],
  );
  const vaultContext = useCallback(() => {
    const token = getVaultOwnerTokenRef.current();
    if (!user?.uid || !vaultKey || !token) return null;
    return { userId: user.uid, vaultKey, vaultOwnerToken: token };
  }, [user?.uid, vaultKey]);
  useEffect(() => {
    if (!user?.uid) { setDemoProfile(null); return; }
    setDemoProfile({ ownerId: user.uid, displayName: user.displayName?.trim() || null, shareUrl: null, cardPayload: null, memberSince: user.metadata?.creationTime });
    let cancelled = false;
    let loading = false;
    const recoveryAttempts = new Set<number | null>();
    const load = async () => {
      if (cancelled || loading || document.visibilityState === "hidden") return;
      const fallbackName = user.displayName?.trim() || null;
      const token = getVaultOwnerTokenRef.current();
      if (!token) {
        if (!cancelled) setDemoProfile({ ownerId: user.uid, displayName: fallbackName, shareUrl: null, cardPayload: null });
        return;
      }
      loading = true;
      try {
        const state = await WalletCardService.getCard({ userId: user.uid, vaultOwnerToken: token });
        if (cancelled) return;
        const payloadName = state.card?.cardPayload.full_name?.trim() || null;
        setDemoProfile({ ownerId: user.uid, displayName: payloadName || state.card?.displayName?.trim() || user.displayName?.trim() || null, shareUrl: state.card?.status === "active" ? state.shareUrl : null, cardPayload: state.card?.cardPayload ?? null, memberSince: user.metadata?.creationTime, walletId: state.card?.passSerial, shareToken: WalletCardService.readShareLink(user.uid, state.card)?.shareToken ?? null });
        if (state.card && state.card.status !== "revoked" && !WalletCardService.readShareLink(user.uid, state.card)) {
          const version = state.card.shareTokenVersion ?? null;
          if (!recoveryAttempts.has(version)) {
            recoveryAttempts.add(version);
            const recovered = await WalletCardService.ensureCard({ userId: user.uid, vaultOwnerToken: token });
            if (cancelled) return;
            const link = WalletCardService.readShareLink(user.uid, recovered.card);
            setDemoProfile({ ownerId: user.uid, displayName: recovered.card.cardPayload.full_name?.trim() || recovered.card.displayName?.trim() || fallbackName, shareUrl: recovered.card.status === "active" ? link?.shareUrl ?? null : null, cardPayload: recovered.card.cardPayload, memberSince: user.metadata?.creationTime, walletId: recovered.card.passSerial, shareToken: link?.shareToken ?? null });
          }
        }
      } catch { /* Retain the last confirmed snapshot during a transient outage. */ }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    const refreshVisible = () => void load();
    const unsubscribe = WalletCardService.subscribe(user.uid, refreshVisible);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [user?.uid, user?.displayName, user?.metadata?.creationTime, vaultKey]);
  const [referralState, setReferralState] = useState<{ ownerId: string; summary: ReferralSummary } | null>(null);
  const [referralErrorOwnerId, setReferralErrorOwnerId] = useState<string | null>(null);
  const loadReferral = useCallback(async () => {
    if (!user) return;
    const ownerId = user.uid;
    setReferralErrorOwnerId(null);
    try {
      const idToken = await user.getIdToken();
      const summary = await ReferralService.getSummary({ idToken });
      if (activeOwnerIdRef.current === ownerId) setReferralState({ ownerId, summary });
    } catch {
      // Preserve a confirmed summary, but make a failed first load actionable.
      if (activeOwnerIdRef.current === ownerId) setReferralErrorOwnerId(ownerId);
    }
  }, [user]);
  useEffect(() => { void loadReferral(); }, [loadReferral]);
  const { connected: referralConnected } = useReferralStream(user, loadReferral);
  useEffect(() => {
    if (!user || referralConnected) return;
    const visible = () => { if (document.visibilityState !== "hidden") void loadReferral(); };
    const timer = window.setInterval(visible, 30000);
    window.addEventListener("focus", visible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", visible); };
  }, [user, referralConnected, loadReferral]);
  const referralSummary = referralState?.ownerId === renderedOwnerId ? referralState.summary : null;
  const walletIdentity = demoProfile?.ownerId === renderedOwnerId ? { ...demoProfile, referralUrl: referralSummary?.link ?? null } : null;
  // Decryption is asynchronous; whether the vault is still open is re-read
  // from the latest render when it settles, never from the tap that began it.
  const vaultContextRef = useRef(vaultContext);
  vaultContextRef.current = vaultContext;

  const refresh = useCallback(
    async (options?: { quiet?: boolean }) => {
      if (!WalletService.isEnabled()) {
        dispatch({ type: "disabled" });
        return;
      }
      const readRevision = ++cardReadRevision.current;
      const context = vaultContext();
      if (!context) {
        dispatch({ type: "vault_unavailable" });
        return;
      }
      if (!options?.quiet) dispatch({ type: "load_started" });
      try {
        const presentations = await WalletService.listCardPresentations(context);
        const summaries = presentations.map((card) => card.summary);
        if (readRevision !== cardReadRevision.current || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
        setCardSnapshot({
          ownerId: context.userId,
          cards: summaries,
          cardholderNames: Object.fromEntries(presentations.map((card) => [card.summary.cardId, card.cardholderName])),
        });
        dispatch({ type: "load_succeeded", cardIds: summaries.map((card) => card.cardId) });
      } catch {
        if (readRevision !== cardReadRevision.current || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
        dispatch({
          type: "load_failed",
          message: "Your cards could not be loaded. Please try again.",
        });
      }
    },
    [vaultContext],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (introductionOpen || !renderedOwnerId || view.kind !== "list") return;
    const staged = takeReservedOfferPrefill({
      ownerUserId: renderedOwnerId,
      ownerFeature: "wallet",
      kind: "wallet_card",
    });
    if (!staged) return;
    setOfferNickname(staged.nickname);
    dispatch({ type: "open_add" });
  }, [introductionOpen, renderedOwnerId, view.kind]);
  // "Add this card to Wallet" from a Secrets card: open the add form with the
  // number decrypted from the vault. The owner still commits it here.
  useEffect(() => {
    if (introductionOpen || view.kind !== "list" || filing) return;
    const offer = peekSecretOffer({ ownerUserId: user?.uid, fileTo: "wallet" });
    const context = vaultContext();
    if (!offer || !context) return;
    let active = true;
    void SecretsVaultService.revealSecret({ ...context, secretId: offer.secretId })
      .then((value) => {
        if (!active) return;
        if (!value) {
          clearSecretOffer();
          return;
        }
        setFiling({ secretId: offer.secretId, pan: value });
        dispatch({ type: "open_add" });
      })
      .catch(() => clearSecretOffer());
    return () => {
      active = false;
    };
  }, [introductionOpen, filing, user?.uid, vaultContext, view.kind]);

  const focusedCardId = focusedCardIdOf(view);
  const focusedCard = cards.find((card) => card.cardId === selectedDeckCardId) ?? cards[0] ?? null;
  const selectCard = (cardId: string) => {
    setSelectedDeckCardId(cardId);
    dispatch({ type: "unfocus" });
    dispatch({ type: "focus", cardId });
    if (searchValue) updateSearch("");
    setSearchOpen(false);
  };

  const removeCard = async (cardId: string) => {
    const context = vaultContext();
    if (!context) return;
    setBusyCardId(cardId);
    try {
      try {
        await WalletService.deleteCard({
          ...context,
          cardId,
          surface: "web",
          source: "one_wallet_remove",
        });
        if (activeOwnerIdRef.current === context.userId) {
          trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_deleted", result: "success" });
        }
      } catch (error) {
        if (activeOwnerIdRef.current === context.userId) {
          trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_deleted", result: "error" });
        }
        throw error;
      }
      if (activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
      if (activeTab === "cards") {
        setRemovingCardId(cardId);
        if (!prefersReducedMotion()) await new Promise((resolve) => setTimeout(resolve, 220));
        if (activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
        const index = cards.findIndex((card) => card.cardId === cardId);
        setSelectedDeckCardId((current) => (current ?? cards[0]?.cardId) === cardId
          ? cards[index + 1]?.cardId ?? cards[index - 1]?.cardId ?? null
          : current);
      }
      cardReadRevision.current += 1;
      setCardSnapshot((previous) => {
        if (previous?.ownerId !== context.userId) return previous;
        const names = { ...previous.cardholderNames };
        delete names[cardId];
        return { ...previous, cards: previous.cards.filter((card) => card.cardId !== cardId), cardholderNames: names };
      });
      dispatch({ type: "unfocus" });
      await refresh({ quiet: true });
      setRemovingCardId(null);
    } finally {
      setBusyCardId(null);
    }
  };

  const confirmRemove = () => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    void morphyToast.promise(removeCard(target.cardId), {
      loading: "Removing card…",
      success: "Card removed.",
      error: "The card could not be removed.",
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && focusedCardId && !removeTarget) {
      dispatch({ type: "unfocus" });
    }
  };

  const hasCards = ready && cards.length > 0;
  const showSearch = hasCards && activeTab === "cards";

  const headerAction = introductionOpen || activeTab !== "cards" ? null : focusedCardId ? (
    <Button
      variant="secondary"
      size="compact"
      onClick={() => dispatch({ type: "unfocus" })}
      data-testid="one-wallet-done"
    >
      Done
    </Button>
  ) : hasCards ? (
    <Button
      variant="secondary"
      size="compact"
      onClick={() => dispatch({ type: "open_add" })}
      data-testid="one-wallet-add"
    >
      <Plus aria-hidden="true" />
      Add card
    </Button>
  ) : null;

  const cardDetails = (
    <>
  {view.kind === "list" && focusedCard ? (
    <div
      className="motion-step-enter [animation-delay:var(--motion-duration-sm)]"
      data-testid="one-wallet-card-actions"
    >
      <WalletSavedCardDetails card={focusedCard} name={cardholderNames[focusedCard.cardId]} />

    </div>
  ) : null}

  {view.kind === "reveal" ? (
    <div className="motion-step-enter">
      <SecureCardReveal
        summary={view.summary}
        secrets={view.secrets}
        showFace={false}
        onHide={() => dispatch({ type: "hide" })}
      />
    </div>
  ) : null}
    </>
  );

  const removeTitle = removeTarget
    ? removeTarget.nickname || `${cardNetworkLabel(removeTarget.brand)} ending ${removeTarget.last4}`
    : "";

  return (
    <AppPageShell
      as="div"
      width="standard"
      fitContent
      className="relative isolate [--app-page-content-bottom-gap:0px]"
    >
      <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden">
        <div
          className={WALLET_COLUMN}
          data-wallet-hub
          data-testid="one-wallet-workspace"
          data-view={view.kind}
          onKeyDown={onKeyDown}
        >
          {!introductionOpen ? <PageHeader
            title={
              <span className="block" data-slot="wallet-heading-line">
                Wallet
              </span>
            }
            actionsInlineMobile
            titleRole="agent"
            className="[&>div:first-child]:!gap-2.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center"
            // Match Location's 31px switch + 4px gap + 18px status row.
            // Reserve it even without an action so loading never shifts tabs.
            actions={
              <span className="flex h-[53px] items-center" data-slot="wallet-header-action">
                {headerAction}
              </span>
            }
          />
          : null}
          <NativeTestBeacon
            routeId="/one/wallet"
            marker="native-route-one-wallet"
            authState={
              authLoading ? "pending" : user ? "authenticated" : "anonymous"
            }
            dataState={
              view.kind === "loading"
                ? "loading"
                : view.kind === "error"
                  ? "error"
                  : view.kind === "disabled" || view.kind === "locked"
                    ? "unavailable-valid"
                    : view.kind === "list" && cards.length === 0
                      ? "empty-valid"
                      : "loaded"
            }
          />

          {introductionOpen ? (
            introductionLoading ? <div role="status" className="py-6 text-center text-sm text-muted-foreground">Opening your wallet…</div> :
            <WalletIntroduction loading={introductionSaving} onConnect={() => void completeIntroduction()} />
          ) : <>
          <TopShellTabs
            tabSet={{
              id: "wallet",
              label: "Wallet",
              queryParam: "view",
              activeValue: activeTab,
              tabs: WALLET_TABS.map((option) => ({ ...option, href: pathname })),
            }}
            onValueChange={selectTab}
            disabled={!ready}
          />
          <div className="-mx-[var(--page-inline-gutter-standard)]">
          <SwipeViews
            disabled={!ready}
            options={WALLET_TABS}
            tabSetId="wallet"
            activeValue={activeTab}
            onSelectionChange={selectTab}
            viewportMinHeight="0px"
            heightMode="active"
            holdHeightDuringTransition={false}
          >
          <div className="space-y-3.5 px-[var(--page-inline-gutter-standard)]">
          {view.kind === "disabled" ? (
            <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Wallet is not available here yet.</p>
          ) : null}

          {view.kind === "loading" ? <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText}>Opening your wallet…</p> : null}

          {view.kind === "locked" ? (
            <div className="flex flex-col items-center gap-6" data-testid="one-wallet-locked">
              <CardSlot variant="outline">
                <Lock aria-hidden="true" className="size-10 text-muted-foreground" />
              </CardSlot>
              <StateMessage
                title="Your wallet is locked"
                body="Unlock your vault to see your cards."
              />
              <Button
                size="prominent"
                className="w-full"
                onClick={() => setUnlockOpen(true)}
                data-testid="one-wallet-unlock"
              >
                Unlock
              </Button>
            </div>
          ) : null}

          {view.kind === "error" ? (
            <div className="flex flex-col items-center gap-4" data-testid="one-wallet-error">
              <StateMessage title="Your cards did not open" body={view.message} />
              <Button variant="secondary" size="standard" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          ) : null}

          {showSearch ? <div className="mx-auto flex w-full max-w-[820px] justify-end"><Button variant="ghost" size="compact" aria-label={searchOpen ? "Close card search" : "Search cards"} onClick={() => { dispatch({ type: "unfocus" }); if (searchOpen) updateSearch(""); setSearchOpen(!searchOpen); }}><Search aria-hidden="true" className="size-4" />{searchOpen ? "Close" : "Search"}</Button></div> : null}
          {showSearch && searchOpen ? (
            <div className="relative mx-auto w-full max-w-[820px]">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={searchValue}
                onChange={(event) => updateSearch(event.target.value)}
                aria-label="Search cards"
                placeholder="Search by nickname, network, last four, or region"
                className="pl-10"
                data-testid="one-wallet-search"
              />
            </div>
          ) : null}

          {hasCards && filteredCards.length === 0 ? (
            <p className={cn(TYPOGRAPHY_CLASSNAMES.helperText, "text-center")} data-testid="one-wallet-no-match">
              No cards match that search.
            </p>
          ) : null}

          {hasCards && searchOpen && deferredQuery ? <ul className="mx-auto w-full max-w-[820px] space-y-2" aria-label="Card search results">{filteredCards.map((card) => <li key={card.cardId}><Button variant="secondary" size="standard" className="w-full justify-start" onClick={() => selectCard(card.cardId)}>{card.nickname || cardNetworkLabel(card.brand)} · {cardNetworkLabel(card.brand)} ending {card.last4}</Button></li>)}</ul> : null}
          {ready && !(searchOpen && deferredQuery) ? (
            <WalletCardBrowser demoProfile={walletIdentity} referralSummary={referralSummary} referralError={Boolean(renderedOwnerId && referralErrorOwnerId === renderedOwnerId)} onRetryReferral={() => void loadReferral()} ownerId={renderedOwnerId || undefined}
              key={`${renderedOwnerId || "wallet"}-${activeTab}`}
              cards={cards}
              cardholderNames={cardholderNames}
              selectedCardId={selectedDeckCardId}
              onSelect={selectCard}
              onOverview={() => dispatch({ type: "unfocus" })}
              onAdd={() => { dispatch({ type: "unfocus" }); dispatch({ type: "open_add" }); }}
              details={cardDetails}
              dockHost={cardDockHost}
              active={activeTab === "cards"}
              onRemove={setRemoveTarget}
              busyCardId={removingCardId}
              disabled={Boolean(busyCardId)}
            />
          ) : null}
          </div>
          <div className="space-y-3.5 px-[var(--page-inline-gutter-standard)]">
          {ready ? (
            <div className="mx-auto w-full max-w-[820px] py-4">
              <SecureCardAddForm
                key={`${renderedOwnerId}:${filing?.secretId ?? "new"}:${offerNickname ?? ""}:${formRevision}`}
                active={activeTab === "add"}
                initialNickname={offerNickname ?? undefined}
                initialPan={filing?.pan}
                onSubmit={async (card) => {
                  const context = vaultContext();
                  if (!context) throw new Error("Unlock your vault to save a card.");
                  try {
                    const saved = await WalletService.addCard({
                      ...context,
                      card,
                      surface: "web",
                      source: "one_wallet_add",
                    });
                    const current = vaultContextRef.current();
                    if (activeOwnerIdRef.current !== context.userId || !current || current.vaultKey !== context.vaultKey) return;
                    // A list request begun before this receipt cannot remove the new card.
                    cardReadRevision.current += 1;
                    setCardSnapshot((previous) => {
                      const owned = previous?.ownerId === context.userId ? previous : null;
                      return {
                        ownerId: context.userId,
                        cards: [...(owned?.cards ?? []).filter((item) => item.cardId !== saved.cardId), saved.summary],
                        cardholderNames: { ...owned?.cardholderNames, [saved.cardId]: saved.cardholderName },
                      };
                    });
                    setSelectedDeckCardId(saved.cardId);
                    if (activeOwnerIdRef.current === context.userId) {
                      trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_added", result: "success" });
                    }
                  } catch (error) {
                    if (activeOwnerIdRef.current === context.userId) {
                      trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_added", result: "error" });
                    }
                    throw error;
                  }
                  setFormRevision((revision) => revision + 1);
                  setTab("cards");
                  dispatch({ type: "close_add" });
                  setOfferNickname(null);
                  if (filing) {
                    clearSecretOffer();
                    void SecretsVaultService.markFiled({ ...context, secretId: filing.secretId, filedTo: "wallet" }).catch(() => undefined);
                    setFiling(null);
                  }
                }}
                onCancel={() => {
                  setFormRevision((revision) => revision + 1);
                  setTab("cards");
                  setOfferNickname(null);
                  clearSecretOffer();
                  setFiling(null);
                  dispatch({ type: "close_add" });
                }}
              />
            </div>
          ) : null}
          </div>
          <div className="space-y-3.5 px-[var(--page-inline-gutter-standard)]" data-testid="one-wallet-sharing">
            {ready && activeTab === "sharing" ? <WalletSharing key={renderedOwnerId} /> : null}
          </div>
          </SwipeViews>
          </div>
          </>}
        </div>

        <AlertDialog
          open={Boolean(removeTarget)}
          onOpenChange={(open) => {
            if (!open) setRemoveTarget(null);
          }}
        >
          <AlertDialogContent data-testid="one-wallet-remove-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {removeTitle}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the card and its details from your vault on every device. You can add it again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="one-wallet-remove-cancel">Keep card</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={confirmRemove}
                data-testid="one-wallet-remove-confirm-action"
              >
                Remove card
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {user && unlockOpen ? (
          <VaultUnlockDialog
            user={user}
            open={unlockOpen}
            onOpenChange={setUnlockOpen}
            onSuccess={() => setUnlockOpen(false)}
            title="Unlock your wallet"
            description="Enter your vault passphrase to see your cards."
            allowVaultCreation={false}
          />
        ) : null}
      </AppPageContentRegion>
      <div ref={setCardDockHost} hidden={introductionOpen || !ready || activeTab !== "cards" || Boolean(searchOpen && deferredQuery)} className={cn(browserStyles.dockHost, "sticky bottom-0 z-20 mx-auto h-0 w-full max-w-[820px] overflow-hidden bg-transparent p-0")} data-testid="wallet-card-dock-host" />
    </AppPageShell>
  );
}
