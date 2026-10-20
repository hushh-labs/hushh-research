"use client";

import { TaskSurfaceHeader, TaskSurfaceToolbar, TaskSurfaceBody, TaskSurfaceFooter, useTaskSurfacePresentation, taskSurfaceStyles } from "@/lib/morphy-ux/ui/task-surfaces";
import { SheetSearch } from "@/components/app-ui/sheet-parts";
import { connectPersonName } from "@/lib/connections/person-label";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyStateCard } from "@/components/one-location/redesign/contact-picker/atoms";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import { PersonSearchInput } from "@/components/one-location/redesign/selectors";
import { circleInviteSelectionLimit } from "@/lib/one-location/circle-invite-contract";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleEligibleConnectionsPage,
} from "@/lib/one-location/types";
import { BLOCKED_CTA } from "./blocked-cta";
import { CirclePersonSelectionRow } from "./circle-person-selection-row";

export type CirclePeoplePageLoader = (
  circleId: string,
  options: { page: number; limit: number; query?: string },
) => Promise<OneLocationCircleEligibleConnectionsPage>;

/** Circle eligibility owns membership; SMS contributes only its shared picker UI. */
export type CreateCirclePeopleProps = {
  circleId: string;
  circleName: string;
  active: boolean;
  onLoad: CirclePeoplePageLoader;
  onAdd: (circleId: string, userIds: string[]) => Promise<unknown>;
  onComplete: (circleId: string) => void;
  onBack: () => void;
  onSavingChange: (saving: boolean) => void;
};
export function useCreateCirclePeopleModel({ circleId, active, onLoad, onAdd, onComplete, onSavingChange }: CreateCirclePeopleProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [people, setPeople] = useState<OneLocationCircleEligibleConnection[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [capacity, setCapacity] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const mountedRef = useRef(true);
  const current = useCallback(() => mountedRef.current, []);
  const mutationPending = useCallback(() => inFlight.current, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loaderRef = useRef(onLoad);
  useEffect(() => { loaderRef.current = onLoad; }, [onLoad]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { if (active) headingRef.current?.focus(); }, [active]);
  useEffect(() => {
    setQuery(""); setPage(1); setPeople([]); setSelected([]); setCapacity(0); setHasMore(false); setFailed(false);
  }, [circleId]);

  useEffect(() => {
    if (!circleId) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      void loaderRef.current(circleId, { page, limit: 50, query: query.trim() || undefined })
        .then((result) => {
          if (!active) return;
          setPeople((current) => page === 1 ? result.eligibleConnections : [
            ...new Map([...current, ...result.eligibleConnections].map((person) => [person.userId, person])).values(),
          ]);
          setCapacity(result.remainingCapacity);
          setHasMore(result.hasMore);
        })
        .catch(() => { if (active) setFailed(true); })
        .finally(() => { if (active) setLoading(false); });
    }, query ? 200 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [circleId, page, query, retry]);

  const limit = circleInviteSelectionLimit(capacity);
  const finish = async (addSelected: boolean) => {
    if (inFlight.current || (addSelected && (!selected.length || selected.length > limit))) return;
    inFlight.current = true;
    setSaving(true);
    onSavingChange(true);
    try {
      if (addSelected) await onAdd(circleId, selected);
      if (mountedRef.current) onComplete(circleId);
    } catch {
      if (!mountedRef.current) return;
      toast.error("Could not add those people. Try again or add people later.");
    } finally {
      inFlight.current = false;
      if (mountedRef.current) {
        setSaving(false);
        onSavingChange(false);
      }
    }
  };

  const changeQuery = (next: string) => {
    if (inFlight.current) return;
    setQuery(next); setPage(1); setPeople([]); setHasMore(false);
  };
  const add = (id: string) => {
    if (!inFlight.current && people.some(person => person.userId === id))
      setSelected(current => current.includes(id) || current.length >= limit ? current : [...current, id]);
  };
  const remove = (id: string) => { if (!inFlight.current) setSelected(current => current.filter(value => value !== id)); };
  return { query, page, people, selected, capacity, limit, hasMore, loading, failed, saving, headingRef, finish,
    changeQuery, add, remove, retry: () => setRetry(value => value + 1), more: () => { if (!inFlight.current && !loading && hasMore) setPage(value => value + 1); },
    current, mutationPending };
}
export type CreateCirclePeopleModel = ReturnType<
  typeof useCreateCirclePeopleModel
>;
export function CreateCirclePeopleStep(props: CreateCirclePeopleProps) {
  return (
    <CreateCirclePeopleBody
      {...props}
      model={useCreateCirclePeopleModel(props)}
    />
  );
}
export function CreateCirclePeopleBody({
  circleName,
  onBack,
  model,
}: CreateCirclePeopleProps & { model: CreateCirclePeopleModel }) {
  const {
    query,
    page,
    people,
    selected,
    limit,
    hasMore,
    loading,
    failed,
    saving,
    headingRef,
    finish,
    changeQuery,
    add,
    remove,
    retry,
    more,
  } = model;
  const inTaskSurface = useTaskSurfacePresentation();
  const Header = inTaskSurface ? TaskSurfaceHeader : "header";
  const Toolbar = inTaskSurface ? TaskSurfaceToolbar : "div";
  const Body = inTaskSurface ? TaskSurfaceBody : "div";
  const Footer = inTaskSurface ? TaskSurfaceFooter : "footer";
  return (
    <section
      data-profile-type-scale={inTaskSurface ? undefined : "circles"}
      className={inTaskSurface ? "contents" : "motion-step-enter flex min-h-0 flex-1 flex-col gap-3"}
      aria-labelledby="create-circle-people-heading"
    >
      <Header className={inTaskSurface ? undefined : "shrink-0 space-y-1 pr-6"}>
        <h2
          data-profile-role="dialog-title"
          id="create-circle-people-heading"
          tabIndex={-1}
          ref={headingRef}
          className="text-xl font-semibold outline-none"
        >
          Add people
        </h2>
        <p data-profile-role="description" className="text-[15px] text-muted-foreground">
          Step 2 of 2 · Choose people for {circleName}, or add them later.
        </p>
      </Header>
      <Toolbar className={inTaskSurface ? undefined : "contents"}>
      {inTaskSurface ? <SheetSearch value={query} onValueChange={changeQuery} placeholder="Search people" /> : (      <PersonSearchInput
        value={query}
        onChange={changeQuery}
        placeholder="Search people"
      />) }
      <p data-profile-role="description" role="status" className="shrink-0 text-sm text-muted-foreground">
        {selected.length} selected
        {limit > 0
          ? ` · Choose up to ${limit} people`
          : !loading && !failed
            ? " · This Circle is full"
            : ""}
      </p>
      </Toolbar>
      <Body className={inTaskSurface ? undefined : "contents"}>
      {loading && page === 1 ? (
        <p data-profile-role="description"
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          Loading contacts…
        </p>
      ) : failed ? (
        <div className="space-y-2">
          <EmptyStateCard message="Could not load your contacts." />
          <Button type="button" variant="ghost" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : people.length ? (
        <VirtualContactList
          items={people}
          getKey={(person) => person.userId}
          ariaLabel="Contacts to add"
          presentation="cards"
          scrollClassName="min-h-0 max-h-[min(40dvh,360px)] flex-1 overflow-y-auto overscroll-contain divide-y divide-[color:var(--app-separator)]"
          itemClassName="border-b border-[color:var(--app-separator)] last:border-b-0"
          renderItem={(person) => {
            const checked = selected.includes(person.userId);
            return (
              <CirclePersonSelectionRow
                person={person}
                selected={checked}
                disabled={saving || (!checked && selected.length >= limit)}
                ariaLabel={`${checked ? "Remove" : "Add"} ${connectPersonName(person)}`}
                onToggle={() =>
                  checked ? remove(person.userId) : add(person.userId)
                }
              />
            );
          }}
        />
      ) : (
        <EmptyStateCard
          message={
            query.trim()
              ? "No contacts match that name."
              : "No connections to add yet. You can add people later."
          }
        />
      )}
      {hasMore && !failed ? (
        <Button
          type="button"
          variant="ghost"
          disabled={loading || saving}
          onClick={more}
        >
          {loading ? "Loading…" : "Load more contacts"}
        </Button>
      ) : null}
      </Body>
      <Footer className={inTaskSurface ? taskSurfaceStyles.createPeopleFooter : "flex shrink-0 flex-col gap-1 pt-2"}>
        <Button
          type="button"
          size="prominent"
          className={`${inTaskSurface ? "w-auto" : "w-full"} rounded-full ${BLOCKED_CTA}`}
          disabled={
            saving || loading || !selected.length || selected.length > limit
          }
          isLoading={saving}
          onClick={() => void finish(true)}
        >
          Add {selected.length || "people"}
          {selected.length === 1
            ? " person"
            : selected.length > 1
              ? " people"
              : ""}
        </Button>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={onBack}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => void finish(false)}
          >
            Add people later
          </Button>
        </div>
      </Footer>
    </section>
  );
}
