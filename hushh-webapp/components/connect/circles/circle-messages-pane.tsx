"use client";

import { useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/hooks/use-auth";
import { VaultContext } from "@/lib/vault/vault-context";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { CircleChat } from "./circle-chat";
import { AgentDockPortal } from "@/components/agent/agent-dock";
import { ArrowLeft, MessageCircle, Plus, UsersRound } from "@/components/icons";
import styles from "./circle-messages-pane.module.css";

function GroupAvatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  return <span className={styles.groupAvatar} aria-hidden="true">
    <span className={styles.groupAvatarBack}>{Array.from(name.trim())[0]?.toUpperCase() ?? "C"}</span>
    <span className={styles.groupAvatarFront}>{photoUrl ? <Image src={photoUrl} alt="" width={33} height={33} unoptimized /> : <UsersRound className="size-5" />}</span>
  </span>;
}

/** The Chat lane reuses the same Circle membership and encrypted thread as Connect. */
export function CircleMessagesPane({ onThreadOpenChange, laneSwitcher, theme = "light" }: {
  onThreadOpenChange?: (open: boolean) => void;
  laneSwitcher?: ReactNode;
  theme?: "light" | "dark";
}) {
  const { user } = useAuth();
  const vault = useContext(VaultContext);
  const token = vault?.vaultOwnerToken ?? null;
  const ownerId = user?.uid ?? null;
  const [loaded, setLoaded] = useState<{ token: string; ownerId: string; circles: OneLocationCircleSummary[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useBackLayer(ROUTES.ONE_MESSAGES, selectedId ? 1 : 0, () => {
    setSelectedId(null);
    return true;
  });

  useEffect(() => {
    onThreadOpenChange?.(Boolean(selectedId));
  }, [selectedId, onThreadOpenChange]);

  useEffect(() => {
    if (!token || !ownerId) return;
    let active = true;
    const refresh = async () => {
      setLoading(true);
      try {
        const circles = await OneLocationService.listCircles(token);
        if (!active) return;
        setLoaded({ token, ownerId, circles });
        setSelectedId((previous) => previous && circles.some((item) => item.id === previous) ? previous : null);
        setError(false);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [token, ownerId]);

  const circles = loaded?.token === token && loaded.ownerId === ownerId ? loaded.circles : [];
  const selected = circles.find((circle) => circle.id === selectedId) ?? null;
  const session = selected && ownerId && token && vault?.vaultKey ? {
    circleId: selected.id,
    userId: ownerId,
    vaultOwnerToken: token,
    vaultKey: vault.vaultKey,
  } : null;

  return <div className={styles.pane} data-circle-messages-pane>
    <AgentDockPortal enabled={!selected || !session} visible={false} suppressed>{null}</AgentDockPortal>
    <aside className={styles.list} data-thread-open={Boolean(selected) || undefined} aria-label="Circles">
      <div className={styles.listHeader}><strong>Circles</strong><Link href={ROUTES.CONNECT} aria-label="Manage circles"><Plus aria-hidden="true" className="size-5" /></Link></div>
      {laneSwitcher}
      {!token || !vault?.vaultKey ? <p className={styles.notice}>Unlock One to view your circles.</p> : null}
      {loading && !circles.length ? <p role="status" className={styles.notice}>Loading circles…</p> : null}
      {error ? <p role="alert" className={styles.notice}>Circles are unavailable. Return to this tab to retry.</p> : null}
      {!loading && !error && token && !circles.length ? <div className={styles.empty}>
        <UsersRound aria-hidden="true" className="size-7" />
        <p>No circles yet</p>
        <Link href={ROUTES.CONNECT}>Create a circle</Link>
      </div> : null}
      {circles.map((circle) => <button key={circle.id} type="button" className={styles.row}
        data-selected={selectedId === circle.id || undefined} onClick={() => setSelectedId(circle.id)}>
        <GroupAvatar name={circle.name} photoUrl={circle.photoUrl} />
        <span className={styles.rowText}><strong>{circle.name}</strong><span>{circle.memberCount} {circle.memberCount === 1 ? "member" : "members"}</span></span>
        <MessageCircle aria-hidden="true" className="size-4" />
      </button>)}
    </aside>
    <section className={styles.thread} data-thread-open={Boolean(selected) || undefined} aria-label={selected ? `${selected.name} messages` : "Circle messages"}>
      {selected && session ? <>
        <header className={styles.threadHeader}>
          <button type="button" className={styles.back} aria-label="Back to circles" onClick={() => setSelectedId(null)}><ArrowLeft aria-hidden="true" className="size-5" /></button>
          <GroupAvatar name={selected.name} photoUrl={selected.photoUrl} />
          <span className={styles.rowText}><strong>{selected.name}</strong><span>{selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}</span></span>
        </header>
        <CircleChat key={`${session.userId}:${session.circleId}:${session.vaultOwnerToken}`} session={session} circleName={selected.name} initialOpen collapsible={false} chatLane chatLaneTheme={theme} />
      </> : <div className={styles.placeholder}><UsersRound aria-hidden="true" className="size-8" /><p>Select a circle to start chatting.</p></div>}
    </section>
  </div>;
}
