import type { ReactNode } from "react";

import { User, UsersThreeIcon as Users } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import styles from "./referral-rankings.module.css";

export function ReferralRankingList({ label, children }: {
  label: string;
  children: ReactNode;
}) {
  return <div className={styles.table}>
    <ol aria-label={label} className={styles.rows}>{children}</ol>
  </div>;
}

export function ReferralRankingRow({ rank, name, photoUrl, score, scoreLabel, isViewer, kind = "individual", description }: {
  rank: number;
  name: string;
  photoUrl?: string | null;
  score: number;
  scoreLabel: "coins" | "referrals";
  isViewer: boolean;
  kind?: "individual" | "circle";
  description?: string;
}) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const anonymous = name === "Anonymous referrer";

  return <li className={styles.row} data-viewer={isViewer || undefined}>
    <span className={styles.rank} data-podium={rank <= 3 ? rank : undefined}>
      <span className="sr-only">Rank {rank}</span><span aria-hidden="true">{rank}</span>
    </span>
    <div className={styles.member}>
      <Avatar className={styles.avatar} aria-hidden="true">
        {kind === "individual" && photoUrl ? <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" /> : null}
        <AvatarFallback className={styles.fallback}>{kind === "circle" ? <Users weight="duotone" /> : anonymous || !initials ? <User /> : initials}</AvatarFallback>
      </Avatar>
      <div className={styles.identity}>
        <div className={styles.nameLine}><span className={`ui-text-row-label-compact ${styles.name}`}>{name}</span>
          {isViewer ? <span className={styles.viewerBadge}>{kind === "circle" ? "Your circle" : "You"}</span> : null}
        </div>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
    </div>
    <div className={styles.score}><strong>{score.toLocaleString("en-IN")}</strong><span className="sr-only">{scoreLabel}</span></div>
  </li>;
}
