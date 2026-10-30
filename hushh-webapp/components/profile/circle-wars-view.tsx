import { ArrowRight, ArrowUpRight, Crown, Target, Timer, Trophy, UsersThreeIcon as Users } from "@/components/icons";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/morphy";
import { ReferralRankingList, ReferralRankingRow } from "@/components/referrals/referral-ranking-row";
import type { CircleWarsLeaderboard, CircleWarsState } from "@/lib/services/circle-wars-service";

import styles from "./circle-wars.module.css";

export function CircleWarsEmblem() {
  return <div className={styles.emblem} aria-hidden="true">
    <div className={styles.orbitOuter} /><div className={styles.orbitInner} />
    <div className={styles.emblemCore}><Users weight="duotone" /></div>
    <span className={`${styles.orbitNode} ${styles.crownNode}`}><Crown weight="duotone" /></span>
    <span className={`${styles.orbitNode} ${styles.targetNode}`}><Target weight="duotone" /></span>
    <span className={`${styles.orbitNode} ${styles.trophyNode}`}><Trophy weight="duotone" /></span>
    <span className={styles.orbitDot} />
  </div>;
}

function timeRemaining(seconds: number) {
  if (seconds <= 0) return "New round starting";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m left`;
  const hours = Math.floor(seconds / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left` : `${hours}h ${Math.floor(seconds / 60) % 60}m left`;
}

export function CircleWarsOverview({ data, view, secondsRemaining, movement, onJoin, onInvite, onViewRankings }: {
  data: CircleWarsState;
  view: "card" | "leaderboard";
  secondsRemaining: number;
  movement: string;
  onJoin: () => void;
  onInvite: () => void;
  onViewRankings: () => void;
}) {
  const team = data.participation?.team;
  const unavailable = Boolean(data.participation && !team);
  const activeCard = Boolean(team && view === "card");

  return <SurfaceCard className={`${styles.hero} !overflow-hidden`}>
    <div className={styles.heroTop}>
      <span role="timer" className={styles.countdown} aria-label={`${timeRemaining(secondsRemaining)} · ${data.period.timezone}`}><Timer aria-hidden="true" />{timeRemaining(secondsRemaining)}</span>
    </div>
    <div className={styles.heroBody}>
      <div className={styles.heroCopy}>
        {activeCard && team ? <>
          <p className={styles.rankLabel}><span className={styles.liveDot} />Your circle is in<span>·</span><span>Rank #{team.rank}</span></p>
          <h3 className={`ui-text-page-title ${styles.title}`}>{team.name}</h3>
          <p className={styles.support}>{team.participating_members} participating members</p>
          <p className={styles.teamScore}><strong>{team.qualified_referrals}</strong><span>qualified referrals<br />this week</span></p>
          <p aria-live="polite" className={styles.rankMovement}>{movement || (team.next_rank !== null
            ? `You're ${team.referrals_to_next_rank} referrals away from Rank #${team.next_rank}!`
            : "Your Circle leads this week. Keep growing together.")}</p>
        </> : <>
          <h2 className={`ui-text-page-title ${styles.title}`}>{unavailable ? "Your Circle is unavailable"
            : <>Circle Wars.<br /><span>Rise together.</span></>}</h2>
          {unavailable ? <p className={styles.support}>Your weekly selection is saved. Check your Circle membership to see its details.</p> : null}
        </>}
        <div className={styles.actions}>
          {!data.participation ? <Button size="compact" className={styles.joinButton} onClick={onJoin}>Join Circle Wars<ArrowUpRight className="ml-1 size-3" aria-hidden="true" /></Button> : team ? <Button size="compact" onClick={onInvite}>Invite Friends<ArrowUpRight className="ml-1 size-3" aria-hidden="true" /></Button> : null}
          {activeCard ? <Button size="compact" variant="muted" onClick={onViewRankings}>View Rankings<ArrowRight className="ml-2 size-4" aria-hidden="true" /></Button> : null}
        </div>
      </div>
      <CircleWarsEmblem />
    </div>
  </SurfaceCard>;
}

export function CircleWarsStandings({ board, refreshing, onPrevious, onNext }: {
  board: CircleWarsLeaderboard | null;
  data: CircleWarsState;
  refreshing: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return <div className={styles.standings}>
    <header className={styles.standingsHeader}>
      <h3 className="ui-text-section-title">Circle rankings</h3>
    </header>
    {board?.total_teams === 0 ? <p role="status" className={styles.emptyBoard}>No Circle rankings yet.</p> : null}
    {board && board.teams.length > 0 ? <ReferralRankingList label="Weekly Circle standings">
      {board.teams.map((entry) => <ReferralRankingRow key={entry.team_key} rank={entry.rank} name={entry.name}
        score={entry.qualified_referrals} scoreLabel="referrals"
        isViewer={entry.is_your_circle} kind="circle" description={`${entry.participating_members} participating members`} />)}
    </ReferralRankingList> : null}
    {(board?.offset ?? 0) > 0 || board?.has_more ? <footer className={styles.boardFooter}>
      <nav aria-label="Circle ranking pages" className={styles.pagination}>
        <span className={styles.pageNumber}>Page {Math.floor((board?.offset ?? 0) / (board?.limit || 10)) + 1}</span>
        {(board?.offset ?? 0) > 0 ? <Button variant="muted" disabled={refreshing} onClick={onPrevious}>Previous</Button> : null}
        {board?.has_more ? <Button variant="muted" disabled={refreshing} onClick={onNext}>Next</Button> : null}
      </nav>
    </footer> : null}
  </div>;
}
