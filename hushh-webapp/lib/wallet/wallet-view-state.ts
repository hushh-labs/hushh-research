/**
 * The Wallet screen's states and the only transitions between them.
 *
 * Two rules live here rather than in the component, so they hold for every
 * caller and are testable on their own:
 *
 *  1. A card's secrets enter the view only as a `revealed` event for the card
 *     the owner focused, and only while the vault is unlocked. Anything else
 *     leaves the view masked.
 *  2. The moment the vault becomes unavailable, every state (a reveal
 *     included) becomes `locked`, and the decrypted values are dropped with
 *     the state that held them.
 */

import type {
  WalletCardSecrets,
  WalletCardSummary,
} from "@/lib/services/wallet-service";

export type WalletViewState =
  | { kind: "disabled" }
  | { kind: "locked" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "list"; focusedCardId: string | null }
  | { kind: "add" }
  | {
      kind: "reveal";
      cardId: string;
      summary: WalletCardSummary;
      secrets: WalletCardSecrets;
    };

export type WalletViewEvent =
  | { type: "disabled" }
  | { type: "vault_unavailable" }
  | { type: "load_started" }
  | { type: "load_succeeded"; cardIds: readonly string[] }
  | { type: "load_failed"; message: string }
  | { type: "focus"; cardId: string }
  | { type: "unfocus" }
  | { type: "open_add" }
  | { type: "close_add" }
  | {
      type: "revealed";
      cardId: string;
      summary: WalletCardSummary;
      secrets: WalletCardSecrets;
      /** Re-read after decryption settles, never captured before it. */
      vaultUnlocked: boolean;
    }
  | { type: "hide" };

export const INITIAL_WALLET_VIEW: WalletViewState = { kind: "loading" };

export function walletViewReducer(
  state: WalletViewState,
  event: WalletViewEvent,
): WalletViewState {
  switch (event.type) {
    case "disabled":
      return { kind: "disabled" };
    case "vault_unavailable":
      return { kind: "locked" };
    case "load_started":
      return { kind: "loading" };
    case "load_failed":
      return { kind: "error", message: event.message };
    case "load_succeeded": {
      // A quiet refresh keeps the owner's place when the card still exists.
      if (state.kind === "list" && state.focusedCardId) {
        return event.cardIds.includes(state.focusedCardId)
          ? state
          : { kind: "list", focusedCardId: null };
      }
      if (state.kind === "reveal" && event.cardIds.includes(state.cardId)) {
        return state;
      }
      return { kind: "list", focusedCardId: null };
    }
    case "focus":
      return state.kind === "list"
        ? { kind: "list", focusedCardId: event.cardId }
        : state;
    case "unfocus":
      return state.kind === "list" || state.kind === "reveal"
        ? { kind: "list", focusedCardId: null }
        : state;
    case "open_add":
      return state.kind === "list" ? { kind: "add" } : state;
    case "close_add":
      return state.kind === "add" ? { kind: "list", focusedCardId: null } : state;
    case "revealed":
      if (!event.vaultUnlocked) return state;
      if (state.kind !== "list" || state.focusedCardId !== event.cardId) {
        return state;
      }
      return {
        kind: "reveal",
        cardId: event.cardId,
        summary: event.summary,
        secrets: event.secrets,
      };
    case "hide":
      return state.kind === "reveal"
        ? { kind: "list", focusedCardId: state.cardId }
        : state;
    default:
      return state;
  }
}

/** The card the owner is looking at, masked or revealed. */
export function focusedCardIdOf(state: WalletViewState): string | null {
  if (state.kind === "list") return state.focusedCardId;
  if (state.kind === "reveal") return state.cardId;
  return null;
}
