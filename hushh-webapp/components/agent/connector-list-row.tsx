import { useId, type ReactNode } from "react";
import { ChevronRightIcon } from "@/components/icons";
import type { ConnectorsPanelPresentation } from "./connectors-panel";

type ConnectorListEntry = ConnectorsPanelPresentation["catalog"]["groups"][number]["entries"][number];

export function ConnectorRow({ entry, leading, status, actionLabel, accessPurpose }: {
  entry: ConnectorListEntry; leading: ReactNode; status: string | undefined;
  actionLabel: ReactNode; accessPurpose?: string;
}) {
  const detailId = useId();
  return (
    <li
      data-connector-row={entry.id}
      aria-busy={entry.pending ? true : undefined}
      className="flex min-h-14 min-w-0 items-center gap-3 border-b border-foreground/10 px-4 last:border-b-0"
    >
      {leading}
      {entry.onOpen ? (
        <button
          type="button"
          aria-label={entry.name}
          aria-describedby={status || entry.accountDetail || entry.detail ? detailId : undefined}
          onClick={entry.onOpen}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-normal">{entry.name}</span>
            {accessPurpose ? <span className="block py-1 text-xs leading-5 text-muted-foreground">{accessPurpose}</span> : null}
            {status ? (
              <span id={detailId} role="status" className="block truncate text-xs text-muted-foreground">{status}</span>
            ) : entry.accountDetail ? (
              <span id={detailId} className="block truncate text-xs text-muted-foreground">{entry.accountDetail}</span>
            ) : entry.detail ? <span id={detailId} className="sr-only">{entry.detail}</span> : null}
          </span>
          {!entry.action ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        </button>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-normal">{entry.name}</span>
          {accessPurpose ? <span className="block py-1 text-xs leading-5 text-muted-foreground">{accessPurpose}</span> : null}
          {status ? (
            <span role="status" className="block truncate text-xs text-muted-foreground">{status}</span>
          ) : entry.accountDetail ? (
            <span className="block truncate text-xs text-muted-foreground">{entry.accountDetail}</span>
          ) : entry.detail ? <span className="sr-only">{entry.detail}</span> : null}
        </span>
      )}
      {entry.action ? (
        <button
          type="button"
          className={
            entry.connected
              ? "min-h-9 shrink-0 rounded-full border border-border bg-background/70 px-3.5 py-1.5 text-xs font-medium text-foreground transition-opacity active:enabled:opacity-[0.84] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              : "min-h-9 shrink-0 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-xs transition-opacity active:enabled:opacity-[0.84] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          }
          aria-label={entry.action.label}
          disabled={entry.action.disabled || Boolean(entry.pending)}
          onClick={entry.action.onClick}
        >
          {actionLabel}
        </button>
      ) : entry.trailingText ? (
        <span className="shrink-0 text-xs text-muted-foreground">{entry.trailingText}</span>
      ) : null}
    </li>
  );
}

