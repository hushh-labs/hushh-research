import type { CalendarPermission } from "@/lib/calendar/calendar-permissions";

export function CalendarPermissionList({ permissions }: { permissions: readonly CalendarPermission[] }) {
  return (
    <dl role="group" className="divide-y rounded-lg border border-border px-3 text-sm" aria-label="Calendar permissions">
      {permissions.map(permission => (
        <div key={permission.id} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
          <dt>{permission.label}</dt>
          <dd className="text-muted-foreground">{permission.status}</dd>
        </div>
      ))}
    </dl>
  );
}
