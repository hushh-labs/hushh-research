import { useId } from "react";

import { Brain, CheckCircle, Coins, Flame, LinkIcon, MessageCircle, Users, Zap } from "@/components/icons";

import type { ReferralPolicy } from "@/lib/services/referral-service";

import styles from "./referral-journey.module.css";

// Informational awards supplied for this design. Balances remain server-owned.
const POINT_AWARDS = { pkmMaster: 15, connectionBuilder: 5, agentUsage: 10 } as const;
const JOURNEY_PATH = "M 150 70 C 225 70 225 104 300 104 S 375 70 450 70 S 525 104 600 104 S 675 70 750 70";

type ReferralJourneyProps = { policy: ReferralPolicy };

export function ReferralJourney({ policy }: ReferralJourneyProps) {
  const earningHeadingId = useId();

  return (
    <section className={styles.frame} aria-label="Referral steps and rewards">
      <div className={styles.journey}>
        <div className={styles.map}>
          <svg className={styles.road} viewBox="0 0 900 180" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
            <path className={styles.roadSurface} d={JOURNEY_PATH} />
          </svg>
          <ol className={styles.steps}>
            <li className={styles.invite}>
              <span className={styles.marker} aria-hidden="true">
                <LinkIcon weight="bold" />
                <span className={styles.markerNumber}>01</span>
              </span>
              <div className={styles.stepCopy}>
                <h3>Invite a friend</h3>
              </div>
            </li>
            <li className={styles.setup}>
              <span className={styles.marker} aria-hidden="true">
                <CheckCircle weight="duotone" />
                <span className={styles.markerNumber}>02</span>
              </span>
              <div className={styles.stepCopy}>
                <h3>They finish setup</h3>
              </div>
            </li>
            <li className={styles.qualify}>
              <span className={styles.marker} aria-hidden="true">
                <Coins weight="fill" />
                <span className={styles.markerNumber}>03</span>
              </span>
              <div className={styles.stepCopy}>
                <h3>Earn <span className={styles.reward}>{policy.points.qualified_referral_points} coins</span></h3>
              </div>
            </li>
          </ol>
        </div>

        <section className={styles.earning} aria-labelledby={earningHeadingId}>
          <header className={styles.earningHeader}>
            <div>
              <h3 id={earningHeadingId}>More ways to earn</h3>
            </div>
          </header>
          <div className={styles.rewardList}>
            {[
              { id: "streak", title: "Keep your streak", description: `1 qualifying referral daily for ${policy.streak_rules.run_length_days} days`, amount: policy.streak_rules.bonus_points, unit: "coins", icon: Flame },
              { id: "flash", title: "Flash boost", description: `Replaces ${policy.points.qualified_referral_points} coins when active`, amount: policy.points.flash_window_total_points, unit: "coins", icon: Zap },
              { id: "pkm", title: "PKM Master", description: "Use memory daily", amount: POINT_AWARDS.pkmMaster, unit: "points", icon: Brain },
              { id: "connections", title: "Connection Builder", description: "Each new connection", amount: POINT_AWARDS.connectionBuilder, unit: "points", icon: Users },
              { id: "agents", title: "Agent usage", description: "Every use, any agent", amount: POINT_AWARDS.agentUsage, unit: "points", icon: MessageCircle },
            ].map(({ id, title, description, amount, unit, icon: Icon }) => (
              <article key={id} className={styles.rewardRow} data-earning={id}>
                <span className={styles.earningIcon} aria-hidden="true"><Icon /></span>
                <div className={styles.earningCopy}>
                  <h4>{title}</h4>
                  <p>{description}</p>
                </div>
                <div className={styles.pointAward}>
                  <p className={styles.pointAmount}><strong>{id === "flash" ? "" : "+"}{amount}</strong>{" "}<span>{unit}</span></p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
