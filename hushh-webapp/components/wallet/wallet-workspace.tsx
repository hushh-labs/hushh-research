"use client";

/**
 * Wallet workspace - the /one/wallet owner surface for the reserved
 * wallet PKM domain. Everything decrypts on this device under the
 * vault key; the server only ever holds ciphertext plus the non-secret
 * summary envelope. Distinct from the Wallet Profile surface.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useState, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import { Input } from "@/components/ui/input";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";
import {
  CardNetworkMark,
  cardNetworkLabel,
} from "@/components/wallet/card-network-mark";
import { SecureCardReveal } from "@/components/wallet/secure-card-reveal";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  WalletService,
  type WalletCardSecrets,
  type WalletCardSummary,
} from "@/lib/services/wallet-service";
import { useVault } from "@/lib/vault/vault-context";

type WorkspaceView =
  | { kind: "disabled" }
  | { kind: "locked" }
  | { kind: "loading" }
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "reveal"; summary: WalletCardSummary; secrets: WalletCardSecrets }
  | { kind: "error"; message: string };

const WALLET_PAGE_SIZE = 10;

export function WalletWorkspace() {
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  // Read the token getter through a ref: its identity changes with the vault
  // context, and putting it in effect deps re-ran the list load on every render.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  getVaultOwnerTokenRef.current = getVaultOwnerToken;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState<WorkspaceView>({ kind: "loading" });
  const [cards, setCards] = useState<WalletCardSummary[]>([]);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    if (!WalletService.isEnabled()) {
      setView({ kind: "disabled" });
      return;
    }
    const context = vaultContext();
    if (!context) {
      setView({ kind: "locked" });
      return;
    }
    setView({ kind: "loading" });
    try {
      const summaries = await WalletService.listCardSummaries(context);
      setCards(summaries);
      setView({ kind: "list" });
    } catch (error) {
      setView({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Your cards could not be loaded.",
      });
    }
  }, [vaultContext]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revealCard = async (cardId: string) => {
    const context = vaultContext();
    if (!context) return;
    setBusyCardId(cardId);
    try {
      const full = await WalletService.getCard({ ...context, cardId });
      if (full) {
        setView({ kind: "reveal", summary: full.summary, secrets: full.secrets });
      }
    } finally {
      setBusyCardId(null);
    }
  };

  const removeCard = async (cardId: string) => {
    const context = vaultContext();
    if (!context) return;
    setBusyCardId(cardId);
    try {
      await WalletService.deleteCard({
        ...context,
        cardId,
        surface: "web",
        source: "one_wallet_remove",
      });
      await refresh();
    } finally {
      setBusyCardId(null);
    }
  };

  return (
    <PkmSettingsShell
      title="Wallet"
      description="Encrypted in your vault. Shared only with your consent."
      innerClassName="mx-auto max-w-[640px]"
    >
      <div className="flex w-full flex-col gap-4" data-testid="one-wallet-workspace">
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
      {view.kind === "list" ? (
        <div className="flex justify-end">
          <Button onClick={() => setView({ kind: "add" })} data-testid="one-wallet-add">
            Add card
          </Button>
        </div>
      ) : null}

      {view.kind === "disabled" ? (
        <p className="text-sm text-muted-foreground">
          Wallet is not available here yet.
        </p>
      ) : null}

      {view.kind === "locked" ? (
        <p className="text-sm text-muted-foreground">
          Unlock your vault to see your cards.
        </p>
      ) : null}

      {view.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">Decrypting…</p>
      ) : null}

      {view.kind === "error" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{view.message}</p>
          <Button variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}

      {view.kind === "list" && cards.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border p-6">
          <p className="text-sm text-muted-foreground">No cards yet.</p>
          <Button onClick={() => setView({ kind: "add" })}>Add a card</Button>
        </div>
      ) : null}

      {view.kind === "list" && cards.length > 0 ? (
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            aria-label="Search cards"
            placeholder="Search by nickname, network, last four, or region"
            className="pl-9"
            data-testid="one-wallet-search"
          />
        </div>
      ) : null}

      {view.kind === "list" && cards.length > 0 && filteredCards.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="one-wallet-no-match">
          No cards match that search.
        </p>
      ) : null}

      {view.kind === "list" && pageCards.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="one-wallet-list">
          {pageCards.map((card) => (
            <li
              key={card.cardId}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                <CardNetworkMark brand={card.brand} />
                <div className="min-w-0">
                <p className="font-medium">{card.nickname || cardNetworkLabel(card.brand)}</p>
                <p className="text-sm text-muted-foreground">
                  {cardNetworkLabel(card.brand)} ····{card.last4} ·{" "}
                  {String(card.expiryMonth).padStart(2, "0")}/
                  {String(card.expiryYear).slice(-2)} · {card.issuingRegion}
                </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyCardId === card.cardId}
                  onClick={() => void revealCard(card.cardId)}
                  data-testid={`one-wallet-reveal-${card.last4}`}
                >
                  Reveal
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyCardId === card.cardId}
                  onClick={() => void removeCard(card.cardId)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {view.kind === "list" && filteredCards.length > 0 ? (
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
        <SecureCardAddForm
          onSubmit={async (card) => {
            const context = vaultContext();
            if (!context) throw new Error("Unlock your vault to save a card.");
            await WalletService.addCard({
              ...context,
              card,
              surface: "web",
              source: "one_wallet_add",
            });
            await refresh();
          }}
          onCancel={() => setView({ kind: "list" })}
        />
      ) : null}

      {view.kind === "reveal" ? (
        <SecureCardReveal
          summary={view.summary}
          secrets={view.secrets}
          onHide={() => setView({ kind: "list" })}
        />
      ) : null}
      </div>
    </PkmSettingsShell>
  );
}
