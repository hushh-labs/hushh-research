"use client";

import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WalletAddCollection } from "./wallet-add-collection";
import { WalletCardFace } from "./wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, WalletDemoCardDetails } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import styles from "./wallet-card-browser.module.css";

const SAMPLE_STATEMENTS = [
  { total: "₹2,480.00", rewards: "480", transactions: [["Morning coffee", "₹280.00"], ["Grocery store", "₹1,200.00"], ["Bookshop", "₹1,000.00"]] },
  { total: "₹8,640.00", rewards: "1,280", transactions: [["Train tickets", "₹3,400.00"], ["Hotel stay", "₹4,800.00"], ["Airport café", "₹440.00"]] },
  { total: "₹3,250.00", rewards: "650", transactions: [["Online shopping", "₹2,400.00"], ["Dinner", "₹850.00"]] },
] as const;

type PreviewAction = "Payment" | "Statement" | "Rewards" | "Autopay" | "Card offers";

/** These are illustrations only. No payment service or saved-card records enter this view. */
function DemoActivity({ cardId, onPreview }: { cardId: string; onPreview: (action: PreviewAction) => void }) {
  const index = WALLET_DEMO_CARDS.findIndex((card) => card.cardId === cardId);
  const sample = SAMPLE_STATEMENTS[index] ?? SAMPLE_STATEMENTS[0];
  return <div className={styles.activity} data-testid="wallet-demo-activity">
    <div className={styles.sectionHeading}><h3 className="ui-text-section-title">September statement</h3></div>
    <button type="button" className={styles.statement} onClick={() => onPreview("Statement")}>
      <span><span className={styles.eyebrow}>Spending</span><strong>{sample.total}</strong></span>
      <ArrowRight aria-hidden="true" className="size-5" />
    </button>
    <div className={styles.sectionHeading}><h3 className="ui-text-section-title">Activity</h3><span>September</span></div>
    <ul className={styles.transactions}>{sample.transactions.map(([name, amount]) => <li key={name}><span>{name}</span><strong>{amount}</strong></li>)}</ul>
    <button type="button" className={styles.reward} onClick={() => onPreview("Rewards")}><span><span className={styles.eyebrow}>Rewards</span><strong>{sample.rewards} points</strong></span><ArrowRight aria-hidden="true" className="size-5" /></button>
    <div className={styles.quickActions}>
      {(["Payment", "Autopay", "Card offers"] as const).map((action) => <Button key={action} variant="secondary" size="compact" onClick={() => onPreview(action)}>{action}</Button>)}
    </div>
    <p className={styles.disclaimer}>Illustrative amounts. Payments are unavailable.</p>
  </div>;
}

export function WalletCardBrowser({ cards, selectedCardId, onSelect, onOverview, onAdd, onRemove, busyCardId, disabled = false, details, dockHost, active = true }: {
  cards: WalletCardSummary[];
  selectedCardId: string | null;
  onSelect: (id: string) => void;
  onOverview: () => void;
  onAdd: () => void;
  onRemove: (card: WalletCardSummary) => void;
  busyCardId: string | null;
  disabled?: boolean;
  details: ReactNode;
  dockHost: HTMLElement | null;
  active?: boolean;
}) {
  const demo = cards.length === 0;
  const collection = demo ? WALLET_DEMO_CARDS : cards;
  const [mode, setMode] = useState<"all" | "card">(selectedCardId && !demo ? "card" : "all");
  useEffect(() => {
    if (!demo && selectedCardId) setMode("card");
  }, [demo, selectedCardId]);
  const [demoId, setDemoId] = useState("demo-0");
  const [previewAction, setPreviewAction] = useState<PreviewAction | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const scrollDestination = useRef<number | null>(null);
  const [scrollingDown, setScrollingDown] = useState(false);
  useEffect(() => {
    const root = content.current?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!active || !root) return;
    let previousTop = Math.max(0, root.scrollTop);
    const onScroll = () => {
      const top = Math.max(0, Math.min(root.scrollTop, root.scrollHeight - root.clientHeight));
      const delta = top - previousTop;
      if (scrollDestination.current !== null) {
        const destination = scrollDestination.current;
        scrollDestination.current = null;
        if (Math.abs(top - destination) < 2) {
          previousTop = top;
          setScrollingDown(false);
          return;
        }
      }
      if (top <= 0) setScrollingDown(false);
      else if (Math.abs(delta) >= 2) setScrollingDown(delta > 0);
      if (Math.abs(delta) >= 2 || top <= 0) previousTop = top;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      setScrollingDown(false);
    };
  }, [active]);
  const selected = collection.find((card) => card.cardId === (demo ? demoId : selectedCardId)) ?? collection[0];
  if (!selected) return null;
  const index = collection.indexOf(selected);
  const isBusy = disabled || Boolean(busyCardId);
  const goToTop = () => {
    const element = content.current;
    const root = element?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!element || !root) return;
    const top = Math.max(0, Math.min(root.scrollHeight - root.clientHeight,
      root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 12));
    scrollDestination.current = Math.abs(root.scrollTop - top) >= 1 ? top : null;
    setScrollingDown(false);
    root.scrollTo({ top, behavior: "instant" });
  };
  const choose = (id: string) => {
    if (isBusy) return;
    setPreviewAction(null);
    if (demo) setDemoId(id);
    else onSelect(id);
    setMode("card");
    goToTop();
  };
  const showAll = () => {
    if (isBusy) return;
    setMode("all");
    setPreviewAction(null);
    onOverview();
    goToTop();
  };
  const finishSwipe = (event: TouchEvent) => {
    const start = gesture.current;
    gesture.current = null;
    const end = event.changedTouches[0];
    if (!start || !end || isBusy) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const next = collection[index + (dx < 0 ? 1 : -1)];
    if (next) choose(next.cardId);
  };
  const dock = <nav aria-label="Wallet card switcher" className={styles.dock} data-scrolling-down={scrollingDown} data-testid="wallet-card-switcher">
    <Button variant="ghost" size="compact" aria-pressed={mode === "all"} disabled={isBusy} onClick={showAll} className={styles.allButton}>All <span>({collection.length})</span></Button>
    <div className={styles.thumbnails} data-swipe-views-horizontal-scroll>
      {collection.map((card, cardIndex) => <button key={card.cardId} type="button" disabled={isBusy} aria-label={`Open ${card.nickname || cardNetworkLabel(card.brand)}, ending ${card.last4}`} aria-pressed={mode === "card" && selected.cardId === card.cardId} onClick={() => choose(card.cardId)} className={styles.thumbnailButton}>
        <span className={styles.thumbnail} data-finish={cardIndex % 3} aria-hidden="true"><span>{cardNetworkLabel(card.brand)}</span><i /><small>{card.last4}</small></span>
      </button>)}
    </div>
    <Button variant="secondary" size="compact" disabled={isBusy} aria-label="Add a card" onClick={onAdd} className={styles.plus}><Plus aria-hidden="true" className="size-5" /></Button>
  </nav>;
  return <div ref={content} className={styles.browser} data-testid="wallet-card-browser" data-mode={mode}>
    <h2 className={`${styles.title} ui-text-section-title`}>Your cards</h2>
    {mode === "all" ? <>
      <WalletAddCollection cards={collection} selectedCardId={null} onSelect={choose} onOpen={choose} onAdd={onAdd} onRemove={onRemove} busyCardId={busyCardId} disabled={disabled} preview={demo} scrollStack showActions={false} showDetailsLink />
      <div className={styles.quickActions}>
        <Button variant="secondary" size="standard" className="w-full" onClick={onAdd} disabled={isBusy}><Plus aria-hidden="true" />{demo ? "Add your first card" : "Add another card"}</Button>
        {demo ? <><Button variant="ghost" size="compact" onClick={() => setPreviewAction("Statement")}>Statements <ArrowRight aria-hidden="true" className="size-4" /></Button><Button variant="ghost" size="compact" onClick={() => setPreviewAction("Autopay")}>Autopay <ArrowRight aria-hidden="true" className="size-4" /></Button></> : null}
      </div>
    </> : <div key={`${demo ? "demo" : "saved"}-${selected.cardId}`} className="motion-step-enter space-y-5" data-testid="wallet-selected-card">
      <div className={styles.detailNavigation}><Button variant="ghost" size="compact" onClick={showAll} disabled={isBusy}><ArrowLeft aria-hidden="true" className="size-4" />All cards</Button><span>{index + 1} / {collection.length}</span><Button variant="ghost" size="compact" disabled={isBusy || index === collection.length - 1} aria-label="Next card" onClick={() => { const next = collection[index + 1]; if (next) choose(next.cardId); }}><ArrowRight aria-hidden="true" className="size-4" /></Button></div>
      {demo ? <div className={styles.paymentHeader}><Button variant="secondary" size="compact" onClick={() => setPreviewAction("Payment")}>Payment</Button></div> : null}
      <div data-swipe-views-horizontal-scroll onTouchStart={(event) => { const point = event.touches[0]; gesture.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null; }} onTouchEnd={finishSwipe} onTouchCancel={() => { gesture.current = null; }} className={styles.selectedFace}>
        {demo ? <WalletDemoCardFace summary={selected} /> : <WalletCardFace summary={selected} collection />}
      </div>
      {demo ? <><DemoActivity cardId={selected.cardId} onPreview={setPreviewAction} /><WalletDemoCardDetails cardId={selected.cardId} /></> : details}
    </div>}
    {active && dockHost ? createPortal(dock, dockHost) : null}
    <Dialog modal open={active && Boolean(previewAction)} onOpenChange={(open) => { if (!open) setPreviewAction(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{previewAction}</DialogTitle><DialogDescription>This feature is not connected to a bank. No money moves and no payment is scheduled.</DialogDescription></DialogHeader>
        <div className={styles.previewPanel}><strong>{previewAction === "Payment" ? "Payments are unavailable" : previewAction === "Autopay" ? "Autopay is not enabled" : previewAction === "Rewards" ? "Rewards are unavailable" : previewAction === "Statement" ? "September statement" : "Illustrative card offers"}</strong><p>Add your own card to keep its details securely in Wallet. Banking services are not connected.</p></div>
        <Button size="standard" onClick={() => setPreviewAction(null)}>Got it</Button>
      </DialogContent>
    </Dialog>
  </div>;
}
