import { Skeleton } from "@/components/ui/skeleton";
import styles from "./wallet-card-browser.module.css";

/** Presentation only: no guessed card details or cached access authority. */
export function WalletCollectionSkeleton({ owned = false }: { owned?: boolean }) {
  return <div role="status" aria-label={owned ? "Opening your wallet" : "Loading shared cards"} data-testid="wallet-collection-skeleton">
    <span className="sr-only">{owned ? "Opening your wallet…" : "Loading shared cards…"}</span>
    {owned ? <Skeleton className="mb-4 h-11 w-full max-w-[360px] rounded-full" /> : null}
    <div className={`${styles.cardGrid} ${styles.skeletonGrid}`} aria-hidden="true">
      {[0, 1, 2].map(index => <div key={index}>
        <Skeleton className="aspect-[85.6/53.98] w-full rounded-2xl" />
        <Skeleton className="mt-4 h-5 w-28" /><Skeleton className="mt-2 h-4 w-40" />
      </div>)}
    </div>
    {owned ? <section className={styles.oneCards} aria-hidden="true">
      <div className={styles.sectionHeading}><h3>Your One cards</h3><span>Identity &amp; membership</span></div>
      <div className={styles.oneCardGrid}>{[0, 1, 2].map(index => <div key={index} className={styles.oneCardOpen}>
        <span className={styles.oneCardArt}><Skeleton className="aspect-[85.6/53.98] w-full rounded-xl" /></span>
        <span className={styles.oneCardCaption}><span className="min-w-0"><Skeleton className="h-5 w-20 max-w-full" /><Skeleton className="mt-2 h-4 w-28 max-w-full" /></span></span>
      </div>)}</div>
    </section> : null}
  </div>;
}
