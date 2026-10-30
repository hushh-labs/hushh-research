"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { Button } from "@/lib/morphy-ux/morphy";
import { ReferralService, type LeaderboardPage } from "@/lib/services/referral-service";
import { ReferralRankingList, ReferralRankingRow } from "./referral-ranking-row";
import styles from "./referral-rankings.module.css";

const PAGE_SIZE = 10;

/** Cursor pages stay on one published snapshot throughout an active browse. */
export function useIndividualReferralRankings({ firstPage, user, onRefresh }: {
  firstPage: LeaderboardPage | null;
  user: User | null | undefined;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState<{ data: LeaderboardPage; cursor: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failedCursor, setFailedCursor] = useState<number | null>(null);
  const pending = useRef(false);
  const sequence = useRef(0);
  const data = page?.data ?? firstPage;
  const cursor = page?.cursor ?? 0;

  useEffect(() => () => { sequence.current += 1; }, []);

  const loadPage = async (afterRank: number) => {
    if (!user || !data || pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailedCursor(null);
    const request = ++sequence.current;
    try {
      const idToken = await user.getIdToken();
      if (request !== sequence.current) return;
      const next = await ReferralService.getLeaderboard({
        idToken, limit: PAGE_SIZE, afterRank, snapshotId: data.snapshot_id,
      });
      if (request !== sequence.current) return;
      if (data.snapshot_id && next.snapshot_id !== data.snapshot_id) {
        // Expired snapshots restart at the latest publication, never an empty page.
        setPage(null);
        onRefresh();
      } else if (next.entries.length === 0 && afterRank > cursor) {
        // Older backends expose a continuation for exact multiples of ten.
        setPage({ data: { ...data, next_after_rank: null }, cursor });
      } else {
        setPage({ data: next, cursor: afterRank });
      }
    } catch {
      if (request === sequence.current) setFailedCursor(afterRank);
    } finally {
      if (request === sequence.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const viewer = data?.viewer ?? data?.entries.find((entry) => entry.is_viewer);
  return { data, cursor, busy, failedCursor, viewer, loadPage,
    hasNewSnapshot: Boolean(page && firstPage?.snapshot_id && data?.snapshot_id !== firstPage.snapshot_id),
    latest: () => { if (!pending.current) { setPage(null); setFailedCursor(null); } } };
}
export type IndividualReferralRankingsModel = ReturnType<typeof useIndividualReferralRankings>;

export function IndividualReferralRankings(props: { firstPage: LeaderboardPage; user: User | null | undefined; onRefresh: () => void }) {
  return <IndividualReferralRankingsBody model={useIndividualReferralRankings(props)} user={props.user} />;
}
export function IndividualReferralRankingsBody({ model, user }: { model: IndividualReferralRankingsModel; user: User | null | undefined }) {
  const { data, cursor, busy, failedCursor, viewer, loadPage, hasNewSnapshot, latest } = model;
  if (!data) return null;
  return <div className={styles.pagedList} aria-busy={busy}>
    {data.entries.length ? <ReferralRankingList label="Individual standings">
      {data.entries.map((entry) => <ReferralRankingRow key={entry.rank} rank={entry.rank}
        name={entry.display_name ?? entry.handle}
        photoUrl={entry.photo_url ?? (entry.is_viewer && entry.display_name ? user?.photoURL : null)}
        score={entry.points} scoreLabel="coins" isViewer={entry.is_viewer} />)}
    </ReferralRankingList> : <p role="status" className={styles.empty}>{data.stale ? "Standings are unavailable." : "No entries yet."}</p>}
    {failedCursor !== null ? <p role="status" className={styles.pageError}>Could not load that page. <Button variant="muted" size="compact" onClick={() => void loadPage(failedCursor)}>Try again</Button></p> : null}
    {cursor > 0 || data.next_after_rank != null || viewer ? <nav aria-label="Individual ranking pages" className={styles.pagination}>
      {viewer && !data.entries.some((entry) => entry.is_viewer) ? <Button variant="muted" size="compact" disabled={busy} onClick={() => void loadPage(Math.floor((viewer.rank - 1) / PAGE_SIZE) * PAGE_SIZE)}>Your rank #{viewer.rank}</Button> : null}
      <span className={styles.pageNumber}>Page {Math.floor(cursor / PAGE_SIZE) + 1}</span>
      {hasNewSnapshot ? <Button variant="muted" size="compact" disabled={busy} onClick={latest}>Latest rankings</Button> : null}
      {cursor > 0 ? <Button variant="muted" size="compact" disabled={busy} onClick={() => void loadPage(Math.max(0, cursor - PAGE_SIZE))}>Previous</Button> : null}
      {data.next_after_rank != null ? <Button variant="muted" size="compact" disabled={busy} onClick={() => void loadPage(data.next_after_rank!)}>Next</Button> : null}
    </nav> : null}
  </div>;
}
