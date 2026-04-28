import type { ConsentEvent } from "../../data/consentEvents";

interface ConsentEventItemProps {
  event: ConsentEvent;
}

const statusStyles = {
  granted: "bg-emerald-100 text-emerald-700",
  updated: "bg-blue-100 text-blue-700",
  revoked: "bg-red-100 text-red-700",
  expired: "bg-amber-100 text-amber-700",
};

export default function ConsentEventItem({ event }: ConsentEventItemProps) {
  return (
    <div className="relative border-l border-slate-200 pl-6">
      <div className="absolute -left-2 top-1 h-4 w-4 rounded-full border-2 border-white bg-slate-900 shadow" />

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {event.permission}
            </h3>
            <p className="text-xs text-slate-500">{event.timestamp}</p>
          </div>

          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[event.type]}`}
          >
            {event.type.toUpperCase()}
          </span>
        </div>

        <p className="text-sm text-slate-600">{event.description}</p>

        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-3 py-1">
            Source: {event.source}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1">
            Actor: {event.actor}
          </span>
        </div>
      </div>
    </div>
  );
}