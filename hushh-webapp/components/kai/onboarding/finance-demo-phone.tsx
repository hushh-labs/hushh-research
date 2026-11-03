import type { CSSProperties } from "react";
import styles from "./finance-demo-phone.module.css";

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });
const paths = [
  "M0 14 C8 14 10 9 18 10 S30 11 38 7 S52 3 64 2",
  "M0 3 C8 3 10 8 18 7 S30 5 38 10 S52 13 64 15",
  "M0 12 C7 7 12 14 20 9 S32 5 40 8 S56 3 64 2",
  "M0 4 C7 9 12 3 20 8 S32 11 40 9 S56 14 64 15",
];
const agents = [
  { name: "Fundamental", icon: "M6 20V11M12 20V4M18 20v-6" },
  {
    name: "Sentiment",
    icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  },
  {
    name: "Valuation",
    icon: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  },
];

/** Illustrative, local-only choreography. Never renders account values or calls an agent. */
export function FinanceDemoPhone({
  slide,
  previous,
  labels,
}: {
  slide: number;
  previous: number;
  labels: string[];
}) {
  return (
    <div className={styles.phone} aria-hidden="true" data-demo-slide={slide}>
      <div className={styles.phoneScreen}>
        <div className={styles.island} />
        <div className={styles.phoneTabs}>
          <i style={{ transform: `translateX(${slide * 100}%)` }} />
          {labels.map((label, index) => (
            <span key={label} data-active={index === slide}>
              {label}
            </span>
          ))}
        </div>
        <div className={styles.viewport}>
          {[0, 1, 2].map((index) => {
            const position = (index - slide + 3) % 3;
            return (
              <div
                key={index}
                className={styles.scene}
                data-scene={index}
                data-active={slide === index}
                data-transition={index === slide || index === previous}
                style={{
                  transform: `translateX(${position === 0 ? 0 : position === 1 ? 200 : -200}px)`,
                }}
              >
                {index === 0 ? (
                  <div className={styles.marketScroll}>
                    <div className={styles.marketTiles}>
                      {paths.map((d, i) => (
                        <div
                          key={d}
                          className={styles.enter}
                          style={delay(300 + i * 150)}
                        >
                          <i />
                          <b />
                          <i
                            className={styles.change}
                            data-down={i % 2 === 1}
                          />
                          <svg viewBox="0 0 64 18" fill="none">
                            <path
                              pathLength="1"
                              d={d}
                              data-down={i % 2 === 1}
                              className={styles.draw}
                              style={delay(550 + i * 150)}
                            />
                          </svg>
                        </div>
                      ))}
                    </div>
                    <div className={styles.newsCard}>
                      {[0, 1, 2].map((i) => (
                        <div
                          className={`${styles.newsRow} ${styles.enter}`}
                          key={i}
                          style={delay(1300 + i * 180)}
                        >
                          <div>
                            <b />
                            <i />
                            <i />
                          </div>
                          <span data-tone={i} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : index === 1 ? (
                  <div className={styles.portfolio}>
                    <div
                      className={`${styles.card} ${styles.enter}`}
                      style={delay(250)}
                    >
                      <i />
                      <b className={styles.valueLine} />
                      <div className={styles.facts}>
                        {[0, 1].map((i) => (
                          <div key={i}>
                            <i />
                            <b />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div
                      className={`${styles.card} ${styles.ringCard} ${styles.enter}`}
                      style={delay(550)}
                    >
                      <div className={styles.ring}>
                        <svg viewBox="0 0 66 66">
                          <circle cx="33" cy="33" r="27" />
                          <circle
                            cx="33"
                            cy="33"
                            r="27"
                            pathLength="100"
                            className={styles.ringFill}
                            transform="rotate(-90 33 33)"
                          />
                        </svg>
                        <b />
                      </div>
                      <div>
                        <i />
                        <b />
                        <i />
                      </div>
                    </div>
                    <div
                      className={`${styles.card} ${styles.enter}`}
                      style={delay(900)}
                    >
                      <b />
                      <div className={styles.allocation}>
                        <div className={styles.allocationFill}>
                          {[52, 26, 22].map((width, i) => (
                            <span
                              key={i}
                              data-tone={i}
                              style={{ width: `${width}%` }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className={styles.legend}>
                        {[0, 1, 2].map((i) => (
                          <div key={i}>
                            <span data-tone={i} />
                            <i />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.stockList}>
                      <div className={styles.card}>
                        {paths.map((d, i) => (
                          <div
                            className={`${styles.stockRow} ${styles.enter}`}
                            key={d}
                            style={delay(250 + i * 130)}
                          >
                            <span data-tone={i % 3} />
                            <div>
                              <b />
                              <i />
                            </div>
                            <svg viewBox="0 0 64 18">
                              <path d={d} data-down={i % 2 === 1} />
                            </svg>
                          </div>
                        ))}
                      </div>
                      <div className={styles.listTap} />
                    </div>
                    <div className={styles.stockDetail}>
                      <div className={styles.stockHeader}>
                        <span>‹</span>
                        <span data-tone="2" />
                        <div>
                          <b />
                          <i />
                        </div>
                      </div>
                      <div className={styles.stockChart}>
                        <svg viewBox="0 0 160 48">
                          <path
                            className={styles.chartArea}
                            d="M0 38 C14 38 18 26 32 28 S52 36 66 24 S90 12 104 17 S130 7 160 4 L160 48 L0 48 Z"
                          />
                          <path
                            pathLength="1"
                            className={styles.chartDraw}
                            d="M0 38 C14 38 18 26 32 28 S52 36 66 24 S90 12 104 17 S130 7 160 4"
                          />
                        </svg>
                      </div>
                      <div className={styles.debateCta}>
                        <span className={styles.startLabel}>
                          ✦ Start debate
                        </span>
                        <span className={styles.roundOne}>Round 1</span>
                        <span className={styles.roundTwo}>Round 2</span>
                        <span className={styles.consensusLabel}>Consensus</span>
                      </div>
                      <div className={styles.debateTap} />
                      {agents.map((agent, i) => (
                        <div
                          className={`${styles.agentCard} ${styles.enter}`}
                          key={agent.name}
                          style={{ top: 66 + i * 62, ...delay(3900 + i * 400) }}
                        >
                          <span data-tone={i}>
                            <svg viewBox="0 0 24 24">
                              <path d={agent.icon} />
                            </svg>
                          </span>
                          <div>
                            <strong>{agent.name}</strong>
                            <i
                              className={styles.agentLine}
                              style={{ width: "92%", ...delay(4200 + i * 400) }}
                            />
                            <i
                              className={styles.agentLine}
                              style={{ width: "66%", ...delay(4600 + i * 400) }}
                            />
                            <i
                              className={styles.agentLine}
                              style={{ width: "42%", ...delay(7200 + i * 250) }}
                            />
                          </div>
                        </div>
                      ))}
                      <div
                        className={`${styles.decision} ${styles.enter}`}
                        style={delay(8800)}
                      >
                        <strong>
                          <span aria-hidden="true">✓</span> Decision
                        </strong>
                        <div>
                          <span className={styles.decisionFill} />
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
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
