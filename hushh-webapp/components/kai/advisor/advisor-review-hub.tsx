"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import { AdvisorWorkspace } from "./advisor-workspace";
import { AdvisorRequestFlow } from "./advisor-request-flow";
import { PortfolioAgentReview } from "./portfolio-agent-review";
import styles from "./advisor-review.module.css";

export function AdvisorReviewHub({
  source,
  advisor = false,
}: {
  source?: FinanceSource;
  advisor?: boolean;
}) {
  const { capture, ready, session } = useFinanceShareContext();
  const [generation, setGeneration] = useState(0);
  const [creating, setCreating] = useState(false);
  const { context, workspaceKey } = useMemo(
    () => ({
      context: ready ? capture() : null,
      workspaceKey: `${session}:${generation}`,
    }),
    [capture, ready, session, generation],
  );
  const [state, setState] = useState<{
    context: typeof context;
    items: AdvisorReview[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get("advisorReview");
  const id = requested && /^[a-f0-9-]{36}$/i.test(requested) ? requested : null;
  const select = (value: string | null) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set("advisorReview", value);
    else next.delete("advisorReview");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  };
  useBackLayer(pathname, id ? 1 : 0, () => {
    select(null);
    return true;
  });
  useEffect(() => {
    const visibility = () => {
      setState(null);
      setCreating(false);
      setGeneration((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!context) return;
    let disposed = false;
    void AdvisorReviewService.history(context)
      .then((result) => {
        if (!disposed && context.isCurrent()) {
          setState({ context, items: result.items });
          setError(null);
        }
      })
      .catch((e) => {
        if (!disposed && context.isCurrent())
          setError(
            e instanceof Error ? e.message : "Requests could not be checked.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [context, id, creating]);
  const items =
    state?.context === context
      ? state.items.filter((row) =>
          advisor ? row.direction === "received" : row.direction === "outgoing",
        )
      : [];
  return (
    <section
      className={styles.stack}
      aria-label={advisor ? "Advisor review requests" : "Human advisor review"}
    >
      {context && source ? (
        <PortfolioAgentReview
          key={workspaceKey}
          context={context}
          source={source}
        />
      ) : null}
      <div className={styles.card}>
        <div className={styles.row}>
          <div>
            <h2 className="ui-text-section-label">
              {advisor ? "Review requests" : "A human second opinion"}
            </h2>
            <p className="ui-text-helper-text">
              {advisor
                ? "Accept a request to connect and open its approved Finance snapshot."
                : "Choose a verified advisor, connect and arrange an introduction."}
            </p>
          </div>
          {source ? (
            <ShellActionSurface
              variant="pill"
              className={styles.primary}
              disabled={!context}
              onClick={() => setCreating(true)}
            >
              Find an advisor
            </ShellActionSurface>
          ) : null}
        </div>
        {!context ? (
          <p role="status">Unlock One to manage advisor requests.</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {context && !items.length && !error ? (
          <p className="ui-text-helper-text">
            {state?.context === context
              ? "No advisor requests yet."
              : "Checking requests…"}
          </p>
        ) : null}
        {items.map((row) => (
          <button
            type="button"
            key={row.id}
            className={styles.person}
            onClick={() => select(row.id)}
          >
            <span>
              <strong>{advisor ? row.ownerName : row.advisorName}</strong>
              <span className="block ui-text-helper-text">
                {row.status === "accepted"
                  ? "Connected · introduction and plan"
                  : row.status}
              </span>
            </span>
            <span className="ui-text-trailing-action">Open</span>
          </button>
        ))}
      </div>
      {context && creating && source ? (
        <AdvisorRequestFlow
          key={workspaceKey}
          context={context}
          source={source}
          onClose={() => setCreating(false)}
          onSent={(value) => {
            setCreating(false);
            select(value);
          }}
        />
      ) : null}
      {context && id && !creating ? (
        <AdvisorWorkspace
          key={`${id}:${workspaceKey}`}
          id={id}
          context={context}
          onClose={() => select(null)}
        />
      ) : null}
    </section>
  );
}
