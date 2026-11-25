import styles from "@/components/kai/shared/finance-workspace.module.css";

export function PortfolioDeclineChart({ drop, compact = false }: { drop: number; compact?: boolean }) {
  const fraction = drop / 30;
  return (
    <div aria-hidden="true" className={compact ? styles.scenarioCompact : undefined}>
      <svg viewBox={compact ? "-12 -10 324 58" : "0 0 300 38"} preserveAspectRatio="none" className={styles.scenarioChart}>
        {!compact ? (
          <>
            <path d="M2 2H298 M2 19H298 M2 36H298" className={styles.scenarioGrid} />
            <path d="M2 2L298 36H2Z" className={styles.scenarioFill} />
          </>
        ) : null}
        <path d="M2 2L298 36" className={styles.scenarioLine} />
        <circle cx={2 + 296 * fraction} cy={2 + 34 * fraction} r={compact ? 3.5 : 2} className={styles.scenarioPoint} />
      </svg>
      <div className={styles.scenarioAxis}><span>0% drop</span><span>30% drop</span></div>
    </div>
  );
}
