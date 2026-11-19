"use client";
import { useState } from "react";
import type { AdvisorSnapshot } from "@/lib/advisor-review/contract";
import styles from "./advisor-review.module.css";

const label = (text: string | null) =>
  text ? text.replaceAll("_", " ") : "Not provided";
const money = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(value);
export function AdvisorSnapshotView({
  snapshot,
}: {
  snapshot: AdvisorSnapshot;
}) {
  const [visible, setVisible] = useState(50);
  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-label="Finance snapshot">
        <div className={styles.row}>
          <h3 className="ui-text-section-label">Finance snapshot</h3>
          <span className="ui-text-caption">
            {new Date(snapshot.capturedAt).toLocaleDateString()}
          </span>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Portfolio value</dt>
            <dd>{money(snapshot.total)}</dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>
              {snapshot.cash === null ? "Unavailable" : money(snapshot.cash)}
            </dd>
          </div>
          <div>
            <dt>Positions</dt>
            <dd>{snapshot.holdings.length}</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>
              {snapshot.history.length
                ? `${snapshot.history.length} observations`
                : "Unavailable"}
            </dd>
          </div>
        </dl>
        <dl className={styles.facts}>
          <div>
            <dt>Time horizon</dt>
            <dd>{label(snapshot.profile.horizon)}</dd>
          </div>
          <div>
            <dt>Risk preference</dt>
            <dd>{label(snapshot.profile.risk)}</dd>
          </div>
          <div>
            <dt>During a drawdown</dt>
            <dd>{label(snapshot.profile.drawdown)}</dd>
          </div>
          <div>
            <dt>Volatility preference</dt>
            <dd>{label(snapshot.profile.volatility)}</dd>
          </div>
        </dl>
        <p className="ui-text-helper-text">
          {snapshot.period || "Current saved source"} · Fixed snapshot. Missing
          information stays unavailable.
        </p>
      </section>
      <details className={styles.card}>
        <summary>All holdings · {snapshot.holdings.length}</summary>
        <div className={styles.scroll}>
          {snapshot.holdings.slice(0, visible).map((h, index) => (
            <div className={styles.holding} key={`${h.symbol}:${index}`}>
              <div>
                <strong>{h.name}</strong>
                <span>
                  {h.symbol || h.assetType || "Position"}
                  {h.quantity === null ? "" : ` · ${h.quantity} units`}
                </span>
              </div>
              <strong>{money(h.value)}</strong>
            </div>
          ))}
        </div>
        {visible < snapshot.holdings.length ? (
          <button
            type="button"
            className="min-h-11 ui-text-button-label"
            onClick={() => setVisible((n) => n + 50)}
          >
            Show more holdings ({Math.min(visible, snapshot.holdings.length)} of{" "}
            {snapshot.holdings.length})
          </button>
        ) : null}
      </details>
      <details className={styles.card}>
        <summary>Allocation and history</summary>
        <dl className={styles.facts}>
          {snapshot.allocation.map((a) => (
            <div key={a.name}>
              <dt>{a.name}</dt>
              <dd>{money(a.value)}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.scroll}>
          {snapshot.history.length ? (
            snapshot.history.map((h, index) => (
              <div className={styles.row} key={`${h.date}:${index}`}>
                <span>{h.date}</span>
                <span>{money(h.value)}</span>
              </div>
            ))
          ) : (
            <p>No dated history in this source.</p>
          )}
        </div>
      </details>
    </div>
  );
}
