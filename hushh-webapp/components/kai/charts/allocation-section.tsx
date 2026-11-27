import type { ReactNode } from "react";
import { ChartSurfaceCard } from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";
import styles from "@/components/kai/shared/finance-workspace.module.css";

export function AllocationSection({ title, description, embedded, className, children }: {
  title: string;
  description?: string;
  embedded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (!embedded) return <ChartSurfaceCard title={title} description={description} className={className} headerClassName={styles.allocationHeader} contentClassName="space-y-3">{children}</ChartSurfaceCard>;
  return <section className={cn(styles.allocationSection, className)} aria-label={title}>
    <header className={styles.allocationHeader}>
      <h2>{title}</h2>
      {description ? <p className={styles.allocationMeta}>{description}</p> : null}
    </header>
    {children}
  </section>;
}
