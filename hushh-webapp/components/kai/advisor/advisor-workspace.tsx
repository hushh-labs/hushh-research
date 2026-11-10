"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { buildDirectMessageRoute } from "@/lib/navigation/routes";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import type {
  AdvisorReview,
  AdvisorSnapshot,
} from "@/lib/advisor-review/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { AdvisorSnapshotView } from "./advisor-snapshot";
import { AdvisorMeetingPanel } from "./advisor-meeting-panel";
import { AdvisorPlanPanel } from "./advisor-plan-panel";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./advisor-review.module.css";

export function AdvisorWorkspace({
  id,
  context,
  onClose,
}: {
  id: string;
  context: FinanceShareContext;
  onClose: () => void;
}) {
  const [review, setReview] = useState<AdvisorReview | null>(null);
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const work = useRef(false);
  const reading = useRef(false);
  const openedHash = useRef<string | null>(null);
  const deadline = useRef<number | null>(null);
  const pathname = usePathname();
  useBackLayer(pathname, 2, () => {
    if (!work.current) onClose();
    return true;
  });
  const load = async () => {
    if (reading.current || document.hidden || !context.isCurrent()) return;
    reading.current = true;
    try {
      const value = await AdvisorReviewService.view(context, id);
      if (!live.current || !context.isCurrent()) return;
      setReview(value);
      deadline.current =
        performance.now() +
        Math.max(0, Date.parse(value.expiresAt) - Date.parse(value.serverNow));
      if (value.snapshotAvailable && openedHash.current !== value.contentHash) {
        const opened = await AdvisorReviewService.decrypt(context, value);
        if (
          live.current &&
          context.isCurrent() &&
          performance.now() < deadline.current
        ) {
          openedHash.current = value.contentHash;
          setSnapshot(opened);
        }
      } else if (!value.snapshotAvailable) {
        openedHash.current = null;
        setSnapshot(null);
      }
    } catch (e) {
      if (live.current && context.isCurrent()) {
        openedHash.current = null;
        setSnapshot(null);
        setError(
          e instanceof Error ? e.message : "Access could not be checked.",
        );
      }
    } finally {
      reading.current = false;
    }
  };
  useEffect(() => {
    live.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (!work.current) void load();
    }, 5000);
    const visibility = () => {
      openedHash.current = null;
      setSnapshot(null);
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visibility);
    const expiry = window.setInterval(() => {
      if (deadline.current !== null && performance.now() >= deadline.current) {
        openedHash.current = null;
        setSnapshot(null);
      }
    }, 250);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(expiry);
      live.current = false;
      window.clearInterval(timer);
    };
    // A new unlocked context remounts this workspace and retires all plaintext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, id]);
  const run = async (action: () => Promise<unknown>) => {
    if (work.current || !context.isCurrent()) return;
    work.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (live.current && context.isCurrent()) await load();
    } catch (e) {
      if (live.current && context.isCurrent()) {
        setError(e instanceof Error ? e.message : "This step could not be confirmed.");
        await load();
      }
    } finally {
      work.current = false;
      if (live.current && context.isCurrent()) setBusy(false);
    }
  };
  const incoming = review?.direction === "received";
  return (
    <KaiControlSurface
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={
        review
          ? `${incoming ? review.ownerName : review.advisorName} · Advisor review`
          : "Advisor review"
      }
      description={
        review?.status === "pending"
          ? review.alreadyConnected
            ? "Already connected"
            : "One request to connect and review a Finance snapshot."
          : "Your introduction, meeting and plan."
      }
      surfaceClassName={finance.detail}
      desktopMaxWidthClassName="sm:!max-w-[min(1040px,calc(100vw-4.5rem))]"
    >
      {error ? (
        <div className={styles.notice}>
          <p role="alert">{error}</p>
          <ShellActionSurface
            variant="pill"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh status
          </ShellActionSurface>
        </div>
      ) : null}
      {review ? (
        <div className={styles.stack}>
          <div className={styles.row}>
            <strong className="ui-text-status">
              {review.status === "accepted" ? "Connected" : review.status}
            </strong>
            <span className="ui-text-helper-text">
              Snapshot access ends {new Date(review.expiresAt).toLocaleString()}
            </span>
          </div>
          {review.status === "pending" ? (
            <section className={styles.card}>
              <h3 className="ui-text-section-label">
                {incoming
                  ? "A Finance review request"
                  : "Waiting for the advisor"}
              </h3>
              <p>
                {review.introduction || "A portfolio introduction and review."}
              </p>
              <div className={styles.notice}>
                The full Finance snapshot is sealed.{" "}
                {incoming
                  ? review.alreadyConnected
                    ? "Accept to open the snapshot."
                    : "Accepting connects you and opens it."
                  : "Only this advisor can open it after accepting."}{" "}
                No subscription or payment is included.
              </div>
              <div className={styles.actions}>
                {incoming ? (
                  <>
                    <ShellActionSurface
                      variant="pill"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          AdvisorReviewService.decide(context, id, "decline"),
                        )
                      }
                    >
                      Decline
                    </ShellActionSurface>
                    <ShellActionSurface
                      variant="pill"
                      className={styles.primary}
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          AdvisorReviewService.decide(context, id, "accept", review.alreadyConnected),
                        )
                      }
                    >
                      {review.alreadyConnected ? "Accept" : "Accept & connect"}
                    </ShellActionSurface>
                  </>
                ) : (
                  <ShellActionSurface
                    variant="pill"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        AdvisorReviewService.decide(context, id, "withdraw"),
                      )
                    }
                  >
                    Withdraw request
                  </ShellActionSurface>
                )}
              </div>
            </section>
          ) : null}
          {review.status === "accepted" ? (
            <>
              <div className={styles.row}>
                <p className="ui-text-helper-text">
                  You’re connected. Message each other or arrange an
                  introduction.
                </p>
                <Link
                  className="ui-text-button-label"
                  href={buildDirectMessageRoute({
                    personRef: incoming
                      ? review.ownerPersonRef
                      : review.advisorPersonRef,
                  })}
                >
                  Open messages
                </Link>
              </div>
              <div className={styles.columns}>
                <div className={styles.stack}>
                  {snapshot ? (
                    <AdvisorSnapshotView snapshot={snapshot} />
                  ) : (
                    <div className={styles.notice}>
                      Snapshot access has ended or is unavailable. Your
                      connection and billing are managed separately.
                    </div>
                  )}
                </div>
                <div className={styles.stack}>
                  <AdvisorMeetingPanel
                    review={review}
                    context={context}
                    busy={busy}
                    run={run}
                  />
                  <AdvisorPlanPanel
                    key={review.planRevision}
                    review={review}
                    context={context}
                    busy={busy}
                    run={run}
                  />
                </div>
              </div>
              {!incoming ? (
                <details className={styles.card}>
                  <summary>Snapshot access</summary>
                  <p className="ui-text-helper-text">
                    Stopping snapshot access does not disconnect you or cancel a
                    subscription. Cancel billing separately before stopping if
                    you no longer want the service.
                  </p>
                  <ShellActionSurface
                    variant="pill"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        AdvisorReviewService.decide(context, id, "stop"),
                      )
                    }
                  >
                    Stop snapshot access
                  </ShellActionSurface>
                </details>
              ) : null}
            </>
          ) : null}
          {!["pending", "accepted"].includes(review.status) ? (
            <section className={styles.notice}>
              <p>
                This request is {review.status}. The snapshot cannot be opened.
              </p>
              <p>
                Any existing connection is unchanged. Billing can still be
                checked or cancelled below.
              </p>
              <AdvisorPlanPanel
                review={review}
                context={context}
                busy={busy}
                run={run}
              />
            </section>
          ) : null}
        </div>
      ) : (
        <p role="status">Checking this request…</p>
      )}
    </KaiControlSurface>
  );
}
