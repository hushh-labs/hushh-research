"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, UserCircleIcon, UsersThreeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MainLocationTarget } from "@/lib/agent/main-chat-location";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleSummary, OneLocationRecipientPage } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

type PrivateMode = "share_live" | "share_pin";
export type PrivateLocationSelection = { mode: PrivateMode; targets: MainLocationTarget[] };
const normalized = (label: string) => label.normalize("NFKC").trim().toLocaleLowerCase();

export function LocationChatSharePicker({ token, ownerId, initialMode = "share_live", busy, error, suggestedPeople, suggestedCircles, onSelectionChange, onContinue, onBack }: {
  token: string;
  ownerId: string;
  initialMode?: PrivateMode;
  busy: boolean;
  error?: string;
  suggestedPeople?: string[];
  suggestedCircles?: string[];
  onSelectionChange?: (selection: PrivateLocationSelection) => void;
  onContinue: (mode: PrivateMode, targets: MainLocationTarget[]) => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<PrivateMode>(initialMode);
  const modeInputName = useId();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [directory, setDirectory] = useState<OneLocationRecipientPage | null>(null);
  const [circles, setCircles] = useState<OneLocationCircleSummary[] | null>(null);
  const [selected, setSelected] = useState<Record<string, MainLocationTarget>>({});
  const [loading, setLoading] = useState(true);
  const [failedDirectory, setFailedDirectory] = useState(false);
  const [failedCircles, setFailedCircles] = useState(false);
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [circlesRetry, setCirclesRetry] = useState(0);
  const [unresolvedPeople, setUnresolvedPeople] = useState<string[]>([]);
  const [unresolvedCircles, setUnresolvedCircles] = useState<string[]>([]);
  const edited = useRef(false);

  useEffect(() => {
    if (!suggestedPeople?.length) return;
    let current = true;
    const people = suggestedPeople.map(async (name) => {
      const requestedName = normalized(name);
      const { items, hasMore } = await OneLocationService.listRecipientsPage({ vaultOwnerToken: token, page: 1, limit: 40, query: name });
      const singleName = !/\s/u.test(requestedName);
      const matches = items.filter((item) => {
        if (item.userId === ownerId) return false;
        const displayName = normalized(item.displayName);
        return displayName === requestedName || (singleName && displayName.startsWith(`${requestedName} `));
      });
      const person = !hasMore && matches.length === 1 ? matches[0] : undefined;
      return person?.canReceiveLocation
        ? [`person:${person.userId}`, { label: person.displayName, personUserId: person.userId }] as const : null;
    });
    void Promise.allSettled(people).then((results) => {
      if (!current) return;
      setUnresolvedPeople(suggestedPeople.filter((_, index) => {
        const result = results[index];
        return result?.status !== "fulfilled" || !result.value;
      }));
      if (edited.current) return;
      const ready = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      if (ready.length) setSelected((previous) => ({ ...previous, ...Object.fromEntries(ready) }));
    });
    return () => { current = false; };
  }, [ownerId, suggestedPeople, token]);

  useEffect(() => {
    if (!circles || !suggestedCircles?.length) return;
    const unresolved: string[] = [];
    const ready = suggestedCircles.flatMap((name) => {
      const exact = circles.filter((circle) => normalized(circle.name) === normalized(name));
      const match = exact.length === 1 ? exact[0] : undefined;
      if (!match) unresolved.push(name);
      return match ? [[`circle:${match.id}`, { label: match.name, circleId: match.id }] as const] : [];
    });
    setUnresolvedCircles(unresolved);
    if (!edited.current && ready.length) setSelected((previous) => ({ ...previous, ...Object.fromEntries(ready) }));
  }, [circles, suggestedCircles]);

  useEffect(() => {
    onSelectionChange?.({ mode, targets: Object.values(selected) });
  }, [mode, onSelectionChange, selected]);

  useEffect(() => {
    let current = true;
    setFailedCircles(false);
    void OneLocationService.listCircles(token).then((rows) => {
      if (current) setCircles(rows.filter((circle) => !circle.isSystem));
    }, () => { if (current) setFailedCircles(true); });
    return () => { current = false; };
  }, [circlesRetry, token]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setFailedDirectory(false);
    const timer = window.setTimeout(() => {
      void OneLocationService.listRecipientsPage({ vaultOwnerToken: token, page, limit: 40, query }).then((result) => {
        if (!current) return;
        setDirectory((previous) => page === 1 ? result : {
          ...result, items: [...new Map([...(previous?.items ?? []), ...result.items].map((person) => [person.userId, person])).values()],
        });
      }, () => { if (current) setFailedDirectory(true); }).finally(() => {
        if (current) setLoading(false);
      });
    }, query ? 180 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [directoryRetry, page, query, token]);

  const selectedTargets = Object.values(selected);
  const people = directory?.items.filter((person) => person.userId !== ownerId) ?? [];
  const shownCircles = (circles ?? []).filter((circle) => circle.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const unresolvedNames = [...new Set([...unresolvedPeople, ...unresolvedCircles])]
    .filter((name) => !selectedTargets.some((target) => normalized(target.label) === normalized(name)));
  function search(value: string) {
    setQuery(value);
    setPage(1);
    if (value !== query) setDirectory(null);
  }
  function toggle(id: string, target: MainLocationTarget) {
    edited.current = true;
    setSelected((previous) => {
      const next = { ...previous };
      if (next[id]) delete next[id];
      else next[id] = target;
      return next;
    });
  }

  function audienceButton(id: string, target: MainLocationTarget, detail: string | undefined, disabled = false) {
    const checked = Boolean(selected[id]);
    const Icon = target.circleId ? UsersThreeIcon : UserCircleIcon;
    return <button key={id} type="button" aria-pressed={checked} disabled={busy || disabled}
      onClick={() => toggle(id, target)}
      className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-60",
        checked ? "bg-primary/10 text-foreground" : "hover:bg-muted/70")}>
      <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words">
        <span className="block font-medium">{target.label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {checked ? <CheckIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
    </button>;
  }

  return <section aria-label="Choose who can see your location" className="space-y-3 rounded-2xl border bg-card p-4 text-card-foreground">
    <div>
      <h3 className="text-base font-semibold">Share privately</h3>
      <p className="text-sm text-muted-foreground">Choose people or Circles, then review who can see your location.</p>
    </div>
    <fieldset disabled={busy} className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">Location type</legend>
      {([["share_live", "Live location"], ["share_pin", "Current pin"]] as const).map(([value, label]) => (
        <label key={value} className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm", mode === value && "border-primary/50 bg-primary/5")}>
          <input name={modeInputName} type="radio" className="accent-primary" checked={mode === value} onChange={() => setMode(value)} />
          {label}
        </label>
      ))}
    </fieldset>
    <Input type="search" value={query} aria-label="Search connections and Circles" placeholder="Search connections and Circles"
      onChange={(event) => search(event.target.value)} />
    {unresolvedNames.length ? <div className="flex flex-wrap gap-1.5" aria-label="Names to review">
      {unresolvedNames.map((name) => <Button key={name} type="button" size="sm" variant="outline"
        disabled={busy} onClick={() => search(name)}>Find {name}</Button>)}
    </div> : null}
    <div className="max-h-72 space-y-3 overflow-y-auto overscroll-contain">
      <section aria-label="Circles">
        <h4 className="px-2 text-xs font-semibold text-muted-foreground">Circles</h4>
        {shownCircles.map((circle) => audienceButton(`circle:${circle.id}`, { label: circle.name, circleId: circle.id }, undefined))}
        {!shownCircles.length && circles ? <p className="px-2 py-1 text-sm text-muted-foreground">No matching Circles.</p> : null}
        {failedCircles ? <Button variant="ghost" onClick={() => setCirclesRetry((count) => count + 1)}>Retry Circles</Button> : null}
      </section>
      <section aria-label="Connections" aria-busy={loading}>
        <h4 className="px-2 text-xs font-semibold text-muted-foreground">Connections</h4>
        {people.map((person) => audienceButton(`person:${person.userId}`, { label: person.displayName, personUserId: person.userId },
          person.canReceiveLocation ? person.maskedPhone ?? undefined : "Location setup needed", !person.canReceiveLocation))}
        {loading ? <p role="status" className="px-2 py-1 text-sm text-muted-foreground">Loading connections…</p> : null}
        {!loading && !failedDirectory && !people.length ? <p className="px-2 py-1 text-sm text-muted-foreground">No matching connections.</p> : null}
        {failedDirectory ? <Button variant="ghost" onClick={() => setDirectoryRetry((count) => count + 1)}>Retry connections</Button> : null}
        {directory?.hasMore && !failedDirectory ? <Button variant="ghost" disabled={loading} onClick={() => setPage(directory.page + 1)}>Show more connections</Button> : null}
      </section>
    </div>
    {selectedTargets.length ? <div className="flex flex-wrap gap-1.5" aria-label="Selected audience">
      {Object.entries(selected).map(([id, target]) => <Button key={id} type="button" size="sm" variant="outline"
        aria-label={`Remove ${target.label} from the audience`} disabled={busy} onClick={() => toggle(id, target)}>
        {target.label}<span aria-hidden="true">×</span>
      </Button>)}
    </div> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>Back</Button>
      <Button type="button" disabled={busy || !selectedTargets.length} onClick={() => onContinue(mode, selectedTargets)}>Continue</Button>
    </div>
  </section>;
}
