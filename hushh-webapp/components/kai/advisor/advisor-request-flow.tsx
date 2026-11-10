"use client";

import { useState, useRef } from "react";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { usePathname } from "next/navigation";
import {
  captureAdvisorSnapshot,
  snapshotInformation,
} from "@/lib/advisor-review/snapshot";
import {
  AdvisorReviewService,
  AdvisorReviewError,
  type PreparedAdvisorReview,
} from "@/lib/advisor-review/service";
import type {
  AdvisorCandidate,
  AdvisorSnapshot,
} from "@/lib/advisor-review/contract";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { AdvisorDiscovery } from "./advisor-discovery";
import { AdvisorSnapshotView } from "./advisor-snapshot";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./advisor-review.module.css";

export function AdvisorRequestFlow({
  context,
  source,
  onClose,
  onSent,
}: {
  context: FinanceShareContext;
  source: FinanceSource;
  onClose: () => void;
  onSent: (id: string) => void;
}) {
  const [advisor, setAdvisor] = useState<AdvisorCandidate | null>(null);
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null);
  const [introduction, setIntroduction] = useState("");
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const pending = useRef<PreparedAdvisorReview | null>(null);
  const pathname = usePathname();
  useBackLayer(pathname, advisor ? 2 : 1, () => {
    if (!lock.current) {
      if (advisor && !pending.current) {
        setAdvisor(null);
        setSnapshot(null);
      } else onClose();
    }
    return true;
  });
  const choose = async (person: AdvisorCandidate) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await captureAdvisorSnapshot(context, source);
      if (context.isCurrent()) {
        setAdvisor(person);
        setSnapshot(value);
        setApproved(false);
      }
    } catch (e) {
      if (context.isCurrent())
        setError(
          e instanceof Error
            ? e.message
            : "The snapshot could not be prepared.",
        );
    } finally {
      lock.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  const send = async () => {
    if (lock.current || !advisor || !snapshot || !approved) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!pending.current) {
        const current = await captureAdvisorSnapshot(context, source);
        if (
          JSON.stringify(snapshotInformation(current)) !==
          JSON.stringify(snapshotInformation(snapshot))
        )
          throw new Error(
            "Your Finance source or preferences changed. Go back and review a fresh snapshot.",
          );
        pending.current = await AdvisorReviewService.prepare(
          context,
          advisor,
          snapshot,
          introduction.trim(),
        );
      }
      const result = await AdvisorReviewService.send(context, pending.current);
      if (context.isCurrent()) onSent(result.id);
    } catch (e) {
      if (context.isCurrent()) {
        if (
          e instanceof AdvisorReviewError &&
          e.status >= 400 &&
          e.status < 500 &&
          ![408, 429].includes(e.status)
        ) {
          pending.current = null;
          setApproved(false);
        }
        setError(
          e instanceof Error
            ? e.message
            : "The request was not confirmed. Retry to check the same request.",
        );
      }
    } finally {
      lock.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  return (
    <KaiControlSurface
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={advisor ? `Review request · ${advisor.name}` : "Find an advisor"}
      description={
        advisor
          ? "Review exactly what this advisor will receive."
          : "Choose a verified advisor for a second opinion."
      }
      surfaceClassName={finance.detail}
      desktopMaxWidthClassName="sm:!max-w-[min(1040px,calc(100vw-4.5rem))]"
    >
      {error ? (
        <p role="alert" className={styles.notice}>
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status">
          {pending.current
            ? "Checking the same request…"
            : "Preparing secure access…"}
        </p>
      ) : null}
      {advisor && snapshot ? (
        <div className={styles.columns}>
          <AdvisorSnapshotView snapshot={snapshot} />
          <div className={styles.stack}>
            <section className={styles.card}>
              <h3 className="ui-text-section-label">
                One request, two permissions
              </h3>
              <p>
                Accepting connects you with {advisor.name} and opens this fixed
                Finance snapshot for them.
              </p>
              <p className="ui-text-helper-text">
                The request and snapshot access expire 7 days after sending. The
                snapshot is locked until acceptance. No ongoing updates, Agent
                One processing or trading permission is granted.
              </p>
              <p className="ui-text-helper-text">
                Available holdings, values, balances, allocation, history and
                Finance preferences are included. Goals that have not been
                provided stay unavailable. Account numbers and unrelated
                documents are excluded.
              </p>
            </section>
            <label className={styles.field}>
              A short introduction (optional)
              <Textarea
                maxLength={600}
                value={introduction}
                onChange={(e) => setIntroduction(e.target.value)}
                disabled={busy || !!pending.current}
              />
            </label>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
                disabled={busy || !!pending.current}
              />
              <span>
                I approve this connection request and Finance snapshot.
              </span>
            </label>
            <div className={styles.actions}>
              <ShellActionSurface variant="pill" disabled={busy || !!pending.current} onClick={onClose}>
                Cancel
              </ShellActionSurface>
              <ShellActionSurface
                variant="pill"
                disabled={busy || !!pending.current}
                onClick={() => {
                  setAdvisor(null);
                  setSnapshot(null);
                }}
              >
                Back
              </ShellActionSurface>
              <ShellActionSurface
                variant="pill"
                className={styles.primary}
                disabled={busy || !approved}
                onClick={() => void send()}
              >
                {pending.current ? "Retry same request" : "Send request"}
              </ShellActionSurface>
            </div>
          </div>
        </div>
      ) : (
        <AdvisorDiscovery
          context={context}
          onChoose={(person) => void choose(person)}
        />
      )}
    </KaiControlSurface>
  );
}
