import { useId } from "react";

import { Brain, CheckCircle, Coins, Flame, LinkIcon, MessageCircle, Users, Zap } from "@/components/icons";

import type { ReferralPolicy } from "@/lib/services/referral-service";

import styles from "./referral-journey.module.css";

// Informational awards supplied for this design. Balances remain server-owned.

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
                <CheckCircle weight="regular" />
                <span className={styles.markerNumber}>02</span>
              </span>
              <div className={styles.stepCopy}>
                <h3>They finish setup and use Agent One</h3>
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

        <section aria-label="Circle Wars rules" className={styles.earning}>
          <h3>Win with your circle</h3>
          <p>Choose an existing Circle or create one, then explicitly join Circle Wars for the current week. Each member joins separately and chooses one Circle per week.</p>
          <p>Each new referral started after you join adds one team referral when it qualifies. Individual coins and lifetime rewards keep working independently. The weekly deadline follows the program timezone shown in Circle Wars.</p>
        </section>
        <section className={styles.earning} aria-labelledby={earningHeadingId}>
          <header className={styles.earningHeader}>
            <div>
              <h3 id={earningHeadingId}>More ways to earn</h3>
            </div>
          </header>
          <div className={styles.rewardList}>
            {[
              { id: "streak", title: "Keep your streak", description: `View your referral dashboard on ${policy.streak_rules.run_length_days} consecutive days`, amount: policy.streak_rules.bonus_points, unit: "coins", icon: Flame },
              { id: "flash", title: "Flash boost", description: `Replaces ${policy.points.qualified_referral_points} coins when active`, amount: policy.points.flash_window_total_points, unit: "coins", icon: Zap },
              { id: "referral", title: "Referral activity", description: `Join: ${policy.points.referral_in_progress_points ?? 0} coins; qualified: ${policy.points.referral_qualified_activity_total_points ?? 0} total activity coins`, amount: policy.points.referral_qualified_activity_total_points ?? 0, unit: "coins", icon: Users },
              { id: "pkm", title: "Memory updates", description: "Save memory once per day", amount: policy.points.pkm_daily_points ?? 0, unit: "coins", icon: Brain },
              { id: "connections", title: "Connection Builder", description: "Each new connection", amount: policy.points.connection_created_points ?? 0, unit: "coins", icon: Users },
              { id: "agents", title: "Agent usage", description: "Each completed Agent One reply", amount: policy.points.agent_usage_points ?? 0, unit: "coins", icon: MessageCircle },
            ].filter(({ amount, id }) => amount > 0 && (id !== "flash" || policy.flash_bonus_enabled !== false)).map(({ id, title, description, amount, unit, icon: Icon }) => (
              <article key={id} className={styles.rewardRow} data-earning={id}>
                <span className={styles.earningIcon} aria-hidden="true"><Icon weight="regular" /></span>
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
