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
import { writeLastMessagesSelection } from "@/lib/direct-messages/last-selection";
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
export function CircleMessagesPane({ active = true, initialCircleId = null, onThreadOpenChange, onCircleCountChange, laneSwitcher, headerActions, theme = "light" }: {
  active?: boolean;
  initialCircleId?: string | null;
  onThreadOpenChange?: (open: boolean) => void;
  onCircleCountChange?: (count: number) => void;
  laneSwitcher?: ReactNode;
  headerActions?: ReactNode;
  theme?: "light" | "dark";
}) {
  const { user } = useAuth();
  const vault = useContext(VaultContext);
  const token = vault?.vaultOwnerToken ?? null;
  const ownerId = user?.uid ?? null;
  const [loaded, setLoaded] = useState<{ token: string; ownerId: string; circles: OneLocationCircleSummary[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialCircleId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const closeThread = () => {
    setSelectedId(null);
    writeLastMessagesSelection(ownerId, { lane: "circles", circleId: null });
  };

  useEffect(() => {
    if (initialCircleId) setSelectedId(initialCircleId);
  }, [initialCircleId]);

  useEffect(() => {
    if (!active) setSelectedId(null);
  }, [active]);

  useBackLayer(ROUTES.ONE_MESSAGES, active && selectedId ? 1 : 0, () => {
    closeThread();
    return true;
  });

  useEffect(() => {
    if (!token || !ownerId) return;
    let active = true;
    const refresh = async () => {
      setLoading(true);
      try {
        // The directory also contains Trusted/SMS circles. Their private
        // roster contracts exclude group chat, even with active membership.
        const circles = (await OneLocationService.listCircles(token)).filter(
          (circle) => !circle.isSystem && !circle.systemKind,
        );
        if (!active) return;
        setLoaded({ token, ownerId, circles });
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
  useEffect(() => { onCircleCountChange?.(circles.length); }, [circles.length, onCircleCountChange]);
  const selected = circles.find((circle) => circle.id === selectedId) ?? null;
  const session = selected && ownerId && token && vault?.vaultKey ? {
    circleId: selected.id,
    userId: ownerId,
    vaultOwnerToken: token,
    vaultKey: vault.vaultKey,
  } : null;
  const sessionCircleId = session?.circleId ?? null;

  useEffect(() => {
    onThreadOpenChange?.(active && Boolean(sessionCircleId));
  }, [active, sessionCircleId, onThreadOpenChange]);

  useEffect(() => {
    if (!selectedId || !loaded || loaded.ownerId !== ownerId || loaded.token !== token) return;
    if (loaded.circles.some((circle) => circle.id === selectedId)) return;
    setSelectedId(null);
    if (active) writeLastMessagesSelection(ownerId, { lane: "circles", circleId: null });
  }, [active, loaded, ownerId, selectedId, token]);

  return <div className={styles.pane} data-circle-messages-pane data-active={active ? "true" : "false"} aria-hidden={!active} inert={!active}>
    <AgentDockPortal enabled={active && (!selected || !session)} visible={false} suppressed>{null}</AgentDockPortal>
    <aside className={styles.list} data-thread-open={Boolean(selected) || undefined} aria-label="Circles">
      <div className={styles.listHeader}><h1>Messages</h1><div className={styles.listHeaderActions}>{headerActions}<Link href={ROUTES.CONNECT} aria-label="Manage circles"><Plus aria-hidden="true" className="size-5" /></Link></div></div>
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
        data-selected={selectedId === circle.id || undefined} onClick={() => {
          setSelectedId(circle.id);
          writeLastMessagesSelection(ownerId, { lane: "circles", circleId: circle.id });
        }}>
        <GroupAvatar name={circle.name} photoUrl={circle.photoUrl} />
        <span className={styles.rowText}><strong>{circle.name}</strong><span>{circle.memberCount} {circle.memberCount === 1 ? "member" : "members"}</span></span>
        <MessageCircle aria-hidden="true" className="size-4" />
      </button>)}
    </aside>
    <section className={styles.thread} data-thread-open={Boolean(selected) || undefined} aria-label={selected ? `${selected.name} messages` : "Circle messages"}>
      {selected && session ? <>
        <header className={styles.threadHeader}>
          <button type="button" className={styles.back} aria-label="Back to circles" onClick={closeThread}><ArrowLeft aria-hidden="true" className="size-5" /></button>
          <GroupAvatar name={selected.name} photoUrl={selected.photoUrl} />
          <span className={styles.rowText}><strong>{selected.name}</strong><span>{selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}</span></span>
        </header>
        <CircleChat key={`${session.userId}:${session.circleId}:${session.vaultOwnerToken}`} session={session} circleName={selected.name} initialOpen active={active} collapsible={false} chatLane chatLaneTheme={theme} />
      </> : <div className={styles.placeholder}><UsersRound aria-hidden="true" className="size-8" /><p>Select a circle to start chatting.</p></div>}
    </section>
  </div>;
}
