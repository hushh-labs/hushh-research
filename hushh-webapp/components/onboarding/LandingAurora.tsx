import styles from "./LandingAurora.module.css";

/**
 * The welcome screen's backdrop. Purely decorative, non-interactive, and a
 * server component — it ships no JavaScript at all, which is the point: the
 * signed-out welcome is the slowest-to-hydrate screen in the app and this is
 * the largest thing on it.
 *
 * Scoped to the welcome route on purpose. `OnboardingHeroBackground` still
 * owns the quieter canvas behind sign-in and phone registration, where a
 * moving backdrop would compete with a form.
 */
export function LandingAurora() {
  return (
    <div aria-hidden className={styles.root}>
      <span className={`${styles.blob} ${styles.blobOne}`} />
      <span className={`${styles.blob} ${styles.blobTwo}`} />
      <span className={`${styles.blob} ${styles.blobThree}`} />
      <span className={styles.vignette} />
      <span className={styles.grain} />
    </div>
  );
}
