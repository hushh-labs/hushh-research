"use client";

import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/hooks/use-auth";
import { VaultContext } from "@/lib/vault/vault-context";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";
import { ROUTES } from "@/lib/navigation/routes";
import { CONNECT_CIRCLES_LIST_HREF, CONNECT_CIRCLE_ACTION_PARAM } from "@/lib/navigation/connect-routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { writeLastMessagesSelection } from "@/lib/direct-messages/last-selection";
import { CircleChat } from "./circle-chat";
import { AgentDockPortal } from "@/components/agent/agent-dock";
import { MessagesBackButton } from "@/components/direct-messages/messages-back-button";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ArrowLeft, MessageCircle, Pencil, Plus, RefreshCw, Search, UsersRound } from "@/components/icons";
import styles from "./circle-messages-pane.module.css";
import peopleStyles from "@/components/direct-messages/direct-messages-page.module.css";
import quietStyles from "@/components/direct-messages/messages-quiet-action.module.css";

function GroupAvatar({ photoUrl }: { photoUrl?: string | null }) {
  return <span className={styles.groupAvatar} aria-hidden="true">
    <span className={styles.groupAvatarFront}>{photoUrl ? <Image src={photoUrl} alt="" width={33} height={33} unoptimized /> : <UsersRound className="size-5" />}</span>
  </span>;
}

/** The Chat lane reuses the same Circle membership and encrypted thread as Connect. */
export function CircleMessagesPane({ active = true, initialCircleId = null, onThreadOpenChange, onCircleCountChange, laneSwitcher, headerActions, profileAction, theme = "light" }: {
  active?: boolean;
  initialCircleId?: string | null;
  onThreadOpenChange?: (open: boolean) => void;
  onCircleCountChange?: (count: number) => void;
  laneSwitcher?: ReactNode;
  headerActions?: ReactNode;
  profileAction?: ReactNode;
  theme?: "light" | "dark";
}) {
  const { userId } = useAuth();
  const vault = useContext(VaultContext);
  const token = vault?.vaultOwnerToken ?? null;
  const ownerId = userId;
  const [loaded, setLoaded] = useState<{ token: string; ownerId: string; circles: OneLocationCircleSummary[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialCircleId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);

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
    let requestVersion = 0;
    const refresh = async () => {
      const version = ++requestVersion;
      setLoading(true);
      try {
        // The directory also contains Trusted/SMS circles. Their private
        // roster contracts exclude group chat, even with active membership.
        const circles = (await OneLocationService.listCircles(token)).filter(
          (circle) => !circle.isSystem && !circle.systemKind,
        );
        if (!active || version !== requestVersion) return;
        setLoaded({ token, ownerId, circles });
        setError(false);
      } catch {
        if (active && version === requestVersion) setError(true);
      } finally {
        if (active && version === requestVersion) setLoading(false);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [token, ownerId, refreshRevision]);

  const circles = loaded?.token === token && loaded.ownerId === ownerId ? loaded.circles : [];
  useEffect(() => { onCircleCountChange?.(circles.length); }, [circles.length, onCircleCountChange]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCircles = circles.filter(circle => circle.name.toLocaleLowerCase().includes(normalizedSearch));
  const selected = circles.find((circle) => circle.id === selectedId) ?? null;
  const selectedCircleId = selected?.id ?? null;
  const vaultKey = vault?.vaultKey ?? null;
  // Keep the encrypted session stable while shell/header state rerenders.
  // A new object restarts chat initialization and its long-poll connection.
  const session = useMemo(() => selectedCircleId && ownerId && token && vaultKey ? {
    circleId: selectedCircleId,
    userId: ownerId,
    vaultOwnerToken: token,
    vaultKey,
  } : null, [selectedCircleId, ownerId, token, vaultKey]);
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
      <header className={`${peopleStyles.inboxHeader} ${styles.listHeader}`}>
        <div className={peopleStyles.inboxHeading}>
          <MessagesBackButton owner={ownerId} active={active} />
          <h1>Messages</h1>
        </div>
        <div className={peopleStyles.inboxHeaderActions}>
          {headerActions}
          <Link href={CONNECT_CIRCLES_LIST_HREF} className={peopleStyles.refreshButton} aria-label="Edit circles">
            <Pencil aria-hidden="true" className="size-5" />
          </Link>
          <Link href={`${CONNECT_CIRCLES_LIST_HREF}&${CONNECT_CIRCLE_ACTION_PARAM}=create-circle`}
            className={peopleStyles.refreshButton} aria-label="Create circle">
            <Plus aria-hidden="true" className="size-5" />
          </Link>
          <button type="button" className={peopleStyles.refreshButton} aria-label="Refresh circles"
            disabled={loading || !token || !ownerId} onClick={() => setRefreshRevision(current => current + 1)}>
            <RefreshCw aria-hidden="true" className={`size-4${loading ? " animate-spin motion-reduce:animate-none" : ""}`} />
          </button>
          {profileAction}
        </div>
      </header>
      <div className={peopleStyles.inboxSearch}>
        <label className={peopleStyles.inboxSearchField}>
          <Search className="size-4" aria-hidden="true" />
          <span className="sr-only">Search circles</span>
          <input className={styles.searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)}
            placeholder="Search circles" aria-label="Search circles" />
        </label>
      </div>
      {laneSwitcher}
      <div className={styles.rows}>
      {!token || !vault?.vaultKey ? <p className={styles.notice}>Unlock One to view your circles.</p> : null}
      {loading && !circles.length ? <p role="status" className={styles.notice}>Loading circles…</p> : null}
      {error ? <p role="alert" className={styles.notice}>Circles are unavailable. Return to this tab to retry.</p> : null}
      {!loading && !error && token && !circles.length ? <div className={styles.empty}>
        <UsersRound aria-hidden="true" className="size-7" />
        <p>No circles yet</p>
        <Link href={ROUTES.CONNECT} className={quietStyles.action}>Create a circle</Link>
      </div> : null}
      {normalizedSearch && circles.length > 0 && visibleCircles.length === 0 ? <div className={styles.empty}>
        <p>No matching circles</p><p>Try another name.</p>
      </div> : null}
      {visibleCircles.map((circle) => <button key={circle.id} type="button" className={styles.row}
        data-selected={selectedId === circle.id || undefined} onClick={() => {
          setSelectedId(circle.id);
          writeLastMessagesSelection(ownerId, { lane: "circles", circleId: circle.id });
        }}>
        <GroupAvatar photoUrl={circle.photoUrl} />
        <span className={styles.rowText}><strong>{circle.name}</strong><span>{circle.memberCount} {circle.memberCount === 1 ? "member" : "members"}</span></span>
        <MessageCircle aria-hidden="true" className="size-4" />
      </button>)}
      </div>
    </aside>
    <section className={styles.thread} data-thread-open={Boolean(selected) || undefined} aria-label={selected ? `${selected.name} messages` : "Circle messages"}>
      {selected && session ? <>
        <header className={peopleStyles.threadHeader}>
          <div className={peopleStyles.threadHeaderContent}>
          <ShellActionSurface className={`${styles.back} !size-11`} aria-label="Back to circles" onClick={closeThread}><ArrowLeft aria-hidden="true" className="size-5" /></ShellActionSurface>
          <div className={peopleStyles.threadIdentity}>
          <GroupAvatar photoUrl={selected.photoUrl} />
          <div className={peopleStyles.threadTitle}><h2>{selected.name}</h2><p>{selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}</p></div>
          </div>
          <div className={peopleStyles.threadHeaderActions}>{profileAction}</div>
          </div>
        </header>
        <CircleChat key={`${session.userId}:${session.circleId}:${session.vaultOwnerToken}`} session={session} circleName={selected.name} initialOpen active={active} collapsible={false} chatLane chatLaneTheme={theme} />
      </> : <div className={styles.placeholder}><UsersRound aria-hidden="true" className="size-8" /><p>Select a circle to start chatting.</p></div>}
    </section>
  </div>;
}
