"use client";

import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";

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

import profileStyles from "@/components/profile/profile-your-account.module.css";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { WALLET_HERO_SRC } from "@/lib/wallet/wallet-artwork";
import { WalletPresentationResource, type WalletPresentationSnapshot } from "@/lib/services/wallet-presentation-resource";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WalletCardRequestReview } from "./wallet-card-request-review";
import { isCardRequestId } from "@/lib/wallet/card-request";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { WalletSavedCardDetails } from "./wallet-saved-card-details";
import { WalletSavedCardSharing } from "./wallet-saved-card-sharing";
import { WalletCardAccessService } from "@/lib/services/wallet-card-access-service";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import {
  PageTitle,
  TYPOGRAPHY_CLASSNAMES,
} from "@/components/app-ui/typography";
import { Lock } from "@/components/icons";
import { ProfilePaneSearchIcon } from "@/components/profile/profile-pane-icons";
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
import { isAgentWalletCard, type WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";
import { useBackLayer } from "@/lib/navigation/back-layers";

import browserStyles from "@/components/wallet/wallet-card-browser.module.css";
import presentationStyles from "@/components/wallet/wallet-connect-presentation.module.css";
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
import { loadWalletCardArtwork } from "@/lib/services/wallet-card-artwork-service";
import { ReferralService, type ReferralSummary } from "@/lib/services/referral-service";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CARD_CORNER_RADIUS_RATIO } from "@/lib/wallet/wallet-card-presentation";
import {
  INITIAL_WALLET_VIEW,
  focusedCardIdOf,
  walletViewReducer,
} from "@/lib/wallet/wallet-view-state";
import { takeReservedOfferPrefill } from "@/lib/pkm/reserved-offer";
import { ROUTES } from "@/lib/navigation/routes";



const WALLET_TABS = [
  { value: "cards", label: "Cards" },
  { value: "add", label: "Add" },
  { value: "sharing", label: "Sharing" },
];
type WalletTab = "cards" | "add" | "sharing";
function presentationState(snapshot: WalletPresentationSnapshot) {
  return {
    ownerId: snapshot.ownerId, epoch: snapshot.epoch,
    cards: snapshot.rows.map(row => row.summary),
    cardholderNames: Object.fromEntries(snapshot.rows.map(row => [row.summary.cardId, row.cardholderName])),
    artworks: Object.fromEntries(snapshot.rows.map(row => [row.summary.cardId, row.artwork])),
    pendingArtworkIds: new Set(snapshot.pendingArtworkIds ?? []), artworkExpiresAt: snapshot.artworkExpiresAt,
  };
}

/** One column for header and content, so both share a start line. */
const WALLET_COLUMN = "mx-auto w-full max-w-[820px] space-y-[var(--page-header-section-gap)]";
const WALLET_TAB_PANEL = "space-y-3.5 px-[var(--page-inline-gutter-standard)] pt-4 sm:pt-5";

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
        All your cards in one place
      </h2>
      <PageTitle
        as="p"
        aria-hidden="true"
        className="mt-4 max-w-[20rem] text-balance lg:max-w-none lg:whitespace-nowrap"
        data-testid="one-wallet-empty-display-title"
      >
        All your cards in one place
      </PageTitle>
      <div className="mx-auto mt-5 w-full max-w-[244px]">
        <Button
          variant="secondary"
          size="compact"
          className={cn("w-full", presentationStyles.quietAction)}
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
  useEffect(() => {
    // Public artwork can load alongside the protected card read, rather than
    // beginning another network waterfall after the vault has opened.
    for (const kind of ["profile", "referral", "nws"] as const) {
      void loadWalletCardArtwork(kind).catch(() => {});
    }
  }, []);
  const { user, loading: authLoading, sessionVerificationRequired } = useAuth();
  const authBlocked = authLoading || Boolean(sessionVerificationRequired);
  const sharingUserRef = useRef(user);
  sharingUserRef.current = user;
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
  const { vaultKey, vaultOwnerToken, getVaultOwnerToken } = useVault();
  const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const warmSnapshot = useMemo(() => {
    const snapshot = !authBlocked && vaultKey && renderedOwnerId ? WalletPresentationResource.peek(renderedOwnerId) : null;
    return snapshot?.epoch === vaultEpoch ? snapshot : null;
  }, [authBlocked, vaultKey, renderedOwnerId, vaultEpoch]);
  const profileToken = vaultKey ? getVaultOwnerToken() : null;
  const profileVisit = useMemo(
    () => ({ ownerId: renderedOwnerId, epoch: vaultEpoch, authorized: Boolean(!authBlocked && vaultKey && profileToken) }),
    [renderedOwnerId, vaultKey, profileToken, authBlocked, vaultEpoch],
  );
  const profileVisitRef = useRef(profileVisit);
  profileVisitRef.current = profileVisit;
  const [loadedProfile, setLoadedProfile] = useState<{
    visit: typeof profileVisit;
    profile: WalletDemoProfile;
  } | null>(null);
  const fallbackName = user?.displayName?.trim() || null;
  // A lock or A → B → A visit must not expose a previous protected snapshot.
  const demoProfile = profileVisit.authorized && loadedProfile?.visit === profileVisit
    ? loadedProfile.profile
    : { ownerId: renderedOwnerId ?? undefined, displayName: fallbackName, shareUrl: null, cardPayload: null };

  // Read the token getter through a ref: its identity changes with the vault
  // context, and putting it in effect deps re-ran the list load on every render.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  getVaultOwnerTokenRef.current = getVaultOwnerToken;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestQuery = searchParams?.get("card_request") || "";
  const cardRequestId = isCardRequestId(requestQuery) ? requestQuery : null;
  const closeCardRequest = () => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.delete("card_request");
    router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
  };
  const [view, dispatch] = useReducer(walletViewReducer, warmSnapshot, snapshot => snapshot ? { kind: "list" as const, focusedCardId: null } : INITIAL_WALLET_VIEW);
  const [tab, setTab] = useState<WalletTab>("cards");
  const [introduction, setIntroduction] = useState<{ ownerId: string; seen: boolean } | null>(null);
  const introductionWriteRef = useRef<{ ownerId: string } | null>(null);
  const [introductionWrite, setIntroductionWrite] = useState<{ ownerId: string } | null>(null);
  const introductionSaving = introductionWrite?.ownerId === renderedOwnerId;
  const introductionLoading = !renderedOwnerId || introduction?.ownerId !== renderedOwnerId;
  const introductionOpen = introductionLoading || !introduction?.seen;
  const [formRevision, setFormRevision] = useState(0);
  const [artworkRetryRevision, setArtworkRetryRevision] = useState(0);
  const consumedArtworkRetryRevision = useRef(0);
  const [removingCardId, setRemovingCardId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    introductionWriteRef.current = null;
    setIntroductionWrite(null);
    if (renderedOwnerId) {
      void OnboardingLocalService.hasSeenWalletIntroduction(renderedOwnerId).then((seen) => {
        if (!cancelled) setIntroduction({ ownerId: renderedOwnerId, seen });
      });
    }
    return () => {
      cancelled = true;
      introductionWriteRef.current = null;
    };
  }, [renderedOwnerId]);
  const completeIntroduction = async () => {
    if (!renderedOwnerId || introductionWriteRef.current) return;
    const ownerId = renderedOwnerId;
    // Object identity fences this visit, including an A → B → A owner change.
    const write = { ownerId };
    introductionWriteRef.current = write;
    setIntroductionWrite(write);
    const isCurrent = () =>
      introductionWriteRef.current === write && activeOwnerIdRef.current === ownerId;
    try {
      await OnboardingLocalService.markWalletIntroductionSeen(ownerId);
      if (isCurrent()) setIntroduction({ ownerId, seen: true });
    } catch {
      if (isCurrent()) morphyToast.error("Couldn’t open Wallet. Try again.");
    } finally {
      if (isCurrent()) {
        introductionWriteRef.current = null;
        setIntroductionWrite(null);
      }
    }
  };
  const [cardDockHost, setCardDockHost] = useState<HTMLDivElement | null>(null);
  const [selectedDeckCardId, setSelectedDeckCardId] = useState<string | null>(null);
  const tabHistory = useRef<{ tab: WalletTab; cardId: string | null }[]>([]);
  const addSaveInFlight = useRef<symbol | null>(null);
  useEffect(() => { tabHistory.current = []; addSaveInFlight.current = null; }, [renderedOwnerId, vaultKey]);
  const [searchOpen, setSearchOpen] = useState(Boolean(searchParams?.get("q")));
  const ready = !authBlocked && (view.kind === "list" || view.kind === "add" || view.kind === "reveal");
  const activeTab = view.kind === "add" ? "add" : tab;
  // Pager and tab controls can report one selection in the same event stack.
  const activeTabCursor = useRef<WalletTab>(activeTab);
  useLayoutEffect(() => { activeTabCursor.current = activeTab; }, [activeTab, renderedOwnerId, vaultKey]);
  const cardReadRevision = useRef(0);
  const [cardSnapshot, setCardSnapshot] = useState<ReturnType<typeof presentationState> | null>(() => warmSnapshot ? presentationState(warmSnapshot) : null);
  const ownedSnapshot = !authBlocked && vaultKey && cardSnapshot?.ownerId === renderedOwnerId && cardSnapshot.epoch === vaultEpoch ? cardSnapshot : null;
  const cardSnapshotRef = useRef(cardSnapshot);
  cardSnapshotRef.current = cardSnapshot;
  const cards = useMemo(() => ownedSnapshot?.cards ?? [], [ownedSnapshot]);
  const cardholderNames = ownedSnapshot?.cardholderNames ?? {};
  const artworks = ownedSnapshot?.artworks ?? {};
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    card: WalletCardSummary;
    context: NonNullable<ReturnType<typeof vaultContext>>;
  } | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  // A chat offer ("Add Amex Gold to Wallet") hands over the nickname in memory
  // (lib/pkm/reserved-offer.ts); the owner enters the card here, as always.
  const [offerNickname, setOfferNickname] = useState<string | null>(null);
  // A card kept in Secrets that the owner chose to file here, decrypted from
  // the vault on this device. Memory only; cleared on save or cancel.
  const [filing, setFiling] = useState<{ secretId: string; pan: string } | null>(null);
  useEffect(() => {
    if (!ready) {
      tabHistory.current = [];
      setSelectedDeckCardId(null);
      setRemovingCardId(null);
      activeTabCursor.current = "cards";
      setTab("cards");
      setFiling(null);
      setOfferNickname(null);
      setCardSnapshot(null);
    }
  }, [ready, view.kind]);

  useEffect(() => {
    if (!ready || activeTab !== "cards") return;
    const visit = profileVisitRef.current;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        if (profileVisitRef.current !== visit) return;
        document.querySelector<HTMLElement>("[data-app-scroll-root='true']")?.scrollTo({ top: 0, behavior: "instant" });
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [activeTab, ready]);

  const selectTab = (value: string) => {
    if (!ready || value === activeTabCursor.current || !WALLET_TABS.some((option) => option.value === value)) return;
    if (value === "cards") tabHistory.current = [];
    else tabHistory.current = [...tabHistory.current.slice(-23), { tab: activeTabCursor.current, cardId: selectedDeckCardId }];
    activeTabCursor.current = value as WalletTab;
    // Drop revealed values and reject an in-flight reveal when leaving Cards.
    dispatch({ type: "unfocus" });
    dispatch({ type: "close_add" });
    setSelectedDeckCardId(null);
    setTab(value as WalletTab);
  };
  const returnToWalletView = () => {
    if (addSaveInFlight.current) return true;
    if (activeTabCursor.current === "add") {
      setFormRevision(revision => revision + 1);
      setOfferNickname(null);
      clearSecretOffer();
      setFiling(null);
    }
    const previous = tabHistory.current.pop() ?? { tab: "cards" as const, cardId: null };
    dispatch({ type: "unfocus" });
    dispatch({ type: "close_add" });
    activeTabCursor.current = previous.tab;
    setTab(previous.tab);
    const cardId = previous.tab === "cards" && previous.cardId && (isAgentWalletCard(previous.cardId) || cards.some(card => card.cardId === previous.cardId)) ? previous.cardId : null;
    setSelectedDeckCardId(cardId);
    if (cardId && !isAgentWalletCard(cardId)) dispatch({ type: "focus", cardId });
    return true;
  };
  useBackLayer(ROUTES.ONE_WALLET, ready && !introductionOpen && activeTab !== "cards" ? 1 : 0, returnToWalletView);
  // Metadata search stays in q; presentation selection stays in memory.
  const routeQuery = searchParams?.get("q") || "";
  const [searchValue, setSearchValue] = useState(routeQuery);
  const localSearchWrite = useRef<string | null>(null);
  const deferredQuery = useDeferredValue(searchValue.trim());
  useEffect(() => {
    const locallyWritten = localSearchWrite.current === routeQuery;
    if (locallyWritten) localSearchWrite.current = null;
    setSearchValue(routeQuery);
    setSearchOpen(Boolean(routeQuery));
    if (!locallyWritten) dispatch({ type: "unfocus" });
  }, [routeQuery]);
  const updateSearch = (value: string) => {
    localSearchWrite.current = value.trim();
    dispatch({ type: "unfocus" });
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
    const token = vaultOwnerToken && getVaultOwnerTokenRef.current();
    if (authBlocked || vaultEpoch !== snapshotVaultSessionEpoch() || !user?.uid || !vaultKey || !token) return null;
    return { userId: user.uid, vaultKey, vaultOwnerToken: token };
  }, [user?.uid, vaultKey, vaultOwnerToken, authBlocked, vaultEpoch]);
  useEffect(() => {
    const ownerId = profileVisit.ownerId;
    if (!ownerId || !profileVisit.authorized) {
      setLoadedProfile(null);
      return;
    }
    let cancelled = false;
    let requestSequence = 0;
    let loading = false;
    const recoveryAttempts = new Set<number | null>();
    const load = async () => {
      if (cancelled || loading || document.visibilityState === "hidden") return;
      const sequence = ++requestSequence;
      const token = getVaultOwnerTokenRef.current();
      if (!token) {
        if (!cancelled && profileVisitRef.current === profileVisit) setLoadedProfile(null);
        return;
      }
      const isCurrent = () =>
        !cancelled && sequence === requestSequence &&
        profileVisitRef.current === profileVisit &&
        isVaultSessionEpochCurrent(profileVisit.epoch) &&
        activeOwnerIdRef.current === ownerId &&
        getVaultOwnerTokenRef.current() === token;
      loading = true;
      try {
        const state = await WalletCardService.getCard({ userId: ownerId, vaultOwnerToken: token });
        if (!isCurrent()) return;
        const payloadName = state.card?.cardPayload.full_name?.trim() || null;
        setLoadedProfile({
          visit: profileVisit,
          profile: {
            ownerId,
            displayName: payloadName || state.card?.displayName?.trim() || fallbackName,
            shareUrl: state.card?.status === "active" ? state.shareUrl : null,
            cardPayload: state.card?.cardPayload ?? null,
            memberSince: user?.metadata?.creationTime,
            walletId: state.card?.passSerial,
            shareToken: WalletCardService.readShareLink(ownerId, state.card)?.shareToken ?? null,
          },
        });
        if (state.card && state.card.status !== "revoked" && !WalletCardService.readShareLink(ownerId, state.card)) {
          const version = state.card.shareTokenVersion ?? null;
          if (!recoveryAttempts.has(version) && isCurrent()) {
            recoveryAttempts.add(version);
            const recovered = await WalletCardService.ensureCard({ userId: ownerId, vaultOwnerToken: token });
            if (!isCurrent()) return;
            const link = WalletCardService.readShareLink(ownerId, recovered.card);
            setLoadedProfile({
              visit: profileVisit,
              profile: {
                ownerId,
                displayName: recovered.card.cardPayload.full_name?.trim() || recovered.card.displayName?.trim() || fallbackName,
                shareUrl: recovered.card.status === "active" ? link?.shareUrl ?? null : null,
                cardPayload: recovered.card.cardPayload,
                memberSince: user?.metadata?.creationTime,
                walletId: recovered.card.passSerial,
                shareToken: link?.shareToken ?? null,
              },
            });
          }
        }
      } catch { /* Retain this visit's confirmed snapshot during a transient outage. */ }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    const refreshVisible = () => void load();
    const unsubscribe = WalletCardService.subscribe(ownerId, refreshVisible);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [profileVisit, fallbackName, user?.metadata?.creationTime]);
  const [referralState, setReferralState] = useState<{ visit: typeof profileVisit; summary: ReferralSummary } | null>(null);
  const [referralErrorVisit, setReferralErrorVisit] = useState<typeof profileVisit | null>(null);
  const referralReadRevision = useRef(0);
  const loadReferral = useCallback(async () => {
    if (!user) return;
    const visit = profileVisit;
    const revision = ++referralReadRevision.current;
    const isCurrent = () => profileVisitRef.current === visit &&
      activeOwnerIdRef.current === user.uid && revision === referralReadRevision.current;
    if (!isCurrent()) return;
    setReferralErrorVisit(null);
    try {
      const idToken = await user.getIdToken();
      if (!isCurrent()) return;
      const summary = await ReferralService.getSummary({ idToken });
      if (isCurrent()) setReferralState({ visit, summary });
    } catch {
      if (isCurrent()) setReferralErrorVisit(visit);
    }
  }, [user, profileVisit]);
  const revokeReferral = useCallback(async (slug: string) => {
    const visit = profileVisit;
    const context = vaultContext();
    const revision = cardActionScopeRef.current.revision;
    const isCurrent = () => profileVisitRef.current === visit &&
      cardActionScopeRef.current.revision === revision && document.visibilityState !== "hidden" &&
      activeOwnerIdRef.current === context?.userId && getVaultOwnerTokenRef.current() === context?.vaultOwnerToken;
    if (!user || !context || !isCurrent()) throw new Error("Unlock your vault to revoke access.");
    const idToken = await user.getIdToken();
    if (!isCurrent()) throw new Error("Your session changed.");
    ++referralReadRevision.current;
    const summary = await ReferralService.rotateShareLink({ idToken, slug });
    if (!isCurrent()) throw new Error("Your session changed.");
    // Only the current visit may retire pre-mutation reads.
    ++referralReadRevision.current;
    setReferralState({ visit, summary });
    setReferralErrorVisit(null);
  }, [user, vaultContext, profileVisit]);
  useEffect(() => { void loadReferral(); }, [loadReferral]);
  const { connected: referralConnected } = useReferralStream(user, loadReferral);
  useEffect(() => {
    if (!user || referralConnected) return;
    const visible = () => { if (document.visibilityState !== "hidden") void loadReferral(); };
    const timer = window.setInterval(visible, 30000);
    window.addEventListener("focus", visible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", visible); };
  }, [user, referralConnected, loadReferral]);
  const referralSummary = referralState?.visit === profileVisit ? referralState.summary : null;
  const walletIdentity = demoProfile ? { ...demoProfile, referralUrl: referralSummary?.link ?? null } : null;
  // Decryption is asynchronous; whether the vault is still open is re-read
  // from the latest render when it settles, never from the tap that began it.
  const vaultContextRef = useRef(vaultContext);
  vaultContextRef.current = vaultContext;
  useEffect(() => {
    setRemoveTarget(null);
  }, [renderedOwnerId, vaultKey]);

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
      const previous = cardSnapshotRef.current;
      const retain = previous?.ownerId === context.userId && previous.epoch === snapshotVaultSessionEpoch();
      const warm = WalletPresentationResource.peek(context.userId);
      if (!retain && warm) {
        setCardSnapshot(presentationState(warm));
        dispatch({ type: "load_succeeded", cardIds: warm.rows.map(row => row.summary.cardId) });
      } else if (!retain && !options?.quiet) dispatch({ type: "load_started" });
      try {
        const captured = cardSnapshotRef.current;
        const snapshot = await WalletPresentationResource.load(context, { force: Boolean(options?.quiet), onArtworkRejected: references => {
          if (activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
          setCardSnapshot(previous => {
            if (previous?.ownerId !== context.userId) return previous;
            const artworks = { ...previous.artworks };
            for (const reference of references) {
              const current = artworks[reference.cardId];
              if (current?.source === "catalog" && (current === captured?.artworks[reference.cardId] || (current.assetId === reference.assetId && current.digest === reference.digest))) artworks[reference.cardId] = { source: "neutral", version: 1 };
            }
            return { ...previous, artworks };
          });
        } });
        const presentations = snapshot.rows;
        const summaries = presentations.map((card) => card.summary);
        if (readRevision !== cardReadRevision.current || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
        setCardSnapshot(presentationState(snapshot));
        dispatch({ type: "load_succeeded", cardIds: summaries.map((card) => card.cardId), quiet: Boolean(retain) });
      } catch {
        if (readRevision !== cardReadRevision.current || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
        if (retain) return;
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
    return subscribeToPkmDomainChanges(detail => {
      if (detail.domain === "wallet" && detail.userId === activeOwnerIdRef.current) void refresh({ quiet: true });
    });
  }, [refresh]);

  // Expiry belongs to the owner snapshot, independently of any request or
  // mutation. Adding/deleting a card cannot strand a stalled recheck's lease.
  useEffect(() => {
    const context = vaultContextRef.current(), expiry = cardSnapshot?.artworkExpiresAt;
    if (!context || expiry === undefined || cardSnapshot?.ownerId !== context.userId) return;
    const epoch = snapshotVaultSessionEpoch();
    const timer = window.setTimeout(() => {
      if (!isVaultSessionEpochCurrent(epoch) || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
      setCardSnapshot(previous => previous?.ownerId === context.userId && previous.artworkExpiresAt === expiry ? {
        ...previous,
        pendingArtworkIds: new Set(previous.cards.filter(card => previous.artworks[card.cardId]?.source === "catalog").map(card => card.cardId)),
        artworks: Object.fromEntries(Object.entries(previous.artworks).map(([id, artwork]) => [id, artwork?.source === "catalog" ? { source: "neutral" as const, version: 1 as const } : artwork])),
      } : previous);
    }, Math.max(0, expiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [cardSnapshot?.ownerId, cardSnapshot?.artworkExpiresAt, renderedOwnerId, vaultKey, vaultOwnerToken]);

  // A display approval lasts at most one visible minute, only in this unlocked
  // owner snapshot. Refresh before it expires without blanking current pixels.
  useEffect(() => {
    let disposed = false, inFlight = false;
    const recheck = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      const before = cardSnapshotRef.current, context = vaultContextRef.current();
      if (!context || before?.ownerId !== context.userId) return;
      if (!before.cards.length) return;
      inFlight = true;
      // Cosmetic work cannot invalidate an authoritative card load or mutation.
      const revision = cardReadRevision.current;
      const isCurrent = () => !disposed && revision === cardReadRevision.current && cardSnapshotRef.current?.cards === before.cards && activeOwnerIdRef.current === context.userId && vaultContextRef.current()?.vaultKey === context.vaultKey;
      const hideExpiredArtwork = () => { if (isCurrent()) setCardSnapshot(previous => previous?.ownerId === context.userId ? {
        ...previous,
        pendingArtworkIds: new Set(previous.cards.filter(card => previous.artworks[card.cardId]?.source === "catalog" || (card.brand !== "other" && previous.artworks[card.cardId]?.source !== "photo")).map(card => card.cardId)),
        artworks: Object.fromEntries(Object.entries(previous.artworks).map(([id, artwork]) => [id, artwork?.source === "catalog" ? { source: "neutral" as const, version: 1 as const } : artwork])),
      } : previous); };
      const remainingApproval = before.artworkExpiresAt - Date.now();
      if (remainingApproval <= 0) hideExpiredArtwork();
      try {
        const refreshed = await WalletPresentationResource.load(context, { force: true, onArtworkRejected: references => {
          // A known denial takes effect immediately, even if another card's
          // image is still loading or the collection changed during this read.
          if (disposed || activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) return;
          setCardSnapshot(previous => {
            if (previous?.ownerId !== context.userId) return previous;
            const artworks = { ...previous.artworks }, pendingArtworkIds = new Set(previous.pendingArtworkIds);
            for (const reference of references) {
              const current = artworks[reference.cardId];
              // A read-only cleaned revision still depends on the persisted
              // source approval. Its displayed digest differs from that source.
              const capturedDisplay = current === before.artworks[reference.cardId];
              const sameReference = current?.source === "catalog" && current.assetId === reference.assetId && current.digest === reference.digest;
              if (current?.source !== "catalog" || (!capturedDisplay && !sameReference)) continue;
              artworks[reference.cardId] = { source: "neutral", version: 1 }; pendingArtworkIds.delete(reference.cardId);
            }
            return { ...previous, artworks, pendingArtworkIds };
          });
        } });
        if (!isCurrent()) return;
        setCardSnapshot(previous => previous?.ownerId === context.userId ? { ...previous, pendingArtworkIds: new Set(refreshed.pendingArtworkIds ?? []), artworkExpiresAt: refreshed.artworkExpiresAt, artworks: Object.fromEntries(refreshed.rows.map(row => [row.summary.cardId, row.artwork])) } : previous);
      } catch {
        // A transport failure cannot renew approval. The independent deadline
        // still removes expired pixels; known denials above remove them sooner.
        if (before.artworkExpiresAt <= Date.now()) hideExpiredArtwork();
      }
      finally { inFlight = false; }
    };
    const resume = () => void recheck();
    if (consumedArtworkRetryRevision.current !== artworkRetryRevision) {
      consumedArtworkRetryRevision.current = artworkRetryRevision;
      resume();
    }
    const timer = window.setInterval(resume, 45_000);
    if (cardSnapshotRef.current && cardSnapshotRef.current.artworkExpiresAt - Date.now() <= 45_000) resume();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [renderedOwnerId, vaultKey, vaultOwnerToken, artworkRetryRevision]);

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
  const cardActionScopeRef = useRef({
    ownerId: renderedOwnerId,
    vaultKey,
    tab: activeTab,
    cardId: focusedCard?.cardId,
    focusedId: focusedCardId,
    revision: 0,
  });
  const previousScope = cardActionScopeRef.current;
  if (previousScope.ownerId !== renderedOwnerId || previousScope.vaultKey !== vaultKey ||
      previousScope.tab !== activeTab || previousScope.cardId !== focusedCard?.cardId ||
      previousScope.focusedId !== focusedCardId) {
    cardActionScopeRef.current = {
      ownerId: renderedOwnerId, vaultKey, tab: activeTab, cardId: focusedCard?.cardId,
      focusedId: focusedCardId,
      revision: previousScope.revision + 1,
    };
  }
  const numberScopeRevision = cardActionScopeRef.current.revision;
  // History belongs to the unlocked owner session, independent of card/tab selection.
  const historyVisibilityRevision = useRef(0);
  const getHistoryContext = useCallback((_cardId: string) => {
    const context = vaultContext();
    const epoch = snapshotVaultSessionEpoch();
    const visibilityRevision = historyVisibilityRevision.current;
    const isCurrent = () => {
      const current = vaultContextRef.current();
      return Boolean(context && current?.userId === context.userId && current.vaultKey === context.vaultKey &&
        current.vaultOwnerToken === context.vaultOwnerToken && isVaultSessionEpochCurrent(epoch) &&
        historyVisibilityRevision.current === visibilityRevision && document.visibilityState !== "hidden");
    };
    if (!context || !isCurrent()) return null;
    return { ...context, isCurrent, getIdToken: async () => {
      if (!isCurrent() || sharingUserRef.current?.uid !== context.userId) throw new Error("Wallet changed.");
      return sharingUserRef.current.getIdToken();
    } };
  }, [vaultContext]);
  const getCardShareContext = useCallback((cardId: string) => {
    const context = vaultContextRef.current();
    const revision = cardActionScopeRef.current.revision;
    const isCurrent = () => {
      const current = vaultContextRef.current();
      const scope = cardActionScopeRef.current;
      return Boolean(context && current?.userId === context.userId && current.vaultKey === context.vaultKey &&
        current.vaultOwnerToken === context.vaultOwnerToken && scope.revision === revision && scope.tab === "cards" &&
        scope.focusedId === cardId && scope.cardId === cardId && document.visibilityState !== "hidden");
    };
    if (!context || !isCurrent()) return null;
    return { ...context, isCurrent, getIdToken: async () => {
      if (!isCurrent() || sharingUserRef.current?.uid !== context.userId) throw new Error("Wallet changed.");
      return sharingUserRef.current.getIdToken();
    } };
  }, []);
  useEffect(() => {
    const invalidateCopy = () => {
      if (document.visibilityState === "hidden") {
        cardActionScopeRef.current.revision += 1;
        historyVisibilityRevision.current += 1;
      }
    };
    document.addEventListener("visibilitychange", invalidateCopy);
    return () => {
      cardActionScopeRef.current.revision += 1;
      historyVisibilityRevision.current += 1;
      document.removeEventListener("visibilitychange", invalidateCopy);
    };
  }, []);

  const readSecurityCode = async (cardId: string): Promise<string | undefined> => {
    const context = getCardShareContext(cardId);
    const epoch = snapshotVaultSessionEpoch();
    if (!context?.isCurrent()) throw new DOMException("Wallet changed", "AbortError");
    const code = await WalletService.getCardSecurityCode({ userId: context.userId, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, cardId });
    if (!context.isCurrent() || !isVaultSessionEpochCurrent(epoch)) throw new DOMException("Wallet changed", "AbortError");
    return code;
  };

  const copyCardNumber = async (cardId: string): Promise<boolean> => {
    const context = vaultContextRef.current();
    const revision = cardActionScopeRef.current.revision;
    const isCurrent = () => {
      const current = vaultContextRef.current();
      const scope = cardActionScopeRef.current;
      return context && current?.userId === context.userId && current.vaultKey === context.vaultKey &&
        current.vaultOwnerToken === context.vaultOwnerToken && scope.revision === revision &&
        scope.tab === "cards" && scope.focusedId === cardId && scope.cardId === cardId &&
        document.visibilityState !== "hidden";
    };
    if (!context || !isCurrent()) return false;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText && !clipboard?.write) throw new Error("Card copy unavailable");
    // Copy remains an explicit action with its own owner/surface validity check.
    const readNumber = async () => {
      const saved = await WalletService.getCard({ ...context, cardId });
      if (!isCurrent() || !saved?.secrets.pan) throw new Error("Card copy unavailable");
      return saved.secrets.pan;
    };
    try {
      if (clipboard.write && typeof ClipboardItem === "function") {
        // Start the write inside the click gesture. WebKit accepts the locally
        // decrypted value through the item's promise after that gesture ends.
        const data = readNumber().then(pan => new Blob([pan], { type: "text/plain" }));
        void data.catch(() => {}); // A denied write may never consume the item.
        await clipboard.write([new ClipboardItem({ "text/plain": data })]);
      } else {
        const pan = await readNumber();
        if (!isCurrent()) return false;
        await clipboard.writeText(pan);
      }
      return Boolean(isCurrent());
    } catch (error) {
      if (!isCurrent()) return false;
      throw error;
    }
  };

  const requestRemove = (card: WalletCardSummary) => {
    const context = vaultContextRef.current();
    if (context && !busyCardId) setRemoveTarget({ card, context });
  };
  const selectCard = (cardId: string) => {
    // Clearing a search also unfocuses the old card; focus the chosen result last.
    if (searchValue) updateSearch("");
    setSearchOpen(false);
    setSelectedDeckCardId(cardId);
    dispatch({ type: "unfocus" });
    if (!isAgentWalletCard(cardId)) dispatch({ type: "focus", cardId });
  };

  const removeCard = async (cardId: string, context: NonNullable<ReturnType<typeof vaultContext>>) => {
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
        // Return to the overview after removal. A neighboring card must be
        // explicitly opened before loading its number or sharing context.
        setSelectedDeckCardId(null);
      }
      cardReadRevision.current += 1;
      setCardSnapshot((previous) => {
        if (previous?.ownerId !== context.userId) return previous;
        const names = { ...previous.cardholderNames };
        delete names[cardId];
        return { ...previous, cards: previous.cards.filter((card) => card.cardId !== cardId), cardholderNames: names, pendingArtworkIds: new Set([...previous.pendingArtworkIds].filter(id => id !== cardId)) };
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
    const current = vaultContextRef.current();
    if (!current || current.userId !== target.context.userId || current.vaultKey !== target.context.vaultKey) return;
    void morphyToast.promise(removeCard(target.card.cardId, current), {
      loading: "Removing card…",
      success: "Card removed.",
      error: "The card could not be removed.",
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
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
      className={presentationStyles.quietAction}
      onClick={() => dispatch({ type: "unfocus" })}
      data-testid="one-wallet-done"
    >
      Done
    </Button>
  ) : null;

  const cardDetails = (
    <>
  {view.kind === "list" && focusedCard ? (
    <div
      className="motion-step-enter [animation-delay:var(--motion-duration-sm)]"
      data-testid="one-wallet-card-actions"
    >
      <WalletSavedCardDetails
        key={focusedCard.cardId}
        card={focusedCard}
        name={cardholderNames[focusedCard.cardId]}
        onCopyCardNumber={() => copyCardNumber(focusedCard.cardId)}
        onReadSecurityCode={() => readSecurityCode(focusedCard.cardId)}
        securityCodeScope={`${renderedOwnerId}:${numberScopeRevision}`}
        active={activeTab === "cards" && ready}
        onRemove={() => requestRemove(focusedCard)}
        disabled={Boolean(busyCardId)}
      />
      <WalletSavedCardSharing key={`${renderedOwnerId}:${numberScopeRevision}:${focusedCard.cardId}`} card={focusedCard} getContext={getCardShareContext} disabled={Boolean(busyCardId)} />

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
    ? removeTarget.card.nickname || `${cardNetworkLabel(removeTarget.card.brand)} ending ${removeTarget.card.last4}`
    : "";

  return (
    <AppPageShell
      as="div"
      width="standard"
      headerContentSpacing="compact"
      fitContent
      className="relative isolate [--app-page-content-bottom-gap:0px]"
    >
      <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-clip">
        <div
          className={cn(WALLET_COLUMN, presentationStyles.walletSurface)}
          data-wallet-hub
          data-testid="one-wallet-workspace"
          data-view={view.kind}
          onKeyDown={onKeyDown}
        >
          {headerAction ? <div className="flex min-h-11 justify-end" data-slot="wallet-header-action">{headerAction}</div> : null}
          <NativeTestBeacon
            routeId="/one/wallet"
            marker="native-route-one-wallet"
            authState={
              authLoading ? "pending" : user ? "authenticated" : "anonymous"
            }
            dataState={
              view.kind === "loading" || introductionLoading
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
            introductionLoading ? <div role="status" className="py-6 text-center text-xs text-muted-foreground">Opening your wallet…</div> :
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
          <div className={WALLET_TAB_PANEL}>
          {view.kind === "disabled" ? (
            <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Wallet is not available here yet.</p>
          ) : null}

          {view.kind === "loading" ? <div className="mx-auto w-full max-w-[420px] space-y-3 py-5" role="status" aria-label="Opening your wallet">
            <CardSlot variant="placeholder" />
            <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Opening your wallet…</p>
          </div> : null}

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
              <Button variant="secondary" size="compact" className={presentationStyles.quietAction} onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          ) : null}

          {showSearch && searchOpen ? (
            <div className="relative mx-auto w-full max-w-[820px]">
              <ProfilePaneSearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2"
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
            <WalletCardBrowser dockHost={cardDockHost} demoProfile={walletIdentity} referralSummary={referralSummary} referralError={referralErrorVisit === profileVisit} onRetryReferral={() => void loadReferral()} onRevokeReferral={revokeReferral} ownerId={renderedOwnerId || undefined}
              key={renderedOwnerId}
              cards={cards}
              cardholderNames={cardholderNames}
              artworks={artworks}
              pendingArtworkIds={ownedSnapshot?.pendingArtworkIds}
              selectedCardId={selectedDeckCardId}
              onSelect={selectCard}
              onOverview={() => { cardActionScopeRef.current.revision += 1; setSelectedDeckCardId(null); dispatch({ type: "unfocus" }); }}
              onAdd={() => selectTab("add")}
              details={cardDetails}
              active={activeTab === "cards"}
              onRemove={requestRemove}
              busyCardId={removingCardId}
              disabled={Boolean(busyCardId)}
            />
          ) : null}
          </div>
          <div className={WALLET_TAB_PANEL}>
          {ready ? (
            <div className="mx-auto w-full max-w-[820px] pb-4">
              <SecureCardAddForm
                backRoute={ROUTES.ONE_WALLET}
                collectSecurityCode
                showIntroduction={false}
                getNetworkContext={vaultContext}
                scanInToolbar
                key={`${renderedOwnerId}:${filing?.secretId ?? "new"}:${offerNickname ?? ""}:${formRevision}`}
                active={activeTab === "add"}
                initialNickname={offerNickname ?? undefined}
                initialPan={filing?.pan}
                onSubmit={async (card) => {
                  const save = Symbol("wallet-add");
                  addSaveInFlight.current = save;
                  try {
                    const context = vaultContext();
                    if (!context) throw new Error("Unlock your vault to save a card.");
                    let savedCardId: string | null = null;
                    let retryArtwork = false;
                    try {
                      const saved = await WalletService.addCard({
                        ...context,
                        card,
                        surface: "web",
                        source: "one_wallet_add",
                        reserveCardId: async () => {
                          let registered: string | null = null;
                          try {
                            const token = await user!.getIdToken();
                            if (activeOwnerIdRef.current !== context.userId) throw new Error("Wallet changed.");
                            registered = (await WalletCardAccessService.reserve(token, context.vaultOwnerToken, card.draftId || crypto.randomUUID())).cardId;
                          } catch { /* A backend rollout must not prevent saving an unverified card. */ }
                          if (activeOwnerIdRef.current !== context.userId || vaultContextRef.current()?.vaultKey !== context.vaultKey) throw new Error("Wallet changed.");
                          return registered;
                        },
                      });
                      const current = vaultContextRef.current();
                      if (activeOwnerIdRef.current !== context.userId || !current || current.vaultKey !== context.vaultKey) return;
                      // A list request begun before this receipt cannot remove the new card.
                      cardReadRevision.current += 1;
                      const priorSnapshot = cardSnapshotRef.current;
                      const retryExpired = priorSnapshot?.ownerId === context.userId && priorSnapshot.cards.length > 0 && priorSnapshot.artworkExpiresAt <= Date.now();
                      setCardSnapshot((previous) => {
                        const owned = previous?.ownerId === context.userId ? previous : null;
                        const now = Date.now(), expired = !owned || owned.artworkExpiresAt <= now;
                        const pendingArtworkIds = new Set(owned?.pendingArtworkIds);
                        const artworks = { ...owned?.artworks };
                        if (expired) for (const [id, artwork] of Object.entries(artworks)) {
                          if (artwork?.source === "catalog") { artworks[id] = { source: "neutral", version: 1 }; pendingArtworkIds.add(id); }
                        }
                        pendingArtworkIds.delete(saved.cardId);
                        if (saved.summary.brand !== "other" && (!saved.artwork || saved.artwork.source === "neutral")) pendingArtworkIds.add(saved.cardId);
                        return {
                          ownerId: context.userId,
                          epoch: snapshotVaultSessionEpoch(),
                          cards: [...(owned?.cards ?? []).filter((item) => item.cardId !== saved.cardId), saved.summary],
                          cardholderNames: { ...owned?.cardholderNames, [saved.cardId]: saved.cardholderName },
                          artworks: { ...artworks, [saved.cardId]: saved.artwork },
                          pendingArtworkIds,
                          // A fresh save may start a lease after clearing expired
                          // old images; it must never extend those old approvals.
                          artworkExpiresAt: expired ? now + 60_000 : owned.artworkExpiresAt,
                        };
                      });
                      setSelectedDeckCardId(saved.cardId);
                      savedCardId = saved.cardId;
                      retryArtwork = !saved.artwork || saved.artwork.source === "neutral" || retryExpired;
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
                    tabHistory.current = [];
                    activeTabCursor.current = "cards";
                    setTab("cards");
                    dispatch({ type: "close_add" });
                    if (savedCardId) dispatch({ type: "focus", cardId: savedCardId });
                    // Show the saved card immediately; recover optional art in the background.
                    if (retryArtwork) setArtworkRetryRevision(revision => revision + 1);
                    setOfferNickname(null);
                    if (filing) {
                      clearSecretOffer();
                      void SecretsVaultService.markFiled({ ...context, secretId: filing.secretId, filedTo: "wallet" }).catch(() => undefined);
                      setFiling(null);
                    }
                  } finally { if (addSaveInFlight.current === save) addSaveInFlight.current = null; }
                }}
                onCancel={returnToWalletView}
              />
            </div>
          ) : null}
          </div>
          <div className={WALLET_TAB_PANEL} data-testid="one-wallet-sharing">
            {ready ? <WalletSharing key={renderedOwnerId} cards={cards} profile={walletIdentity} active={activeTab === "sharing"} getHistoryContext={getHistoryContext} /> : null}
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
          <AlertDialogContent className={cn(profileStyles.accountDialog, profileStyles.dangerDialog, presentationStyles.walletDialog)} data-testid="one-wallet-remove-confirm">
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

        {ready && !introductionOpen && vaultKey && vaultOwnerToken && cardRequestId ? <WalletCardRequestReview key={`${renderedOwnerId}:${cardRequestId}`} requestId={cardRequestId} cards={cards} getContext={getHistoryContext} onClose={closeCardRequest} /> : null}
        {user && unlockOpen ? (
          <VaultUnlockDialog
            user={user}
            open={unlockOpen}
            onOpenChange={setUnlockOpen}
            onSuccess={() => setUnlockOpen(false)}
            title="Unlock your wallet"
            description="Enter your vault password to see your cards."
            allowVaultCreation={false}
          />
        ) : null}
      </AppPageContentRegion>
      <div ref={setCardDockHost} hidden={introductionOpen || !ready || activeTab !== "cards" || Boolean(searchOpen && deferredQuery)} className={cn(browserStyles.dockHost, "sticky bottom-0 z-20 mx-auto h-0 w-full max-w-[820px] overflow-hidden bg-transparent p-0")} data-testid="wallet-card-dock-host" />
    </AppPageShell>
  );
}
