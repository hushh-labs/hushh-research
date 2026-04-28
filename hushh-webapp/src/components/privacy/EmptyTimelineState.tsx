export default function EmptyTimelineState() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      <h3 className="text-sm font-semibold text-slate-900">
        No consent events found
      </h3>
      <p className="mt-1 text-sm text-slate-500">
        Try changing the selected filter to view other permission events.
      </p>
    </div>
  );
}