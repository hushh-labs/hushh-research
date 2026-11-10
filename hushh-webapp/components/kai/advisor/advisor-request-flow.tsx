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
  const returnToDiscovery = () => {
    setAdvisor(null);
    setSnapshot(null);
    setError(null);
  };
  useBackLayer(pathname, advisor ? 2 : 1, () => {
    if (!lock.current) {
      if (advisor && !pending.current) returnToDiscovery();
      else onClose();
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
      title={advisor ? "Review request" : "Find an advisor"}
      description={advisor?.name}
      presentation="sheet"
      surfaceClassName={`${finance.detail} ${styles.handshakeSheet}`}
      footer={advisor && snapshot ? (
        <div className={styles.handshakeFooter}>
          <ShellActionSurface variant="pill" disabled={busy || !!pending.current} onClick={returnToDiscovery}>
            Back
          </ShellActionSurface>
          <ShellActionSurface
            variant="pill"
            rippleEffect="fill"
            wrapperClassName={styles.handshakeForward}
            className={styles.handshakePrimary}
            disabled={busy || !approved}
            onClick={() => void send()}
          >
            {pending.current ? "Retry same request" : "Send request"}
          </ShellActionSurface>
        </div>
      ) : undefined}
    >
      <div
        className={`${styles.handshakeProgress} mb-4`}
        role="progressbar"
        aria-label="Advisor request progress"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={advisor ? 2 : 1}
        aria-valuetext={advisor ? "Step 2 of 2: Review request" : "Step 1 of 2: Choose an advisor"}
      >
        <span data-reached />
        <span data-reached={advisor ? true : undefined} />
      </div>
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
        <div className={styles.stack}>
          <div className="space-y-1">
            <h3 className="ui-text-section-label">What will the advisor see?</h3>
            <p>A copy of your available holdings, values, balances, allocation, history and investing preferences.</p>
          </div>
          <details>
            <summary className="ui-text-button-label min-h-11 cursor-pointer py-3">Preview shared portfolio</summary>
            <AdvisorSnapshotView snapshot={snapshot} />
          </details>
          <label className={styles.field}>
            Add a note (optional)
            <Textarea
              maxLength={600}
              value={introduction}
              onChange={(e) => setIntroduction(e.target.value)}
              disabled={busy || !!pending.current}
            />
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              disabled={busy || !!pending.current}
            />
            <span>I agree to connect and share this snapshot for 7 days.</span>
          </label>
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
