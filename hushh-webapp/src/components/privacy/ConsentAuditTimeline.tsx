"use client";

import { useMemo, useState } from "react";
import { consentEvents, type ConsentEventType } from "../../data/consentEvents";
import ConsentFilters from "./ConsentFilters";
import ConsentEventItem from "./ConsentEventItem";
import EmptyTimelineState from "./EmptyTimelineState";

type FilterType = "all" | ConsentEventType;

export default function ConsentAuditTimeline() {
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  const filteredEvents = useMemo(() => {
    if (activeFilter === "all") return consentEvents;
    return consentEvents.filter((event) => event.type === activeFilter);
  }, [activeFilter]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Privacy & Consent
          </p>
          <h2 className="mt-1 text-2xl font-bold text-slate-900">
            Consent Audit Timeline
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Track wallet permission history including granted, updated, revoked,
            and expired consent events.
          </p>
        </div>

        <div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
          {consentEvents.length} Events Logged
        </div>
      </div>

      <div className="mb-6">
        <ConsentFilters
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
      </div>

      {filteredEvents.length > 0 ? (
        <div className="space-y-5">
          {filteredEvents.map((event) => (
            <ConsentEventItem key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <EmptyTimelineState />
      )}
    </section>
  );
}