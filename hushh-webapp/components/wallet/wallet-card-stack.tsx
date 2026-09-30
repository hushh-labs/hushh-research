"use client";

/**
 * The Wallet stack. At rest each card shows a strip above the next, like
 * cards in a holder; choosing one lifts it to the top while the others gather
 * behind it, and choosing it again (or Done) fans them back out along the
 * same path.
 *
 * Motion is transform and opacity only, on the shared sheet-travel tokens (a
 * card can cross most of a phone screen) with no overshoot, and nothing at
 * all under reduced motion. The stack's height is set once per state by an
 * in-flow spacer, never animated, so no frame re-lays-out the page.
 */

import { forwardRef } from "react";

import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import {
  formatCardExpiry,
  stackCardPlacement,
  stackTrailingHeight,
} from "@/lib/wallet/wallet-card-presentation";

export interface WalletCardStackProps {
  cards: WalletCardSummary[];
  focusedCardId: string | null;
  /** Decrypted values for the focused card while it is revealed. */
  revealed?: { pan: string; cardholderName: string } | null;
  detailsId: string;
  onSelect: (cardId: string) => void;
}

const CARD_MOTION =
  "[transition:transform_var(--motion-sheet-enter-duration)_var(--motion-sheet-enter-ease),opacity_var(--motion-duration-xl)_var(--motion-ease-decelerate)] motion-reduce:[transition:none]";

function cardLabel(card: WalletCardSummary): string {
  const network = cardNetworkLabel(card.brand);
  const name = card.nickname || network;
  return `${name}, ${network} ending ${card.last4}, expires ${formatCardExpiry(card.expiryMonth, card.expiryYear)}`;
}

export const WalletCardStack = forwardRef<HTMLDivElement, WalletCardStackProps>(
  function WalletCardStack({ cards, focusedCardId, revealed, detailsId, onSelect }, ref) {
    const focusedIndex = focusedCardId
      ? cards.findIndex((card) => card.cardId === focusedCardId)
      : -1;
    const focused = focusedIndex >= 0;

    return (
      <div
        ref={ref}
        className="@container relative w-full"
        data-testid="wallet-stack"
        data-state={focused ? "focused" : "resting"}
      >
        {/* Sets the stack's height: one card, plus a strip per card behind it. */}
        <div
          aria-hidden="true"
          data-slot="wallet-stack-spacer"
          className="aspect-[85.6/53.98] w-full"
          style={{ marginBottom: stackTrailingHeight(cards.length, focused) }}
        />
        <ul
          data-testid="one-wallet-list"
          aria-label="Cards"
          className="absolute inset-x-0 top-0 m-0 list-none p-0"
        >
          {cards.map((card, index) => {
            const placement = stackCardPlacement(index, cards.length, focused ? focusedIndex : null);
            const isFocused = index === focusedIndex;
            return (
              <li
                key={card.cardId}
                data-testid="wallet-card"
                data-card-id={card.cardId}
                data-focused={isFocused ? "true" : "false"}
                aria-hidden={placement.hidden || undefined}
                inert={placement.hidden || undefined}
                className={`absolute inset-x-0 top-0 ${CARD_MOTION}`}
                style={{
                  transform: `translate3d(0, ${placement.y}px, 0)`,
                  opacity: placement.hidden ? 0 : 1,
                  zIndex: placement.zIndex,
                  pointerEvents: placement.hidden ? "none" : undefined,
                }}
              >
                <button
                  type="button"
                  data-testid={`one-wallet-card-${card.last4}`}
                  aria-label={cardLabel(card)}
                  aria-expanded={isFocused}
                  aria-controls={isFocused ? detailsId : undefined}
                  onClick={() => onSelect(card.cardId)}
                  className="block w-full rounded-[3.72cqw] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <WalletCardFace summary={card} revealed={isFocused ? revealed : null}>
                    <MaterialRipple variant="none" effect="fill" />
                  </WalletCardFace>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  },
);
