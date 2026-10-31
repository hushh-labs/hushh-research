"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { PlusIcon, ShieldCheck, Trophy, UsersThreeIcon as Users } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { CircleWarsOverview, CircleWarsStandings } from "./circle-wars-view";
import styles from "./circle-wars.module.css";
import { CreateCircleFlow } from "@/components/one-location/redesign/circles/named-circle-flows";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { unwindBackLayer, useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { circleWarsClock, circleWarsRemainingMs, type CircleWarsClock } from "@/lib/referral/circle-wars-clock";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleKind, OneLocationCircleSummary } from "@/lib/one-location/types";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { CircleWarsService, type CircleWarsLeaderboard, type CircleWarsState } from "@/lib/services/circle-wars-service";
import { VaultContext } from "@/lib/vault/vault-context";

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
  return token ? <CircleWarsContent key={`${props.userId}:unlocked`} {...props} token={token} /> : props.view === "leaderboard" ? (
    <p role="status" className="text-sm text-muted-foreground">Open your vault to see Circle rankings.</p>
  ) : (
    <SettingsGroup title="Your circle">
      <SettingsRow icon={Users} iconTone="capability" title="Win with your circle" description="Open your vault to choose a Circle and join Circle Wars." />
      <a className="inline-flex min-h-11 items-center px-4 text-sm text-primary underline" href={ROUTES.CONNECT}>Open Circles</a>
    </SettingsGroup>
  );
}

export function useCircleWarsModel({ userId, view, refreshKey, token }: Pick<Props, "userId" | "view" | "refreshKey"> & { token: string }) {
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
  const current = useCallback(() => alive.current, []);
  const mutationPending = useCallback(() => actionBusy.current, []);
  const pickerSequence = useRef(0);
  const committedOffset = useRef(0);
  const previousPeriod = useRef<string | null>(null);
  const previousRank = useRef<{ week: string; rank: number } | null>(null);
  const [movement, setMovement] = useState("");
  const [clock, setClock] = useState<CircleWarsClock | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const rolloverRequested = useRef<string | null>(null);
  useEffect(() => {
    if (!clock || view !== "card") return;
    const tick = () => setSecondsRemaining(Math.ceil(circleWarsRemainingMs(clock) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [clock, view]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setRefreshing(true);
    try {
      let next = await CircleWarsService.getState(token);
      let nextClock = circleWarsClock(next);
      const requestedOffset = previousPeriod.current && previousPeriod.current !== next.period.round_id ? 0 : offset;
      let standings = view === "leaderboard" ? await CircleWarsService.getLeaderboard(token, requestedOffset) : null;
      if (standings && standings.period.round_id !== next.period.round_id) {
        next = await CircleWarsService.getState(token);
        nextClock = circleWarsClock(next);
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
      setClock(nextClock);
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
          setClock(null);
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

  useEffect(() => {
    if (!clock || rolloverRequested.current === clock.roundId) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      // A stale/error response cannot start a tight loop at the deadline.
      rolloverRequested.current = clock.roundId;
      void load();
    }, circleWarsRemainingMs(clock));
    return () => window.clearTimeout(timer);
  }, [clock, load]);

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
    if (busy || actionBusy.current) return true;
    if (creating) backToCircles(); else setOpen(false);
    return true;
  }, [busy, creating, backToCircles]);
  useBackLayer(ROUTES.ONE_REFERRALS, open ? (creating ? 1 : 2) : 0, closePicker);

  const chooseCircle = () => {
    setOpen(true);
    setCreating(false);
    setSelected("");
    setCircles(null);
    void loadCircles();
  };

  const create = async (name: string, kind: OneLocationCircleKind, existingCircleId?: string) => {
    if (actionBusy.current) throw new Error("A Circle action is already running.");
    actionBusy.current = true;
    pickerSequence.current += 1;
    setBusy(true);
    try {
      const circle = existingCircleId
        ? await OneLocationService.updateNamedCircle({ vaultOwnerToken: token, circleId: existingCircleId, name, kind })
        : await OneLocationService.createNamedCircle({ vaultOwnerToken: token, name, kind });
      CacheSyncService.onOneLocationStateMutated(userId, ["workspace", "circles", "sms_roster"], {
        notificationType: existingCircleId ? "location_circle_renamed" : "location_circle_created", circleId: circle.id,
      });
      if (!alive.current) return circle;
      setCircles((current) => [...(current ?? []).filter((item) => item.id !== circle.id), circle]);
      setSelected(circle.id);
      setCirclesError(false);
      return circle;
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
      setClock(circleWarsClock(next));
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

  const loadPeople = (circleId: string, options: { page: number; limit: number; query?: string }) =>
    OneLocationService.listNamedCircleEligibleConnectionsPage({ vaultOwnerToken: token, circleId, ...options });
  const addPeople = async (circleId: string, userIds: string[]) => {
    if (actionBusy.current) throw new Error("A Circle action is already running.");
    actionBusy.current = true; setBusy(true);
    try {
      await OneLocationService.createNamedCircleMemberInvites({ vaultOwnerToken: token, circleId, inviteeUserIds: userIds });
      CacheSyncService.onOneLocationStateMutated(userId, ["workspace", "circles", "sms_roster"], { notificationType: "location_circle_member_added", circleId });
      await loadCircles();
    } finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  };
  return { data, board, error, offset, refreshing, open, creating, circles, circlesError, selected, busy, clock, secondsRemaining, movement,
    load, loadCircles, chooseCircle, closePicker, backToCircles, create, join, loadPeople, addPeople,
    current, mutationPending,
    changeOpen: (next: boolean) => { if (!actionBusy.current) setOpen(next); },
    select: (id: string) => { if (!actionBusy.current && circles?.some(circle => circle.id === id)) setSelected(id); },
    openCreate: () => { if (!actionBusy.current) setCreating(true); }, finishCreate: () => setCreating(false),
    previousPage: () => setOffset(Math.max(0, committedOffset.current - 10)), nextPage: () => setOffset(committedOffset.current + 10) };
}
export type CircleWarsModel = ReturnType<typeof useCircleWarsModel>;

/** Web and native retain one roster, enrollment and creation operation owner. */
function CircleWarsContent(props: Props & { token: string }) {
  const { token, ...view } = props;
  const model = useCircleWarsModel({ ...view, token });
  return <CircleWarsBody {...view} model={model} />;
}
export function CircleWarsBody({ userId, view, onInvite, onViewRankings, model }: Props & { model: CircleWarsModel }) {
  const { data, board, error, refreshing, open, creating, circles, circlesError, selected, busy, secondsRemaining, movement,
    load, loadCircles, chooseCircle, closePicker, backToCircles, create, join, loadPeople, addPeople, select, openCreate, finishCreate, previousPage, nextPage, changeOpen } = model;
  const errorState = error ? <div role="status" className="space-y-2 text-sm">
    <p>Circle Wars could not refresh. {data ? "Showing the last update." : "Please try again."}</p>
    <Button variant="muted" onClick={() => void load()}>Try again</Button>
  </div> : null;

  return <section aria-label="Circle Wars" className={styles.panel}>
    {errorState}
    {!data && !error ? <p role="status" aria-busy="true">Loading Circle Wars…</p> : null}
    {data ? <>
      {view === "card" ? <CircleWarsOverview data={data} view={view} secondsRemaining={secondsRemaining}
        movement={movement} onJoin={chooseCircle} onInvite={onInvite} onViewRankings={onViewRankings} />
        : <CircleWarsStandings board={board} data={data} refreshing={refreshing}
        onPrevious={previousPage} onNext={nextPage} />}
    </> : null}
    <Dialog modal open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" onEscapeKeyDown={(event) => {
        if (busy || creating) {
          event.preventDefault();
          if (!unwindBackLayer(ROUTES.ONE_REFERRALS)) closePicker();
        }
      }}>
        <DialogHeader className={styles.pickerIntro}>
          <span className={styles.pickerIcon}><Trophy weight="duotone" aria-hidden="true" /></span>
          <div><DialogTitle>{creating ? "Create a Circle" : "Choose your Circle"}</DialogTitle>
          <DialogDescription>A good team starts with your people.</DialogDescription></div>
        </DialogHeader>
        {creating ? <><CreateCircleFlow key={`${userId}:unlocked`} busy={busy} onSubmit={create}
          pathname={ROUTES.ONE_REFERRALS} backLayerQuery={{}}
          onLoadPeople={loadPeople}
          onAddPeople={addPeople}
          onComplete={finishCreate}
        /><Button variant="muted" disabled={busy} onClick={backToCircles}>Back to Circles</Button></> : <div className="space-y-4">
          {circlesError ? <div role="status"><p>Could not load your Circles.</p><Button variant="muted" onClick={() => void loadCircles()}>Try loading Circles again</Button></div>
            : circles === null ? <p role="status">Loading your Circles…</p>
              : circles.length === 0 ? <p className={styles.pickerEmpty}>You have no Circles yet. Create a Circle to compete with friends.</p> : <fieldset className={styles.choices}><legend className="sr-only">Select an existing Circle</legend>
                {circles.map((circle) => <label key={circle.id} className={styles.choice}>
                  <span className={styles.pickerIcon}><Users weight="duotone" aria-hidden="true" /></span>
                  <span className={styles.choiceCopy}><span className="ui-text-row-label-emphasized">{circle.name}</span><span>{circle.memberCount} members</span></span>
                  <input type="radio" name="circle-wars-circle" value={circle.id} checked={selected === circle.id} onChange={() => select(circle.id)} disabled={busy} />
                </label>)}
              </fieldset>}
          <Button variant="muted" className="w-full" onClick={openCreate} disabled={busy}><PlusIcon className="mr-2 size-4" aria-hidden="true" />Create New Circle</Button>
          <div className={styles.joinNote}><ShieldCheck aria-hidden="true" /><p>By joining, you choose one Circle for this week. Only your new qualified referrals after joining count. Your friends join separately.</p></div>
          <Button className="w-full" disabled={!selected || busy} onClick={() => void join()}>{busy ? "Joining…" : "Join with this Circle"}</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </section>;
}
