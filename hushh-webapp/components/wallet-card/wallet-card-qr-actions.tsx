import type { ReactNode } from "react";
import styles from "./wallet-card-qr-actions.module.css";

/** Shared left-QR/right-actions layout for the three built-in cards. */
export function WalletCardQrActions({ qr, children }: { qr: ReactNode; children: ReactNode }) {
  return <div className={styles.layout} data-testid="wallet-qr-actions">
    <div className={styles.qr}>{qr}</div>
    <div className={styles.actions}>{children}</div>
  </div>;
}
