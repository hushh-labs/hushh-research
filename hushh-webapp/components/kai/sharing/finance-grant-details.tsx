"use client";
import type { FinanceGrant } from "@/lib/finance-sharing/contract";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { financePublicationState } from "@/lib/finance-sharing/publication-state";
import styles from "./finance-sharing.module.css";
const accessDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export function FinanceGrantDetails({
  item,
  direction,
  owner,
  busy,
  hasPortfolio,
  setSelected,
  setStopping,
  updateAccess,
}: {
  item: FinanceGrant;
  direction: "outgoing" | "received";
  owner?: string;
  busy: boolean;
  hasPortfolio: boolean;
  setSelected: (id: string) => void;
  setStopping: (grant: FinanceGrant) => void;
  updateAccess: (grant: FinanceGrant) => Promise<void>;
}) {
  return (
    <section key={item.id} data-finance-grant={item.id} className="pt-4">
      <div className={styles.grantHeader}>
        <p className={styles.caption}>
          {item.policy.mode === "snapshot" ? "Snapshot" : "Real time"}
        </p>
        <span className={styles.chip}>
          {item.status === "stopped"
            ? "Stopped"
            : item.status === "expired"
              ? "Expired"
              : "Active"}
        </span>
      </div>
      <div className={styles.grantInfo}>
        <div>
          <p className="text-sm capitalize">
            {item.policy.sections.join(" · ")}
          </p>
          <p className={`${styles.caption} mt-2`}>
            Amounts {item.policy.showAmounts ? "included" : "hidden"} · Agent
            One review{" "}
            {item.policy.model_processing.allowed ? "allowed" : "off"}
          </p>
        </div>
        <dl className={styles.grantDates}>
          <div>
            <dt>Access ends</dt>
            <dd>
              {item.expiresAt
                ? accessDate(item.expiresAt)
                : direction === "outgoing"
                  ? "When you stop sharing"
                  : "When the owner stops sharing"}
            </dd>
          </div>
          <div>
            <dt>Last shared</dt>
            <dd>{accessDate(item.updatedAt)}</dd>
          </div>
        </dl>
      </div>
      {direction === "outgoing" &&
      item.status === "active" &&
      item.policy.mode === "ongoing" &&
      owner ? (
        <div className="mt-2">
          <p className={styles.caption}>
            {financePublicationState(owner, item.id) === "source_changed"
              ? "Updates paused: the portfolio account/source roster changed. Review and share a new view."
              : financePublicationState(owner, item.id) === "unavailable"
                ? "The latest update could not be published. No new information has been shared."
                : "Updates from approved saved information while One is open and unlocked."}
          </p>
          {financePublicationState(owner, item.id) === "unavailable" ? (
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
      {item.status === "active" ? (
        <div className={styles.grantActions}>
          <ShellActionSurface
            variant="pill"
            onClick={() => setSelected(item.id)}
          >
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
              <ShellActionSurface
                variant="pill"
                onClick={() => setStopping(item)}
              >
                Stop sharing
              </ShellActionSurface>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
