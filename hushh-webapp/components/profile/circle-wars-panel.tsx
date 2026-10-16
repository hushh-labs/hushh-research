"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { UsersThreeIcon as Users } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { CreateCircleFlow } from "@/components/one-location/redesign/circles/named-circle-flows";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleKind, OneLocationCircleSummary } from "@/lib/one-location/types";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { CircleWarsService, type CircleWarsLeaderboard, type CircleWarsState } from "@/lib/services/circle-wars-service";
import { VaultContext } from "@/lib/vault/vault-context";

function timeRemaining(seconds: number) {
  if (seconds <= 0) return "Starting a new week…";
  const hours = Math.floor(seconds / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${Math.floor(seconds / 60) % 60}m`;
}

type Props = {
  userId: string;
  view: "card" | "leaderboard";
  refreshKey: unknown;
  onInvite: () => void;
  onViewRankings: () => void;
};

export function CircleWarsPanel(props: Props) {
  const token = useContext(VaultContext)?.vaultOwnerToken ?? null;
  // Remount every account/lock boundary. No previous owner's private names or
  // in-flight requests survive sign-out, lock, or the next account's render.
  return token ? <CircleWarsContent key={`${props.userId}:unlocked`} {...props} token={token} /> : (
    <SettingsGroup title="Your circle">
      <SettingsRow icon={Users} title="Win with your circle" description="Open your vault to choose a Circle and join Circle Wars." />
      <a className="inline-flex min-h-11 items-center px-4 text-sm text-primary underline" href={ROUTES.CONNECT}>Open Circles</a>
    </SettingsGroup>
  );
}

function CircleWarsContent({ userId, view, refreshKey, onInvite, onViewRankings, token }: Props & { token: string }) {
  const [data, setData] = useState<CircleWarsState | null>(null);
  const [board, setBoard] = useState<CircleWarsLeaderboard | null>(null);
  const [error, setError] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [circles, setCircles] = useState<OneLocationCircleSummary[] | null>(null);
  const [circlesError, setCirclesError] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const actionBusy = useRef(false);
  const pickerSequence = useRef(0);
  const committedOffset = useRef(0);
  const previousPeriod = useRef<string | null>(null);
  const previousRank = useRef<{ week: string; rank: number } | null>(null);
  const [movement, setMovement] = useState("");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now()-started)/1000)), 1000);
    return () => window.clearInterval(timer);
  }, [data]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setRefreshing(true);
    try {
      let next = await CircleWarsService.getState(token);
      const requestedOffset = previousPeriod.current && previousPeriod.current !== next.period.round_id ? 0 : offset;
      let standings = view === "leaderboard" ? await CircleWarsService.getLeaderboard(token, requestedOffset) : null;
      if (standings && standings.period.round_id !== next.period.round_id) {
        next = await CircleWarsService.getState(token);
        standings = await CircleWarsService.getLeaderboard(token, 0);
      }
      if (standings && standings.offset > 0 && standings.teams.length === 0) {
        standings = await CircleWarsService.getLeaderboard(token, 0);
      }
      if (standings && standings.period.round_id !== next.period.round_id) throw new Error("Circle Wars period changed during refresh");
      if (!alive.current || request !== sequence.current) return;
      const team = next.participation?.team;
      const previous = previousRank.current;
      if (team && previous && previous.week === next.period.round_id && previous.rank !== team.rank) {
        setMovement(team.rank < previous.rank ? `Your Circle moved up to Rank #${team.rank}!` : "Another Circle just passed your team.");
      } else {
        setMovement("");
      }
      previousRank.current = team ? { week: next.period.round_id, rank: team.rank } : null;
      setData(next);
      previousPeriod.current = next.period.round_id;
      setBoard(standings);
      if (standings) {
        committedOffset.current = standings.offset;
        setOffset(standings.offset);
      }
      setError(false);
    } catch (cause) {
      if (alive.current && request === sequence.current) {
        setError(true);
        setOffset(committedOffset.current);
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
          setData(null);
          setBoard(null);
          setCircles(null);
          setSelected("");
          setOpen(false);
          pickerSequence.current += 1;
        }
      }
    } finally {
      if (alive.current && request === sequence.current) setRefreshing(false);
    }
  }, [token, view, offset]);

  useEffect(() => {
    void load();
    // Refresh even with an open referral stream: other teams and the weekly
    // cutoff can change without this owner earning a referral.
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      sequence.current += 1;
    };
  }, [load, refreshKey]);

  const loadCircles = useCallback(async () => {
    const request = ++pickerSequence.current;
    setCirclesError(false);
    try {
      const next = await OneLocationService.listCircles(token);
      if (alive.current && request === pickerSequence.current) setCircles(next);
    } catch {
      if (alive.current && request === pickerSequence.current) setCirclesError(true);
    }
  }, [token]);

  const backToCircles = useCallback(() => {
    setCreating(false);
    if (circles === null || circlesError) void loadCircles();
  }, [circles, circlesError, loadCircles]);
  const closePicker = useCallback(() => {
    if (busy) return true;
    if (creating) backToCircles(); else setOpen(false);
    return true;
  }, [busy, creating, backToCircles]);
  useBackLayer(ROUTES.ONE_REFERRALS, open ? (creating ? 3 : 2) : 0, closePicker);

  const chooseCircle = () => {
    setOpen(true);
    setCreating(false);
    setSelected("");
    setCircles(null);
    void loadCircles();
  };

  const create = async (name: string, kind: OneLocationCircleKind) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    pickerSequence.current += 1;
    setBusy(true);
    try {
      const circle = await OneLocationService.createNamedCircle({ vaultOwnerToken: token, name, kind });
      CacheSyncService.onOneLocationStateMutated(userId, ["workspace", "circles", "sms_roster"], {
        notificationType: "location_circle_created", circleId: circle.id,
      });
      if (!alive.current) return;
      setCircles((current) => [...(current ?? []), circle]);
      setSelected(circle.id);
      setCreating(false);
      setCirclesError(false);
    } finally {
      actionBusy.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const join = async () => {
    if (!selected || actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    // Supersede a background request that began before this mutation.
    sequence.current += 1;
    try {
      const next = await CircleWarsService.optIn(token, selected);
      if (!alive.current) return;
      sequence.current += 1;
      setData(next);
      setOpen(false);
      morphyToast.success("You joined Circle Wars");
      await load();
    } catch (cause) {
      if (!alive.current) return;
      const code = apiErrorCode(cause);
      morphyToast.error(code === "CIRCLE_ALREADY_SELECTED_THIS_WEEK"
        ? "You already chose a Circle for this week."
        : code === "CIRCLE_MEMBERSHIP_REQUIRED" ? "Choose a Circle you currently belong to." : "Could not join. Please try again.");
      if (code === "CIRCLE_MEMBERSHIP_REQUIRED") {
        setSelected("");
        setCircles(null);
        void loadCircles();
      }
      // A retry after a lost response must recover the persisted selection.
      void load();
    } finally {
      actionBusy.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const team = data?.participation?.team;
  const joinButton = <Button onClick={chooseCircle}>Join Circle Wars</Button>;
  const errorState = error ? <div role="status" className="space-y-2 text-sm">
    <p>Circle Wars could not refresh. {data ? "Showing the last update." : "Please try again."}</p>
    <Button variant="muted" onClick={() => void load()}>Try again</Button>
  </div> : null;

  return <section aria-label="Circle Wars" className="space-y-4">
    {errorState}
    {!data && !error ? <p role="status" aria-busy="true">Loading Circle Wars…</p> : null}
    {data ? <>
      {view === "card" ? <SettingsGroup title="Your circle">
        {team ? <div className="space-y-3 p-4">
          <p className="text-sm font-semibold text-primary">Rank #{team.rank}</p>
          <h3 className="text-lg font-semibold">{team.name}</h3>
          <p className="text-sm text-muted-foreground">{team.participating_members} participating members</p>
          <p><strong>{team.qualified_referrals}</strong> qualified referrals this week</p>
          <p aria-live="polite" className="text-sm">{movement || (team.next_rank !== null
            ? `You're ${team.referrals_to_next_rank} referrals away from Rank #${team.next_rank}!`
            : "Your Circle leads this week. Keep growing together.")}</p>
          <p className="text-sm text-muted-foreground">Ends in {timeRemaining(Math.max(0, data.period.seconds_remaining - elapsed))} · {data.period.timezone}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onInvite}>Invite Friends</Button>
            <Button variant="muted" onClick={onViewRankings}>View Rankings</Button>
          </div>
        </div> : <div className="space-y-3 p-4">
          <h3 className="font-semibold">{data.participation ? "Your Circle is unavailable" : "Win with your circle"}</h3>
          <p className="text-sm text-muted-foreground">{data.participation
            ? "Your weekly selection is saved. Check your Circle membership to see its details."
            : "Team up with friends, earn referrals, and climb the weekly leaderboard."}</p>
          {!data.participation ? joinButton : null}
        </div>}
      </SettingsGroup> : <div className="space-y-4">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">Circle Wars</h2>
          <p className="text-sm text-muted-foreground">Compete together. Grow together.</p>
          <p className="text-sm">This week ends in: {timeRemaining(Math.max(0, data.period.seconds_remaining - elapsed))}</p>
          <p className="text-xs text-muted-foreground">Week of {data.period.week_start} · {data.period.timezone}</p>
        </header>
        {!data.participation ? joinButton : null}
        {board?.total_teams === 0 ? <p>No participating Circles yet. Choose your Circle to start this week.</p> : null}
        <ol aria-label="Weekly Circle standings" className="space-y-2">
          {board?.teams.map((entry) => <li key={entry.team_key} className={`rounded-2xl border p-4 ${entry.is_your_circle ? "border-primary bg-primary/5" : "border-border"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="break-words font-semibold">#{entry.rank} {entry.name}{entry.is_your_circle ? " (Your Circle)" : ""}</p>
                <p className="text-sm text-muted-foreground">{entry.participating_members} participating members</p></div>
              <p className="shrink-0 text-right"><strong>{entry.qualified_referrals}</strong><span className="block text-xs text-muted-foreground">referrals</span></p>
            </div>
            <Progress className="mt-3" value={entry.relative_progress * 100} aria-label={`${entry.name} relative score`} />
          </li>)}
        </ol>
        <div className="flex gap-2">
          {(board?.offset ?? 0) > 0 ? <Button variant="muted" disabled={refreshing} onClick={() => setOffset(Math.max(0, committedOffset.current - 25))}>Previous</Button> : null}
          {board?.has_more ? <Button variant="muted" disabled={refreshing} onClick={() => setOffset(committedOffset.current + 25)}>Next</Button> : null}
        </div>
      </div>}
    </> : null}
    <Dialog modal open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" onEscapeKeyDown={(event) => {
        if (busy || creating) {
          event.preventDefault();
          closePicker();
        }
      }}>
        <DialogHeader><DialogTitle>{creating ? "Create a Circle" : "Choose your Circle"}</DialogTitle>
          <DialogDescription>Select a Circle to compete with, or create a new one.</DialogDescription></DialogHeader>
        {creating ? <><CreateCircleFlow busy={busy} onSubmit={create} /><Button variant="muted" disabled={busy} onClick={backToCircles}>Back to Circles</Button></> : <div className="space-y-4">
          {circlesError ? <div role="status"><p>Could not load your Circles.</p><Button variant="muted" onClick={() => void loadCircles()}>Try loading Circles again</Button></div>
            : circles === null ? <p role="status">Loading your Circles…</p>
              : circles.length === 0 ? <p>You have no Circles yet. Create a Circle to compete with friends.</p> : <fieldset className="space-y-2"><legend className="sr-only">Select an existing Circle</legend>
                {circles.map((circle) => <label key={circle.id} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border p-3">
                  <input type="radio" name="circle-wars-circle" value={circle.id} checked={selected === circle.id} onChange={() => setSelected(circle.id)} disabled={busy} />
                  <Users aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0 break-words"><span className="block font-medium">{circle.name}</span><span className="text-sm text-muted-foreground">{circle.memberCount} members</span></span>
                </label>)}
              </fieldset>}
          <Button variant="muted" onClick={() => setCreating(true)} disabled={busy}>Create New Circle</Button>
          <p className="text-sm text-muted-foreground">By joining, you choose one Circle for this week. Only your new qualified referrals after joining count. Your friends join separately.</p>
          <Button disabled={!selected || busy} onClick={() => void join()}>{busy ? "Joining…" : "Join with this Circle"}</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </section>;
}
