"use client";

/**
 * Cards workspace - the /one/cards owner surface for the reserved
 * payment_cards PKM domain. Everything decrypts on this device under the
 * vault key; the server only ever holds ciphertext plus the non-secret
 * summary envelope. Distinct from the Wallet Profile surface.
 */

import { useCallback, useEffect, useState } from "react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { SecureCardAddForm } from "@/components/cards/secure-card-add-form";
import { SecureCardReveal } from "@/components/cards/secure-card-reveal";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  PaymentCardsService,
  type PaymentCardSecrets,
  type PaymentCardSummary,
} from "@/lib/services/payment-cards-service";
import { useVault } from "@/lib/vault/vault-context";

type WorkspaceView =
  | { kind: "disabled" }
  | { kind: "locked" }
  | { kind: "loading" }
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "reveal"; summary: PaymentCardSummary; secrets: PaymentCardSecrets }
  | { kind: "error"; message: string };

export function CardsWorkspace() {
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const [view, setView] = useState<WorkspaceView>({ kind: "loading" });
  const [cards, setCards] = useState<PaymentCardSummary[]>([]);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);

  const vaultContext = useCallback(() => {
    const token = getVaultOwnerToken();
    if (!user?.uid || !vaultKey || !token) return null;
    return { userId: user.uid, vaultKey, vaultOwnerToken: token };
  }, [user?.uid, vaultKey, getVaultOwnerToken]);

  const refresh = useCallback(async () => {
    if (!PaymentCardsService.isEnabled()) {
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
      const summaries = await PaymentCardsService.listCardSummaries(context);
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
      const full = await PaymentCardsService.getCard({ ...context, cardId });
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
      await PaymentCardsService.deleteCard({
        ...context,
        cardId,
        surface: "web",
        source: "one_cards_remove",
      });
      await refresh();
    } finally {
      setBusyCardId(null);
    }
  };

  return (
    <PkmSettingsShell
      title="Cards"
      description="Encrypted in your vault. Shared only with your consent."
      innerClassName="mx-auto max-w-[640px]"
    >
      <div className="flex w-full flex-col gap-4" data-testid="one-cards-workspace">
      <NativeTestBeacon
        routeId="/one/cards"
        marker="native-route-one-cards"
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
          <Button onClick={() => setView({ kind: "add" })} data-testid="one-cards-add">
            Add card
          </Button>
        </div>
      ) : null}

      {view.kind === "disabled" ? (
        <p className="text-sm text-muted-foreground">
          Cards are not available here yet.
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
        <ul className="flex flex-col gap-2" data-testid="one-cards-list">
          {cards.map((card) => (
            <li
              key={card.cardId}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-4"
            >
              <div>
                <p className="font-medium">{card.nickname || card.brand}</p>
                <p className="text-sm text-muted-foreground">
                  {card.brand} ····{card.last4} ·{" "}
                  {String(card.expiryMonth).padStart(2, "0")}/
                  {String(card.expiryYear).slice(-2)} · {card.issuingRegion}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyCardId === card.cardId}
                  onClick={() => void revealCard(card.cardId)}
                  data-testid={`one-cards-reveal-${card.last4}`}
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

      {view.kind === "add" ? (
        <SecureCardAddForm
          onSubmit={async (card) => {
            const context = vaultContext();
            if (!context) throw new Error("Unlock your vault to save a card.");
            await PaymentCardsService.addCard({
              ...context,
              card,
              surface: "web",
              source: "one_cards_add",
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
          onDismiss={() => void refresh()}
        />
      ) : null}
      </div>
    </PkmSettingsShell>
  );
}
