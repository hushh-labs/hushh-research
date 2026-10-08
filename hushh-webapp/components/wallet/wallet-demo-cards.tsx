"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import styles from "./wallet-demo-cards.module.css";
import { useRouter } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";
import {
  WALLET_ARTWORK_ACTION_MESSAGE,
  WALLET_ARTWORK_OPEN_PROFILE_ACTION,
  WALLET_ARTWORK_READY_MESSAGE,
  buildWalletArtworkMessage,
  type WalletCardIdentity,
  type WalletIdentityCard,
} from "@/lib/wallet/wallet-card-identity";

/** Which supplied artwork each illustration card uses. */
const ARTWORK = { "demo-0": "profile", "demo-1": "referral", "demo-2": "nws" } as const;

/** Fixed illustration records, never accepted as saved Wallet cards. */
const DEMOS = [
  { name: "Everyday", brand: "visa", number: "0000000000004242", month: 12, finish: "platinum", tier: "Platinum" },
  { name: "Travel", brand: "mastercard", number: "0000000000004444", month: 9, finish: "gold", tier: "Signature" },
  { name: "Rewards", brand: "visa", number: "0000000000001234", month: 6, finish: "graphite", tier: "Black" },
] as const;

export const WALLET_DEMO_CARDS: WalletCardSummary[] = DEMOS.map((demo, index) => ({
  cardId: `demo-${index}`,
  nickname: demo.name,
  brand: demo.brand,
  last4: demo.number.slice(-4),
  expiryMonth: demo.month,
  // Required by the card summary shape, never printed: faces, details and swipe
  // controls show the owner's real valid-through (see `walletDemoControls`).
  expiryYear: 2030,
  issuingRegion: "",
  createdAt: "",
}));

function demoFor(cardId: string) {
  const index = WALLET_DEMO_CARDS.findIndex((card) => card.cardId === cardId);
  return DEMOS[index];
}

/**
 * Keeps the Profile / Referral artwork in step with the signed-in owner.
 *
 * The artwork is a same-origin document, so its fields are drawn inside the
 * card itself (no layer over it, nothing to line up) from a message that the
 * artwork validates on arrival. The message is re-sent when the artwork loads,
 * when it announces it is ready, and whenever the owner's details change,
 * including back to empty on logout or an account switch.
 */
function useArtworkIdentity(
  frameRef: RefObject<HTMLIFrameElement | null>,
  card: WalletIdentityCard | null,
  identity: WalletCardIdentity | null | undefined,
) {
  const router = useRouter();
  const ownerId = identity?.ownerId ?? null;
  const name = identity?.name ?? null;
  const memberSince = identity?.memberSince ?? null;
  const validThru = identity?.validThru ?? null;
  const url = (card === "profile" ? identity?.profileUrl : identity?.referralUrl) ?? null;
  const profileStatus = identity?.profileStatus ?? "unknown";
  const message = useMemo(
    () =>
      card
        ? buildWalletArtworkMessage(card, {
            ownerId,
            name,
            memberSince,
            validThru,
            profileUrl: card === "profile" ? url : null,
            profileStatus,
            cardPayload: null,
            referralUrl: card === "referral" ? url : null,
          })
        : null,
    [card, ownerId, name, memberSince, validThru, url, profileStatus],
  );
  const post = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    if (target && message) target.postMessage(message, window.location.origin);
  }, [frameRef, message]);

  useEffect(() => {
    post();
  }, [post]);
  useEffect(() => {
    if (!message) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== window.location.origin) return;
      const type = event.data?.type;
      if (type === WALLET_ARTWORK_READY_MESSAGE) post();
      // The artwork may ask for exactly one thing, and only while its gate is up.
      if (
        type === WALLET_ARTWORK_ACTION_MESSAGE &&
        event.data?.action === WALLET_ARTWORK_OPEN_PROFILE_ACTION &&
        message.gate
      ) {
        router.push(ROUTES.ONE_WALLET_CARD);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, message, post, router]);
  return post;
}

/** Only the preview branch calls this; real cards never receive these numbers. */
export function WalletDemoCardFace({ summary, identity }: { summary: WalletCardSummary; identity?: WalletCardIdentity | null }) {
  const demo = demoFor(summary.cardId);
  if (!demo) return <WalletCardFace summary={summary} collection />;
  return <WalletArtworkFace summary={summary} finish={demo.finish} name={demo.name} identity={identity} />;
}

function WalletArtworkFace({ summary, finish, name, identity }: { summary: WalletCardSummary; finish: string; name: string; identity?: WalletCardIdentity | null }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const artwork = ARTWORK[summary.cardId as keyof typeof ARTWORK] ?? "nws";
  const identityCard = artwork === "nws" ? null : artwork;
  const post = useArtworkIdentity(frameRef, identityCard, identity);
  return (
    <div className={`${styles.face} ${styles[finish as keyof typeof styles]}`} data-demo-card="true">
      <div className="@container w-full">
        <div data-testid="wallet-card-face" data-revealed="true" className={styles.artworkFrame}>
          <iframe
            ref={frameRef}
            title={`${name} Agent One card`}
            src={`/wallet/agent-one-card-${artwork}.html?v=3`}
            className={styles.htmlArtwork}
            onLoad={post}
          />
          {/* The green NWS artwork is left as supplied; it only shows the owner's name. */}
          {artwork === "nws" && identity?.name ? <span className={styles.dynamicCardName}>{identity.name}</span> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * What the swipe-left controls print for the Profile and Referral cards: the
 * owner's real valid-through, never a sample date. The green NWS card is left
 * as it was, so it returns nothing and keeps its original controls.
 */
export function walletDemoControls(cardId: string, identity: WalletCardIdentity | null | undefined) {
  const artwork = ARTWORK[cardId as keyof typeof ARTWORK];
  if (artwork !== "profile" && artwork !== "referral") return undefined;
  return {
    title: `Agent One ${artwork === "profile" ? "Profile" : "Referral"}`,
    detail: identity?.validThru ? `Valid through ${identity.validThru}` : "Valid through —",
  };
}

export function WalletDemoCardDetails({ cardId, identity }: { cardId: string; identity?: WalletCardIdentity | null }) {
  const demo = demoFor(cardId);
  const summary = WALLET_DEMO_CARDS.find((card) => card.cardId === cardId);
  if (!demo || !summary) return null;
  const payload = identity?.cardPayload;
  // Dates belong to the Profile and Referral faces; the NWS card keeps its own.
  const showsDates = ARTWORK[cardId as keyof typeof ARTWORK] !== "nws";
  const fields = [
    ["Name", identity?.name || null],
    ["Member since", showsDates ? identity?.memberSince || null : null],
    ["Valid through", showsDates ? identity?.validThru || null : null],
    ["Headline", payload?.headline || null],
    ["Organisation", payload?.organisation || null],
    ["Location", payload?.location_label || null],
    ["Summary", payload?.summary || null],
    ["Email", payload?.email || null],
    ["Phone", payload?.phone || null],
    ["Website", payload?.website || null],
    ["LinkedIn", payload?.linkedin || null],
    ["Portfolio", payload?.portfolio || null],
  ].filter((field): field is [string, string] => Boolean(field[1]));
  return (
    <section aria-label="Wallet Profile details" aria-live="polite" className={styles.details} data-testid="wallet-demo-details">
      <div key={cardId} className="motion-step-enter space-y-4">
        <div className="space-y-1">
          <p className={TYPOGRAPHY_CLASSNAMES.helperText}>{demo.tier}</p>
          <h3 className={TYPOGRAPHY_CLASSNAMES.mediumRowLabel}>{demo.name} card</h3>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          {fields.map(([label, value], index) => (
            <div key={label} className={index === 0 ? "col-span-2 min-w-0" : "min-w-0"}>
              <dt className={TYPOGRAPHY_CLASSNAMES.helperText}>{label}</dt>
              <dd className="mt-1 break-words text-sm font-medium tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {!fields.length ? <p className={TYPOGRAPHY_CLASSNAMES.helperText}>No saved Wallet Profile information is available.</p> : null}
      </div>
    </section>
  );
}
