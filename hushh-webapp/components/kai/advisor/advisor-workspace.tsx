"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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

type ReviewPage = "meeting" | "portfolio" | "plan";

const pageTitles: Record<ReviewPage, string> = {
  meeting: "Meetings",
  portfolio: "Shared portfolio",
  plan: "Advisor plan",
};

const closedReviewTitles = {
  declined: "Request declined",
  withdrawn: "Request cancelled",
  stopped: "Portfolio sharing stopped",
  expired: "Request expired",
} as const;

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
  const [detail, setDetail] = useState<ReviewPage | null>(null);
  const [endAction, setEndAction] = useState<"withdraw" | "stop" | null>(null);
  const live = useRef(true);
  const work = useRef(false);
  const reading = useRef(false);
  const openedHash = useRef<string | null>(null);
  const deadline = useRef<number | null>(null);
  const accepted = review?.status === "accepted";
  const pending = review?.status === "pending";
  const page = accepted ? detail : !pending && review?.plan && detail === "plan" ? detail : null;
  const pageContent = useRef<HTMLDivElement>(null);
  const previousPage = useRef<ReviewPage | null>(null);
  useEffect(() => {
    if (page !== previousPage.current) {
      previousPage.current = page;
      pageContent.current?.focus();
    }
  }, [page]);
  const pathname = usePathname();
  const back = () => {
    if (work.current) return;
    if (page) setDetail(null);
    else onClose();
  };
  useBackLayer(pathname, page ? 3 : 2, () => {
    back();
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
  const person = incoming ? review?.ownerName : review?.advisorName;
  return (
    <KaiControlSurface
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={page ? pageTitles[page] : "Advisor review"}
      description={person}
      presentation="sheet"
      surfaceClassName={`${finance.detail} ${styles.handshakeSheet}`}
      footer={review && (page || pending || accepted) ? (
        <div className={styles.handshakeFooter}>
          {page ? (
            <ShellActionSurface variant="pill" disabled={busy} onClick={back}>Back</ShellActionSurface>
          ) : pending ? incoming ? (
            <>
              <ShellActionSurface variant="pill" disabled={busy} onClick={() => void run(() =>
                AdvisorReviewService.decide(context, id, "decline"),
              )}>Decline</ShellActionSurface>
              <ShellActionSurface
                variant="pill" rippleEffect="fill" disabled={busy}
                wrapperClassName={styles.handshakeForward} className={styles.handshakePrimary}
                onClick={() => void run(() => AdvisorReviewService.decide(context, id, "accept", review.alreadyConnected))}
              >{review.alreadyConnected ? "Accept" : "Accept & connect"}</ShellActionSurface>
            </>
          ) : (
            <ShellActionSurface variant="pill" disabled={busy} onClick={() => setEndAction("withdraw")}>
              Cancel request
            </ShellActionSurface>
          ) : (
            <ShellActionSurface
              variant="pill" rippleEffect="fill" disabled={busy}
              wrapperClassName={styles.handshakeForward} className={styles.handshakePrimary}
              onClick={() => setDetail("meeting")}
            >{review.meeting ? "View meeting" : "Choose a time"}</ShellActionSurface>
          )}
        </div>
      ) : undefined}
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
        <div ref={pageContent} tabIndex={-1} className={styles.stack}>
          {page === "meeting" ? (
            <AdvisorMeetingPanel review={review} context={context} busy={busy} run={run} />
          ) : page === "plan" ? (
            <AdvisorPlanPanel key={review.planRevision} review={review} context={context} busy={busy} run={run} />
          ) : page === "portfolio" ? (
            <>
              {review.snapshotAvailable ? (
                <p className="ui-text-helper-text">
                  Shared until {new Date(review.expiresAt).toLocaleString()}
                </p>
              ) : null}
              {review.snapshotAvailable && snapshot ? (
                <AdvisorSnapshotView snapshot={snapshot} />
              ) : (
                <p role="status">
                  {review.snapshotAvailable && !error ? "Opening the shared portfolio…" : "Portfolio details are unavailable."}
                </p>
              )}
            </>
          ) : review.status === "pending" ? (
            <>
              <h3 className="ui-text-section-label">{incoming ? "Review this request" : "Waiting for the advisor"}</h3>
              {review.introduction ? <p className="whitespace-pre-wrap break-words">{review.introduction}</p> : null}
              <p className="ui-text-helper-text">
                The portfolio snapshot stays sealed until the advisor accepts.
                {incoming && !review.alreadyConnected ? " Accepting also adds this person to your connections." : ""}
                {" "}There’s no charge for accepting.
              </p>
              <p className="ui-text-helper-text">Request expires {new Date(review.expiresAt).toLocaleDateString()}</p>
            </>
          ) : review.status === "accepted" ? (
            <>
              <h3 className="ui-text-section-label">Request accepted</h3>
              <SettingsGroup embedded separatorInset rowSizing="uniform">
                <SettingsRow title="Shared portfolio" chevron onClick={() => setDetail("portfolio")} />
                <SettingsRow title="Messages" asChild chevron>
                  <Link href={buildDirectMessageRoute({
                    personRef: incoming ? review.ownerPersonRef : review.advisorPersonRef,
                  })} />
                </SettingsRow>
                <SettingsRow title="Advisor plan" chevron onClick={() => setDetail("plan")} />
              </SettingsGroup>
              {!incoming ? (
                <SettingsGroup embedded rowSizing="uniform">
                  <SettingsRow
                    title={review.snapshotAvailable ? "Stop sharing portfolio" : "End advisor review"}
                    tone="destructive"
                    disabled={busy}
                    onClick={() => setEndAction("stop")}
                  />
                </SettingsGroup>
              ) : null}
            </>
          ) : (
            <>
              <h3 className="ui-text-section-label">{closedReviewTitles[review.status]}</h3>
              <p className="ui-text-helper-text">The advisor can’t open the portfolio.</p>
              {review.plan ? (
                <SettingsGroup embedded rowSizing="uniform">
                  <SettingsRow title="Plan and payments" chevron onClick={() => setDetail("plan")} />
                </SettingsGroup>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <p role="status">Checking this request…</p>
      )}
      <AlertDialog open={endAction !== null} onOpenChange={(open) => { if (!open) setEndAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{endAction === "stop" ? "Stop sharing your portfolio?" : "Cancel advisor request?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {endAction === "stop"
                ? "This ends the review and the advisor’s portfolio access. Existing meetings, subscriptions and your connection are managed separately."
                : "The advisor will no longer be able to accept this request or open your snapshot."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep {endAction === "stop" ? "review" : "request"}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => {
              if (endAction) void run(() => AdvisorReviewService.decide(context, id, endAction));
            }}>
              {endAction === "stop" ? "Stop sharing" : "Cancel request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </KaiControlSurface>
  );
}
