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
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import {
  PageTitle,
  PageSubtitle,
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
import { WalletCardStack } from "@/components/wallet/wallet-card-stack";
import { useAuth } from "@/hooks/use-auth";
import { prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { trackEvent } from "@/lib/observability/client";
import {
  WalletService,
  type WalletCardSummary,
} from "@/lib/services/wallet-service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { CARD_CORNER_RADIUS_RATIO } from "@/lib/wallet/wallet-card-presentation";
import {
  INITIAL_WALLET_VIEW,
  focusedCardIdOf,
  walletViewReducer,
} from "@/lib/wallet/wallet-view-state";
import { takeReservedOfferPrefill } from "@/lib/pkm/reserved-offer";

const WALLET_PAGE_SIZE = 10;

/** One column for header and content, so both share a start line. */
const WALLET_COLUMN = "mx-auto w-full max-w-[26.5rem]";

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

function WalletEmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <section
      className="flex w-full flex-col items-center pt-12 text-center lg:pt-6"
      aria-labelledby="one-wallet-empty-title"
      data-testid="one-wallet-empty"
    >
      <div
        className="relative aspect-[698/894] w-[min(70vw,19rem)] lg:h-[clamp(10rem,calc(100svh-33rem),19rem)] lg:w-auto"
        aria-hidden="true"
        data-testid="one-wallet-empty-art"
      >
        <span className="pointer-events-none absolute inset-[9%] rounded-full bg-white/90 blur-3xl dark:bg-white/80" />
        <span className="pointer-events-none absolute inset-[20%] rounded-full bg-[color:var(--app-accent-surface)] blur-3xl" />
        <div className="absolute inset-0 overflow-hidden">
          <Image
            src="/wallet/wallet-cards-hero.png"
            alt=""
            width={1214}
            height={1295}
            sizes="(max-width: 434px) 70vw, 304px"
            className="absolute left-[-38.25%] top-[-22.82%] h-auto w-[173.93%] max-w-none"
            priority
          />
        </div>
      </div>

      <h2 id="one-wallet-empty-title" className="sr-only">
        All your cards. In one place.
      </h2>
      <PageTitle
        as="p"
        aria-hidden="true"
        className="mt-8 max-w-[20rem] text-balance lg:mt-6 lg:max-w-none lg:whitespace-nowrap"
        data-testid="one-wallet-empty-display-title"
      >
        <span className="block lg:inline">All your cards.</span>{" "}
        <span className="block lg:inline">In one place.</span>
      </PageTitle>
      <PageSubtitle className="mt-4 max-w-[20rem] text-balance lg:mt-3">
        Cards you add are encrypted on this device and kept in your vault.
      </PageSubtitle>
      <div className="mx-auto mt-7 w-full max-w-[244px] lg:mt-5">
        <Button
          size="prominent"
          className="w-full"
          onClick={onConnect}
          data-testid="one-wallet-empty-action"
        >
          Add a Card
        </Button>
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
  // Read the token getter through a ref: its identity changes with the vault
  // context, and putting it in effect deps re-ran the list load on every render.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  getVaultOwnerTokenRef.current = getVaultOwnerToken;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, dispatch] = useReducer(walletViewReducer, INITIAL_WALLET_VIEW);
  const [cards, setCards] = useState<WalletCardSummary[]>([]);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WalletCardSummary | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  // A chat offer ("Add Amex Gold to Wallet") hands over the nickname in memory
  // (lib/pkm/reserved-offer.ts); the owner enters the card here, as always.
  const [offerNickname, setOfferNickname] = useState<string | null>(null);
  // A card kept in Secrets that the owner chose to file here, decrypted from
  // the vault on this device. Memory only; cleared on save or cancel.
  const [filing, setFiling] = useState<{ secretId: string; pan: string } | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const detailsId = useId();
  // Search and page live in the URL (same shape as Consent Center's list), so a
  // filtered page is deep-linkable and survives Next client navigation.
  const routeQuery = searchParams?.get("q") || "";
  const page = Math.max(1, Number(searchParams?.get("page") || "1") || 1);
  const [searchValue, setSearchValue] = useState(routeQuery);
  const deferredQuery = useDeferredValue(searchValue.trim());

  useEffect(() => {
    if (routeQuery === deferredQuery) return;
    const next = new URLSearchParams(searchParams?.toString() || "");
    if (deferredQuery) next.set("q", deferredQuery);
    else next.delete("q");
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [deferredQuery, routeQuery, pathname, router, searchParams]);

  const goToPage = (target: number) => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    if (target <= 1) next.delete("page");
    else next.set("page", String(target));
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const filteredCards = useMemo(
    () => cards.filter((card) => WalletService.matchesQuery(card, deferredQuery)),
    [cards, deferredQuery],
  );
  const pageCount = Math.max(1, Math.ceil(filteredCards.length / WALLET_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageCards = filteredCards.slice((safePage - 1) * WALLET_PAGE_SIZE, safePage * WALLET_PAGE_SIZE);

  const vaultContext = useCallback(() => {
    const token = getVaultOwnerTokenRef.current();
    if (!user?.uid || !vaultKey || !token) return null;
    return { userId: user.uid, vaultKey, vaultOwnerToken: token };
  }, [user?.uid, vaultKey]);
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
      const context = vaultContext();
      if (!context) {
        dispatch({ type: "vault_unavailable" });
        return;
      }
      if (!options?.quiet) dispatch({ type: "load_started" });
      try {
        const summaries = await WalletService.listCardSummaries(context);
        setCards(summaries);
        dispatch({ type: "load_succeeded", cardIds: summaries.map((card) => card.cardId) });
      } catch (error) {
        dispatch({
          type: "load_failed",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Your cards could not be loaded.",
        });
      }
    },
    [vaultContext],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!renderedOwnerId || view.kind !== "list") return;
    const staged = takeReservedOfferPrefill({
      ownerUserId: renderedOwnerId,
      ownerFeature: "wallet",
      kind: "wallet_card",
    });
    if (!staged) return;
    setOfferNickname(staged.nickname);
    dispatch({ type: "open_add" });
  }, [renderedOwnerId, view.kind]);
  // "Add this card to Wallet" from a Secrets card: open the add form with the
  // number decrypted from the vault. The owner still commits it here.
  useEffect(() => {
    if (view.kind !== "list" || filing) return;
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
  }, [filing, user?.uid, vaultContext, view.kind]);

  const focusedCardId = focusedCardIdOf(view);
  const focusedCard = focusedCardId
    ? cards.find((card) => card.cardId === focusedCardId) ?? null
    : null;

  // A card chosen low in a long stack rises to the top of the stack; bring
  // that top into view so the chosen card and its actions stay on screen.
  useEffect(() => {
    if (!focusedCardId) return;
    stackRef.current?.scrollIntoView?.({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [focusedCardId]);

  const selectCard = (cardId: string) => {
    if (focusedCardId === cardId) {
      dispatch({ type: "unfocus" });
      return;
    }
    dispatch({ type: "focus", cardId });
  };

  const revealCard = async (cardId: string) => {
    const context = vaultContext();
    if (!context) {
      dispatch({ type: "vault_unavailable" });
      return;
    }
    setBusyCardId(cardId);
    try {
      const full = await WalletService.getCard({ ...context, cardId });
      if (full) {
        dispatch({
          type: "revealed",
          cardId,
          summary: full.summary,
          secrets: full.secrets,
          vaultUnlocked: vaultContextRef.current() !== null,
        });
      }
    } catch {
      morphyToast.error("This card could not be opened.");
    } finally {
      setBusyCardId(null);
    }
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
      dispatch({ type: "unfocus" });
      await refresh({ quiet: true });
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

  const hasCards = view.kind === "list" && cards.length > 0;
  const showSearch = hasCards && !focusedCardId && cards.length > WALLET_PAGE_SIZE;

  const headerAction = focusedCardId ? (
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

  const removeTitle = removeTarget
    ? removeTarget.nickname || `${cardNetworkLabel(removeTarget.brand)} ending ${removeTarget.last4}`
    : "";

  return (
    <AppPageShell
      as="div"
      width="reading"
      fitContent={view.kind === "list" && cards.length === 0}
    >
      <AppPageHeaderRegion>
        <div className={WALLET_COLUMN}>
          <PageHeader
            // Centred in the same 44px line as the header action, so the two
            // share one centre line at every width.
            title={
              <span className="flex min-h-11 items-center" data-slot="wallet-heading-line">
                Wallet
              </span>
            }
            actionsInlineMobile
            // The slot keeps its 44px height with or without an action, so
            // the header never changes height when the cards arrive.
            actions={
              <span className="flex h-11 items-center" data-slot="wallet-header-action">
                {headerAction}
              </span>
            }
          />
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div
          className={cn(WALLET_COLUMN, "flex flex-col gap-6")}
          data-testid="one-wallet-workspace"
          data-view={view.kind}
          onKeyDown={onKeyDown}
        >
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

          {view.kind === "disabled" ? (
            <p className={TYPOGRAPHY_CLASSNAMES.helperText}>Wallet is not available here yet.</p>
          ) : null}

          {view.kind === "loading" ? (
            <div aria-busy="true" data-testid="one-wallet-loading">
              <CardSlot variant="placeholder" />
              <span className="sr-only" role="status">
                Opening your wallet…
              </span>
            </div>
          ) : null}

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

          {view.kind === "list" && cards.length === 0 ? (
            <WalletEmptyState onConnect={() => dispatch({ type: "open_add" })} />
          ) : null}

          {showSearch ? (
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
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

          {(view.kind === "list" || view.kind === "reveal") && pageCards.length > 0 ? (
            <WalletCardStack
              ref={stackRef}
              cards={pageCards}
              focusedCardId={focusedCardId}
              revealed={
                view.kind === "reveal"
                  ? { pan: view.secrets.pan, cardholderName: view.secrets.cardholderName }
                  : null
              }
              detailsId={detailsId}
              onSelect={selectCard}
            />
          ) : null}

          {view.kind === "list" && focusedCard ? (
            <div
              id={detailsId}
              className="motion-step-enter [animation-delay:var(--motion-duration-sm)]"
              data-testid="one-wallet-card-actions"
            >
              <FlowActionGroup
                stacked
                primary={
                  <Button
                    size="standard"
                    isLoading={busyCardId === focusedCard.cardId}
                    onClick={() => void revealCard(focusedCard.cardId)}
                    data-testid={`one-wallet-reveal-${focusedCard.last4}`}
                  >
                    Show card details
                  </Button>
                }
                tertiary={
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={busyCardId === focusedCard.cardId}
                    className="text-[color:var(--app-destructive)] hover:bg-[color:color-mix(in_srgb,var(--app-destructive)_10%,transparent)]"
                    onClick={() => setRemoveTarget(focusedCard)}
                    data-testid="one-wallet-remove"
                  >
                    Remove card
                  </Button>
                }
              />
            </div>
          ) : null}

          {view.kind === "reveal" ? (
            <div id={detailsId} className="motion-step-enter">
              <SecureCardReveal
                summary={view.summary}
                secrets={view.secrets}
                showFace={false}
                onHide={() => dispatch({ type: "hide" })}
              />
            </div>
          ) : null}

          {view.kind === "list" && !focusedCardId && pageCount > 1 ? (
            <PaginatedListFooter
              page={safePage}
              limit={WALLET_PAGE_SIZE}
              total={filteredCards.length}
              hasMore={safePage < pageCount}
              onPrevious={() => goToPage(safePage - 1)}
              onNext={() => goToPage(safePage + 1)}
            />
          ) : null}

          {view.kind === "add" ? (
            <div className="motion-step-enter">
              <SecureCardAddForm
                key={filing?.secretId ?? "new"}
                initialNickname={offerNickname ?? undefined}
                initialPan={filing?.pan}
                onSubmit={async (card) => {
                  const context = vaultContext();
                  if (!context) throw new Error("Unlock your vault to save a card.");
                  try {
                    await WalletService.addCard({
                      ...context,
                      card,
                      surface: "web",
                      source: "one_wallet_add",
                    });
                    if (activeOwnerIdRef.current === context.userId) {
                      trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_added", result: "success" });
                    }
                  } catch (error) {
                    if (activeOwnerIdRef.current === context.userId) {
                      trackEvent("one_wallet_action", { route_id: "one_wallet", action: "card_added", result: "error" });
                    }
                    throw error;
                  }
                  setOfferNickname(null);
                  if (filing) {
                    clearSecretOffer();
                    void SecretsVaultService.markFiled({ ...context, secretId: filing.secretId, filedTo: "wallet" }).catch(() => undefined);
                    setFiling(null);
                  }
                  await refresh();
                }}
                onCancel={() => {
                  setOfferNickname(null);
                  clearSecretOffer();
                  setFiling(null);
                  dispatch({ type: "close_add" });
                }}
              />
            </div>
          ) : null}
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
    </AppPageShell>
  );
}
