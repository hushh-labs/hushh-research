import styles from "./finance-onboarding.module.css";
export function FinanceDemoPhone({
  slide,
  labels,
}: {
  slide: number;
  labels: string[];
}) {
  return (
    <div className={styles.phone} aria-hidden="true" data-demo-slide={slide}>
      <div className={styles.phoneScreen}>
        <div className={styles.island} />
        <div className={styles.phoneTabs}>
          {labels.map((label, index) => (
            <span key={label} data-active={index === slide}>
              {label}
            </span>
          ))}
        </div>
        <div className={styles.phoneContent} key={slide}>
          {slide === 0 ? (
            <>
              <div className={styles.marketTiles}>
                {[0, 1, 2, 3].map((index) => (
                  <div key={index}>
                    <i />
                    <b />
                    <i className={styles.shortLine} />
                    <svg viewBox="0 0 72 30" fill="none">
                      <path
                        stroke={
                          index % 2
                            ? "var(--app-destructive-deep, #d3302b)"
                            : "var(--app-success-deep, #1e7b34)"
                        }
                        strokeWidth="2"
                        d={
                          index % 2
                            ? "M2 5C14 3 19 14 29 12S48 25 70 25"
                            : "M2 25C14 25 19 14 29 16S48 5 70 5"
                        }
                      />
                    </svg>
                  </div>
                ))}
              </div>
              <div className={styles.miniCard}>
                {[0, 1, 2].map((item) => (
                  <div className={styles.newsRow} key={item}>
                    <div>
                      <b />
                      <i />
                      <i />
                    </div>
                    <span />
                  </div>
                ))}
              </div>
            </>
          ) : slide === 1 ? (
            <>
              <div className={styles.miniCard}>
                <i />
                <b className={styles.valueLine} />
                <div className={styles.factLines}>
                  <i />
                  <i />
                </div>
              </div>
              <div className={`${styles.miniCard} ${styles.ringCard}`}>
                <svg viewBox="0 0 64 64">
                  <circle
                    cx="32"
                    cy="32"
                    r="24"
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="7"
                  />
                  <circle
                    cx="32"
                    cy="32"
                    r="24"
                    fill="none"
                    stroke="var(--app-accent)"
                    strokeWidth="7"
                    strokeDasharray="105 151"
                    transform="rotate(-90 32 32)"
                  />
                </svg>
                <div>
                  <b />
                  <i />
                  <i />
                </div>
              </div>
              <div className={styles.miniCard}>
                <b />
                <div className={styles.allocation}>
                  <span />
                  <span />
                  <span />
                </div>
                {[0, 1, 2].map((item) => (
                  <div key={item} className={styles.allocationRow}>
                    <span />
                    <i />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={styles.miniCard}>
                <div className={styles.stockLine}>
                  <span />
                  <div>
                    <b />
                    <i />
                  </div>
                </div>
                <svg
                  className={styles.stockChart}
                  viewBox="0 0 170 54"
                  fill="none"
                >
                  <path
                    d="M0 45L20 35 38 39 62 19 84 28 109 10 132 17 170 2"
                    stroke="var(--app-accent)"
                    strokeWidth="2.5"
                  />
                </svg>
              </div>
              {["Fundamental", "Sentiment", "Valuation"].map((label, index) => (
                <div
                  key={label}
                  className={`${styles.miniCard} ${styles.agentCard}`}
                >
                  <span>{index + 1}</span>
                  <div>
                    <strong>{label}</strong>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
              <div className={styles.miniCard}>
                <strong>Consensus</strong>
                <div className={styles.allocation}>
                  <span />
                </div>
              </div>
            </>
          )}
        </div>
        <div className={styles.phoneDock}>
          <span />
          <span data-active />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
