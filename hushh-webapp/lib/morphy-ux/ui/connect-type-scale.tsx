"use client";

import type { ReactNode } from "react";
import { TypographyScopeProvider } from "./typography-scope";
import styles from "./connect-type-scale.module.css";

/** The same scale owns the workspace and every nested portal. */
export function ConnectTypeScale({ children }: { children: ReactNode }) {
  return <TypographyScopeProvider className={styles.surface}>
    <div className={`${styles.surface} ${styles.root}`} data-connect-type-scale="page" data-typography-scope={styles.surface}>{children}</div>
  </TypographyScopeProvider>;
}
