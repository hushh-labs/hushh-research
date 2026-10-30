"use client";

import { Trash2 } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";
import type { HistoryEntryWithVersion } from "./columns";
import styles from "@/components/kai/shared/finance-workspace.module.css";

export function VersionOptions({ entries, onOpen, onDelete, onDeleteAll }: {
  entries: HistoryEntryWithVersion[];
  onOpen: (entry: HistoryEntryWithVersion) => void;
  onDelete: (entry: HistoryEntryWithVersion) => void;
  onDeleteAll?: () => void;
}) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">No saved versions found.</p>;
  return <div className={styles.detail}>
    {entries.map(entry => {
      const raw = entry.raw_card as Record<string, unknown> | undefined;
      const owns = typeof raw?.owns_position === "boolean" ? raw.owns_position : typeof raw?.is_position_owned === "boolean" ? raw.is_position_owned : null;
      const decision = toInvestorDecisionLabel(entry.decision, owns);
      const time = Date.parse(entry.timestamp);
      const date = Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
      const confidence = Number.isFinite(entry.confidence) ? `${Math.round(entry.confidence > 1 ? entry.confidence : entry.confidence * 100)}% confidence` : "Confidence unavailable";
      return <div key={`${entry.ticker}-${entry.timestamp}`} className={styles.historyRow}>
        <button type="button" className={styles.historyPrimary} onClick={() => onOpen(entry)} aria-label={`Open version ${entry.version}`}>
          <span className="text-sm font-medium">Version {entry.version} · {decision.label}</span>
          <span className={styles.description}>{date} · {confidence}</span>
          {raw?.analysis_degraded ? <span className={styles.description}>Limited analysis</span> : null}
        </button>
        <ShellActionSurface variant="icon" onClick={() => onDelete(entry)} title="Delete this version" aria-label="Delete this version" className="text-destructive"><Trash2 className="h-4 w-4" /></ShellActionSurface>
      </div>;
    })}
    {onDeleteAll ? <div className="pt-4"><ShellActionSurface variant="pill" className="text-destructive" onClick={onDeleteAll}>Delete all versions</ShellActionSurface></div> : null}
  </div>;
}
