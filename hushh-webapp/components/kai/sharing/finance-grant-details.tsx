"use client";
import type { FinanceGrant } from "@/lib/finance-sharing/contract";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { financePublicationState } from "@/lib/finance-sharing/publication-state";
import styles from "./finance-sharing.module.css";
const shortDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
const statusWord = (status: FinanceGrant["status"]) =>
  status === "stopped" ? "Stopped" : status === "expired" ? "Expired" : null;
export function FinanceGrantDetails({
  item,
  direction,
  owner,
  busy,
  hasPortfolio,
  setSelected,
  setStopping,
  updateAccess,
  showStatus = false,
}: {
  item: FinanceGrant;
  direction: "outgoing" | "received";
  owner?: string;
  busy: boolean;
  hasPortfolio: boolean;
  setSelected: (id: string) => void;
  setStopping: (grant: FinanceGrant) => void;
  updateAccess: (grant: FinanceGrant) => Promise<void>;
  /** Earlier shares carry their own state; the current one shows it beside the person. */
  showStatus?: boolean;
}) {
  const ends = item.expiresAt
    ? `Ends ${shortDate(item.expiresAt)}`
    : direction === "outgoing"
      ? "Ends when you stop"
      : "Ends when they stop";
  const detail = [
    showStatus ? (statusWord(item.status) ?? "Active") : null,
    item.policy.mode === "snapshot" ? "Snapshot" : "Real time",
    ends,
    shortDate(item.updatedAt),
    item.policy.showAmounts ? null : "Amounts hidden",
  ]
    .filter(Boolean)
    .join(" · ");
  const publication = owner ? financePublicationState(owner, item.id) : undefined;
  const actions =
    item.status === "active" ? (
      <div className={direction === "received" ? styles.grantActionsInline : styles.grantActions}>
        <ShellActionSurface variant="pill" onClick={() => setSelected(item.id)}>
          View
        </ShellActionSurface>
        {direction === "outgoing" ? (
          <>
            <ShellActionSurface
              variant="pill"
              disabled={busy || !hasPortfolio}
              onClick={() => void updateAccess(item)}
            >
              Update access
            </ShellActionSurface>
            <ShellActionSurface variant="pill" onClick={() => setStopping(item)}>
              Stop sharing
            </ShellActionSurface>
          </>
        ) : null}
      </div>
    ) : null;
  return (
    <section key={item.id} data-finance-grant={item.id} className="pt-2.5">
      <div className={styles.grantSummary}>
        <div className="min-w-0">
          <p className={styles.grantSections}>{item.policy.sections.join(", ")}</p>
          <p className={`${styles.caption} mt-0.5`}>{detail}</p>
        </div>
        {direction === "received" ? actions : null}
      </div>
      {direction === "outgoing" &&
      item.status === "active" &&
      item.policy.mode === "ongoing" &&
      (publication === "source_changed" || publication === "unavailable") ? (
        <div className="mt-1.5">
          <p className={styles.caption}>
            {publication === "source_changed"
              ? "Updates paused: the portfolio account/source roster changed. Review and share a new view."
              : "The latest update could not be published. No new information has been shared."}
          </p>
          {publication === "unavailable" ? (
            <ShellActionSurface
              variant="pill"
              onClick={() =>
                window.dispatchEvent(new Event("finance-sharing-changed"))
              }
            >
              Retry saved update
            </ShellActionSurface>
          ) : null}
        </div>
      ) : null}
      {direction === "outgoing" ? actions : null}
    </section>
  );
}
