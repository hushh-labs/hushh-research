"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { WalletCardPayload } from "@/lib/services/wallet-card-service";
import { buildWalletCardSvg, walletCardImageFields, walletCardImageKey, NWS_SAMPLE_DESCRIPTION, type WalletCardImageKind } from "@/lib/wallet/wallet-card-image";
import styles from "./wallet-demo-cards.module.css";

export type WalletDemoProfile = {
  ownerId?: string;
  shareToken?: string | null;
  displayName: string | null;
  shareUrl: string | null;
  cardPayload?: WalletCardPayload | null;
  memberSince?: string | null;
  walletId?: string | null;
  referralUrl?: string | null;
};

/** System cards have stable identities separate from encrypted payment records. */
const AGENT_CARDS = [
  { id: "agent-one-profile", name: "Agent One Profile", kind: "Profile", finish: "profile" },
  { id: "agent-one-referral", name: "Agent One Referral", kind: "Referral", finish: "referral" },
  { id: "agent-one-nws", name: "Agent One NWS", kind: "NWS", finish: "nws" },
] as const;

// Compatibility export: these are now live identity surfaces, not sample bank cards.
export const WALLET_DEMO_CARDS: WalletCardSummary[] = AGENT_CARDS.map((card) => ({
  cardId: card.id,
  nickname: card.name,
  brand: "other",
  last4: "",
  expiryMonth: 0,
  expiryYear: 0,
  issuingRegion: "",
  createdAt: "",
}));

export function isAgentWalletCard(cardId: string): boolean {
  return AGENT_CARDS.some((card) => card.id === cardId);
}

export function WalletDemoCardFace({ summary, profile, onArtworkLoad }: { summary: WalletCardSummary; profile?: WalletDemoProfile | null; onArtworkLoad?: () => void }) {
  const card = AGENT_CARDS.find((item) => item.id === summary.cardId);
  if (!card) return <WalletCardFace summary={summary} collection />;
  return <WalletAgentCardImage kind={card.finish} name={card.name} profile={profile} onArtworkLoad={onArtworkLoad} />;
}

function WalletAgentCardImage({ kind, name, profile, onArtworkLoad }: {
  kind: WalletCardImageKind; name: string; profile?: WalletDemoProfile | null; onArtworkLoad?: () => void;
}) {
  const requestKey = walletCardImageKey(kind, profile);
  const [image, setImage] = useState<{ key: string; url: string; loaded: boolean } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const fields = walletCardImageFields(profile);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void buildWalletCardSvg({ kind, profile, signal: controller.signal }).then((svg) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setImage({ key: requestKey, url: objectUrl, loaded: false });
      setFailedKey(null);
    }).catch(() => {
      if (!controller.signal.aborted) setFailedKey(requestKey);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // requestKey is the complete, immutable projection of visible owner values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  // A changed owner/link hides the prior image during render, before effects run.
  const currentImage = image?.key === requestKey ? image : null;
  const ready = currentImage?.loaded === true;
  return <div className={`@container ${styles.face}`}>
    <div data-testid="wallet-card-face" data-agent-card={kind} data-revealed="false" data-artwork-ready={ready} className={`${styles.artworkFrame} ${styles[kind]}`}>
      {!ready ? <div className={styles.placeholder} aria-hidden="true"><strong>AGENT ONE</strong><span>{kind.toUpperCase()}</span></div> : null}
      {currentImage ? <Image unoptimized loading="eager" key={currentImage.url} src={currentImage.url} alt={`${name}${kind === "nws" ? ". " + NWS_SAMPLE_DESCRIPTION : ""}`} width="1080" height="681" decoding="sync" draggable={false} className={styles.artwork} style={{ visibility: ready ? "visible" : "hidden" }} onLoad={() => {
        setImage((value) => value?.url === currentImage.url ? { ...value, loaded: true } : value);
        onArtworkLoad?.();
      }} onError={() => setFailedKey(requestKey)} /> : null}
      {failedKey === requestKey ? <span className="sr-only">The card image could not be loaded. Open details to view your card.</span> : null}
      {kind === "nws" ? <span className="sr-only">{NWS_SAMPLE_DESCRIPTION}</span> : null}
      <dl className="sr-only">
        <div><dt>Username</dt><dd>{fields.username}</dd></div>
        <div><dt>Member since</dt><dd>{fields.memberSince}</dd></div>
        <div><dt>Wallet ID</dt><dd>{fields.walletId}</dd></div>
      </dl>
    </div>
  </div>;
}

/** Kept for the Add illustration: owner details use WalletCardWorkspace. */
export function WalletDemoCardDetails({ cardId, profile }: { cardId: string; profile?: WalletDemoProfile | null }) {
  const card = AGENT_CARDS.find((item) => item.id === cardId);
  if (!card) return null;
  return <section aria-label={`${card.name} details`} className={styles.details} data-testid="wallet-demo-details">
    <h3 className="ui-text-section-title">{card.name}</h3>
    <p className="mt-1 text-sm text-muted-foreground">{profile?.displayName || "Your profile, ready to share."}</p>
  </section>;
}
